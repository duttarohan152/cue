# cue — Project Context for AI Agents

> Onboarding document for AI coding agents. Read this before making changes.
> Last verified against the codebase: 2026-09-25.

---

## 1. What this project is

**cue** is an open-source, cross-platform **Electron desktop overlay** — a frameless, transparent, always-on-top glass panel that floats above every other window. It takes **three independent inputs** (screen, microphone, system/meeting audio) and feeds them to an LLM to help the user in real time during interviews, meetings, and coding sessions.

- **License:** GPL-3.0-or-later
- **Upstream:** `https://github.com/Blueturboguy07/cue`
- **Bring-your-own-key:** no backend, no telemetry. All keys and data live in a local JSON file.
- **Designed to be hidden from screen shares** (best-effort — see §9).

**Positioning:** a free, self-hosted alternative to Cluely.

---

## 2. Quick start

```bash
npm install        # runs postinstall: scripts/rename-electron.js (Windows-only effect)
npm start          # launch the Electron app
npm test           # node --test test/*.test.js  (35 tests, no Electron required)
```

Build:

```bash
npm run pack       # electron-builder --dir (unpacked)
npm run dist:mac   # mac zip (arm64)
npm run dist:win   # win zip
```

**Requires Node 22.12+.** Electron is pinned at `33.2.1`.

Useful env vars:
- `CUE_NO_PROTECT=1` — disables `setContentProtection`, so the window shows in screen recordings. **Essential for demoing/debugging the UI.**
- `MAC_SIGN=1` + `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` — enable macOS signing + notarization.

---

## 3. Architecture

Three-process Electron model with strict context isolation (`contextIsolation: true`, `nodeIntegration: false`).

```
┌─────────────────────── MAIN (main.js) ───────────────────────┐
│ window mgmt · global shortcuts · IPC · transcript state      │
│ STT orchestration · LLM streaming · screenshots · app-link   │
└───────────────▲──────────────────────────┬───────────────────┘
                │ ipcRenderer (allow-listed)│ webContents.send
┌───────────────┴──────────────────────────▼───────────────────┐
│                     PRELOAD (preload.js)                     │
│         contextBridge → window.cue (the ONLY bridge)         │
└───────────────▲──────────────────────────┬───────────────────┘
┌───────────────┴──────────────────────────▼───────────────────┐
│              RENDERER (renderer/renderer.js)                 │
│ UI state · mic capture · system-audio loopback · markdown    │
└──────────────────────────────────────────────────────────────┘
```

**Critical boundary rule:** *audio is captured in the renderer, not the main process.* Both `getUserMedia` (mic) and `getDisplayMedia` (system loopback) run inside cue's own renderer so they use cue's own Screen-Recording grant — no separate helper binary to authorize. PCM is shipped to main via `mic:pcm` / `system:pcm`.

### File map

**Root**
| File | Purpose |
|---|---|
| `main.js` | Main process. Window, IPC, shortcuts, audio routing, STT/LLM orchestration, `runFeature`. |
| `preload.js` | `contextBridge` exposing `window.cue`. Has an **allow-list** for inbound channels — add new channels here or they're silently dropped. |
| `electron-builder.cjs` | Packaging config (mac zip/arm64, win nsis/x64), signing, notarization. |
| `verify.js` | Standalone sanity checker. |

**`src/` — main-process logic (all pure-Node except `store.js`/`screen.js`, which need Electron)**
| File | Purpose |
|---|---|
| `llm.js` | Provider factory: OpenAI, Anthropic, Gemini, **Amazon Bedrock**. One streaming interface. |
| `prompts.js` | `MODES` (assist/say/followup/recap/ask/leetcode), `BASE_RULES`, `CODING_GUIDANCE`, `codeLanguageDirective`. |
| `store.js` | JSON settings persisted to `app.getPath('userData')/cue-data.json`. Deep-merged over `DEFAULTS`. |
| `stt.js` | **Batch** STT — OpenAI Whisper → Gemini fallback chain, 30 s backoff on 429. |
| `stt-streaming.js` | **Streaming** STT — Deepgram Nova + OpenAI Realtime over WebSocket. |
| `screen.js` | Screenshot capture + size-aware PNG→JPEG compression. |
| `vad.js` | `AdaptiveVAD` (energy + hysteresis + adaptive noise floor) and `AudioRingBuffer` (300 ms pre-speech). |
| `wav.js` | `pcmToWav`, `rms16` (silence gate). |
| `interview-context.js` | Question-category detection + resume/JD parsing → per-category prompt context block. |
| `applink.js` / `applink-state.js` | Local diagnostics port with consent. `applink-state.js` decides what leaves the process. |
| `profile-context.js` / `resume-context.js` | Resume context helper + legacy-signature shim. |

**`renderer/`**
| File | Purpose |
|---|---|
| `index.html` | Toolbar, panel, action row, composer, settings tabs, onboarding, consent sheet. |
| `renderer.js` | All UI logic, audio capture, markdown streaming, click-through handling. |
| `styles.css` | Glassmorphism design tokens + layout. |
| `icons.js` | Inlined Lucide paths + cue logo. `icon(name, {size})`. |
| `audio-worklet-processor.js` / `pcm-processor.js` | Float32 → Int16 PCM conversion off the main thread. |

**`vendor/app-link/`** — vendored SDK from the `publik` repo. **Do not edit** (see `VENDORED.md`); patch upstream instead.

---

## 4. The core flow: `runFeature(mode, userText)`

Everything the user triggers funnels through this one function in `main.js`.

1. Bail if `state.busy` (prevents overlapping LLM calls; **listening is not affected**).
2. Look up `def = MODES[mode]`; build `llm = createLLM(settings)`.
3. Emit `llm:start` (with `userBubble`, `small`, detected `category`).
4. If `!llm.ready` → emit `llm:error` telling the user to add a key.
5. If `def.needsScreen` → `captureScreenshot()` → data URL.
6. `buildInterviewContext(settings, mode, transcript)` → personal context block.
7. `system = def.buildSystem(contextBlock)`; if `def.code`, append `codeLanguageDirective(...)` **and** `CODING_GUIDANCE`.
8. `built = def.build({ transcript, userText })` → the user message.
9. Compute `maxTokens` (see §5) and `llm.stream({ turns: [...historyTurns(def), currentUserTurn] })`, emitting `llm:token` per chunk.
10. `rememberAnswer(...)` stores the returned text in `answerHistory`.
10. `llm:done`, or `llm:error`; `state.busy = false` in `finally`.

**Answering is always user-initiated.** There is no VAD/silence trigger that decides to respond — listening runs continuously and the user picks the moment via hotkey, button, or typed question.

**Input budget.** A worst-case Assist call is ~16k tokens against a 1M window (1.6%): screenshot 4,760, answer history up to 8,000, system+profile ~2,300, transcript ~5,600. The **screenshot is the largest single component** — text is cheap here, so trimming transcript or profile context buys almost nothing. `MAX_TRANSCRIPT_TURNS = 1000` is a storage cap; turns past it are dropped permanently.

**Session memory.** `answerHistory` in `main.js` keeps cue's own last 3 answers (15-minute window, 8k chars each) and replays them as real `user`/`assistant` pairs ahead of the live turn, so a follow-up lands on the solution cue actually gave instead of one re-derived from the screen. The stand-in `user` turn is a short label, **not** the original message — that one embedded the transcript as it stood then. Bounded deliberately: a stale answer from the previous problem silently steers a fresh question. Cleared along with the transcript by `⌘⇧K`. Every mode contributes; only `skipHistory` modes read it back.

---

## 5. LLM layer (`src/llm.js`)

Four providers behind `stream({ system, turns, imageDataUrl, maxTokens, onToken })`:

| Provider | SDK | Credentials |
|---|---|---|
| `openai` | `openai` | `apiKeys.openai` |
| `anthropic` | `@anthropic-ai/sdk` | `apiKeys.anthropic` |
| `gemini` | `@google/genai` | `apiKeys.gemini` |
| `bedrock` | `@anthropic-ai/bedrock-sdk` | `settings.bedrock` — **AWS key + secret + region** (not `apiKeys`) |

**Bedrock shares the Anthropic code path.** `streamAnthropicClient()` is used by both; only client construction differs (`AnthropicBedrock({ awsAccessKey, awsSecretKey, awsRegion, awsSessionToken })`). `ready` is gated on access key + secret + region instead of a single token.

**Token budget — two layers:**
- `llm.js` baseline: `settings.smart ? 2800 : 1400`.
- `main.js` overrides per mode: **code modes** `smart ? 64000 : 32000`, **conversational** `smart ? 32000 : 16000`.
- Then **clamped** by `PROVIDER_MAX_OUTPUT = { openai: 16384, anthropic: 8192, gemini: 8192, bedrock: 128000 }`.

Effective limit = `min(requested, provider max)`. This is an **output** cap only; input is bounded by each model's context window.

> ⚠️ **Claude 5 thinking shares this budget.** Opus 5 and Sonnet 5 have adaptive thinking **on by default**, and `max_tokens` caps thinking *and* answer text combined. This is why the budgets above are far larger than any answer needs: `max_tokens` is a ceiling, not a target, and the old conversational figure (2800) could be spent entirely on reasoning before a single visible word — surfacing as a truncated reply with `stop_reason: max_tokens`, not an error.
>
> The speed lever is `output_config.effort` (`low`|`medium`|`high`|`xhigh`|`max`, default `high`), supported on Bedrock, which must sit at the **top level** — putting it inside `thinking` returns a `ValidationException`. cue deliberately leaves it at the default. Fast mode (`speed: "fast"`) is **Claude API only** and unavailable on Bedrock.
>
> **Prompt caching** is on for the Anthropic/Bedrock path: `buildAnthropicSystem()` wraps the system prompt in a `cache_control` breakpoint (`ttl: '1h'` on Bedrock, default 5m on the direct API, which needs a beta header for longer). Below the model minimum — 1024 tokens on Sonnet 5, 512 on Opus 5 — the request still succeeds, just uncached.

**Quirks:** Gemini `1.5-*` model IDs auto-upgrade to `gemini-2.0-flash`. Quota/429 errors are rewritten into a human-readable "switch provider or check billing" message.

---

## 6. Modes (`src/prompts.js`)

| Mode | Trigger | Screen | Transcript | Personal ctx | `code` |
|---|---|---|---|---|---|
| `assist` | `⌘↵` / **Assist** | ✅ | last 250 | ✅ | ✅ |
| `say` | `⌘⇧↵` / **What to say** | ❌ | last 250 | ✅ | ❌ |
| `ask` | type + `↵` | ✅ | last 250 | ✅ | ✅ |
| `leetcode` | `⌘H` / **Solve** | ✅ | last 250 | ❌ *(deliberately)* | ✅ |
| `followup` | *(no UI button)* | ❌ | last 300 | ✅ | ❌ |
| `recap` | *(no UI button)* | ❌ | full | ✅ | ❌ |

`followup` and `recap` still exist and work — their buttons were **removed from the action row** to save horizontal space. Re-adding a button is just an `<button class="act" data-mode="…">` in `index.html`.

**Shared prompt pieces**
- `BASE_RULES` — "Always respond in clear, natural English. Never switch to Hindi…".
- `CODING_GUIDANCE` — appended to `code` modes. Three parts, no headings: first-person thinking-out-loud as `- ` bullets one per line, then simple hand-written-looking code with no clever one-liners, then exactly two bullets `- **T(n) = O(…)**` / `- **S(n) = O(…)**`.
- `EXPLANATION_GUIDANCE` — the counterpart for technical answers that explain rather than code. Embedded in `assist` and `ask` (not appended by `main.js`, and deliberately not in `leetcode`). Crisp `- ` bullets, one per line, flat — **no sub-bullets**, because the renderer draws an indented bullet at the same level as a top-level one.
- Both blocks are scoped by wording — "When your response includes a code solution" vs "When your answer explains rather than solves" — so the two can coexist in one prompt without fighting.
- `codeLanguageDirective(codeLanguage)` — pins the solution language from the composer dropdown (`c` | `cpp`); `auto` (or any unknown value, e.g. a retired `python`/`bash` choice) tells the model to infer from the screenshot/conversation and fall back to **C++**.

**`interview-context.js`** detects a category from the **`them` channel only** (the interviewer's last 5 turns) across `behavioral | motivation | situational | experience | compensation | technical`, then injects only the relevant profile fields, with per-category resume budgets.

---

## 7. Speech-to-text

**STT is fully decoupled from the LLM provider** (Anthropic/Bedrock have no audio API). Transcription always uses Deepgram, OpenAI, or Gemini regardless of which LLM is selected.

**Streaming (preferred)** — `initStreamingSTT()` runs if a Deepgram *or* OpenAI key exists:
1. **Deepgram Nova** (`nova-3`, 16 kHz linear16, interim results, 3 s keep-alive) — lowest latency.
2. **OpenAI Realtime** (`wss://api.openai.com/v1/realtime?intent=transcription`, model `gpt-realtime-whisper`) — requires **24 kHz**, so PCM is resampled 16→24 kHz by linear interpolation.

Both reconnect up to 5× with exponential backoff. On fatal error the sockets close, `streamingMode = false`, and the **batch loop starts as fallback**.

**Batch (fallback)** — `flushChannel()` every `FLUSH_MS = 900`, gated by `MIN_BYTES` (~0.12 s) and `RMS_GATE = 180`. Chain: **OpenAI Whisper (`whisper-1`) → Gemini (`gemini-2.0-flash`)**. A 429/`RESOURCE_EXHAUSTED` sets a 30 s cooldown.

`sttDisabled` latches on 401/403/`model_not_found` to stop retry spam, and resets on `settings:set` and on re-enabling capture.

Audio always passes through VAD + a 300 ms ring buffer so the first word is never clipped.

---

## 8. Settings (`src/store.js`)

Persisted to `<userData>/cue-data.json`, deep-merged over `DEFAULTS` — so **adding a key to `DEFAULTS` automatically migrates existing users**.

```js
{
  provider: 'openai',              // openai | anthropic | gemini | bedrock
  smart: false,                    // fast vs smart model tier
  codeLanguage: 'cpp',             // auto | c | cpp
  apiKeys: { openai, anthropic, gemini, deepgram },
  bedrock: { accessKeyId, secretAccessKey, region: 'us-east-1', sessionToken },
  resumeText, jobDescription,                       // Profile tab
  starStories, whyCompany, whyLeaving, workStyle,   // Interview Prep tab
  salaryTarget, questionsToAsk,                     // Q&A tab
  windowX, windowY,
  models: {
    openai:    { fast: 'gpt-4o-mini',            smart: 'gpt-4o' },
    anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-sonnet-latest' },
    gemini:    { fast: 'gemini-2.0-flash',        smart: 'gemini-2.0-flash' },
    bedrock:   { fast: 'global.anthropic.claude-sonnet-5', smart: 'global.anthropic.claude-opus-5' }
  }
}
```

> The Bedrock model IDs above are **correct** — `global.anthropic.claude-opus-5` and `global.anthropic.claude-sonnet-5` are Global cross-region inference profile IDs, confirmed against the AWS model card. Claude 5 IDs carry no version/date suffix, unlike the older `us.anthropic.claude-3-5-sonnet-20241022-v2:0` format. Bedrock still requires **model access to be explicitly enabled** per account/region.

---

## 9. Stealth & disguise mechanisms (non-obvious, intentional)

Several things look like bugs but are deliberate. **Do not "clean these up".**

| Mechanism | Where | Why |
|---|---|---|
| `win.setContentProtection(true)` | `main.js` | Excludes the window from screen capture. Windows needs build **19041+**; skipped silently below that, with a user-facing warning instead. |
| Window title **"Steam"** | `main.js` (`setTitle`) | Generic title so the window doesn't read as an assistant in window lists. |
| `productName: "Steam"` | `package.json`, `electron-builder.cjs` | Packaged app name. |
| `app.setName('MicrosoftEdgeUpdate')` + `setAppUserModelId('com.steam.overlay')` | `main.js` | Windows taskbar/Task Manager identity. |
| `scripts/rename-electron.js` (postinstall) | Windows | Renames `electron.exe` → `MicrosoftEdgeUpdate.exe` and patches PE version info so the taskbar doesn't say "Electron". |
| `scripts/apply-icon.js` | Windows | Copies the Edge icon resource onto the built exe. |
| `type: 'toolbar'` | `main.js` (Windows) | Sets `WS_EX_TOOLWINDOW` → removes from Alt+Tab **and** taskbar. |
| `app.dock.hide()` + `setHiddenInMissionControl(true)` + `LSUIElement` | macOS | Accessory app: no dock icon, hidden in Mission Control. |
| Custom tooltips instead of native `title` | `renderer.js` | Native OS tooltips render **outside** the protected window and would leak into screen shares. |
| Consent sheet drawn **in-window** | `applink.js` | Because the dock icon is hidden, a native `dialog` never comes frontmost and can't be clicked. This is the one place cue deliberately steals focus. |

`#app { pointer-events: none }` makes empty gaps click-through; `renderer.js` re-enables the mouse only when the pointer is over actual UI (`mouse:ignore` IPC).

---

## 10. UI structure

**Toolbar:** drag pill · logo (reopens onboarding) · Hide · Close · Stop/▢ (start-stop listening) · live dot · STT status.

**Action row** (`data-mode` drives `runMode`):
`What to say` (`say`) · `Assist` (`assist`) · `Solve` (`leetcode`) · `Transcript` (toggle) · `Clear`

> Only `.act[data-mode]` elements are wired to `runMode` — `Transcript`/`Clear` have no `data-mode` deliberately, because calling `runMode(undefined)` would latch `busy` forever.

**Composer:** auto-grow textarea · `Smart` pill · **language dropdown** (`#lang-dd`, a custom element — *not* a native `<select>`, so it can be styled and stays inside the protected window) · settings button · send.

**Settings tabs:** `🔑 Keys` · `📄 Profile` · `🎯 Interview Prep` · `💬 Q&A`.
On the Keys tab, the **API-keys group and the Bedrock group swap based on the selected provider**, while **Deepgram lives in its own always-visible "Transcription" section** — because STT is provider-independent and hiding it would strand Bedrock users with no way to enable listening.

**Shortcut hints are tooltip-only** (appended to each button's tip on boot, platform-aware) — they are not rendered as inline chips.

### Shortcuts

| Action | macOS | Windows | Scope |
|---|---|---|---|
| Assist | `⌘↵` | `Ctrl+↵` | global |
| What to say | `⌘⇧↵` | `Ctrl+Shift+↵` | global |
| Solve (leetcode) | `⌘H` | `Ctrl+H` | global |
| Clear transcript | `⌘⇧K` | `Ctrl+Shift+K` | global → `shortcut:clear` |
| Hide / collapse | `⌘\` | `Ctrl+\` | global → `shortcut:hide` |
| Toggle Smart/Fast | `⌘⇧M` | `Ctrl+Shift+M` | global → `shortcut:smart` |
| Cycle code language | `⌘⇧L` | `Ctrl+Shift+L` | global → `shortcut:lang` |
| Quit | `⌘⇧X` | `Ctrl+Shift+X` | global |
| Settings | `⌘,` | `Ctrl+,` | in-window |
| Send / Ask | `↵` | `↵` | in-window |
| Newline | `⇧↵` | `Shift+↵` | in-window |
| Close dialog | `Esc` | `Esc` | in-window |

`shortcutState` records whether each registration **succeeded** — `globalShortcut.register` returns `false` when another app already owns the combo, and the only symptom would otherwise be a dead key. This is surfaced over app-link.

---

## 11. App-link ("Assistant access")

A **local, consent-gated diagnostics port** so a companion agent can ask cue what it's doing, instead of guessing from a screenshot or a stale log.

- **Rule: counts, never content.** `describeState()` exposes capture/busy flags, `transcriptionDisabled`, **turn counts + last timestamp**, provider/model, `hasKey` booleans, and shortcut registration status. It never exposes transcript text, resume content, or API keys. This is enforced by tests.
- Two scopes: **read** (status) and **action** (currently `set_capturing`).
- Consent is asked in-window, remembered per caller, listed in Settings → *Assistant access*, and revocable via **Forget**.
- Caller names are presented as *claims* ("A program identifying itself as X") unless the peer's code signature was verified.

`applink-state.js` is deliberately separate from `applink.js` so it can be unit-tested without Electron — and because it's "the file where a privacy mistake would actually happen."

---

## 12. Screenshots (`src/screen.js`)

Sized by `fitToLimits()` against Claude's **high-resolution** tier (Claude 4.7 and later, so Sonnet 5 and Opus 5): `MAX_EDGE = 2576` px **and** `MAX_VISUAL_TOKENS = 4784`, where an image costs `ceil(w/28) * ceil(h/28)` visual tokens. Both limits bind, so the scale is found by binary search — a naive shrink loop stalls on the `ceil()` and settles well under budget. The earlier `1568` cap was the *standard* tier for older models and was discarding over half the detail these models accept, on screenshots of code they must read character by character. Tries **PNG first** (crisp for code/text); if the base64 payload exceeds `B64_TARGET = 4.5 MB`, falls back to **JPEG at quality 85 → 70 → 55 → 40**, then as a last resort downscales to 60 % width at quality 40. The 4.5 MB target keeps a safety margin under Anthropic/Bedrock's hard 5 MB image limit.

---

## 13. Testing

`npm test` → Node's built-in runner, **35 tests, no Electron needed**.

| File | Covers |
|---|---|
| `test/applink.test.js` | State redaction (privacy), consent copy, end-to-end wire protocol. |
| `test/prompts.test.js` | Every mode has `buildSystem`/`build`; prompt intent. |
| `test/resume-context.test.js` | `parseResume`, `detectCategory`, per-category context. |
| `test/profile-context.test.js` | Untrusted-data rules, 12 k char bound. |
| `test/wav.test.js` | WAV container, `rms16`. |

Anything requiring Electron (`store.js`, `screen.js`, window code) is **not** unit-tested — verify those with `npm start`.

Quick checks that catch most breakage:
```bash
node --check main.js preload.js            # syntax
npm test
```

---

## 14. Conventions & gotchas

- **Adding an IPC channel?** Register it in `main.js` *and* add it to the allow-list array in `preload.js` — otherwise `cue.on(...)` silently ignores it.
- **Adding a setting?** Add it to `DEFAULTS` in `store.js` (deep-merge handles migration), then fill it in `fillSettings()` and read it in `saveSettings()`.
- **Adding a mode?** Add to `MODES` with `needsScreen` / `small` / `code` / `userBubble` / `build` / `buildSystem`; set `code: true` to get the language directive, `CODING_GUIDANCE`, and the large token budget. Set `skipHistory: true` if the mode must not see cue's earlier answers (only `leetcode` does).
- **Don't edit `vendor/app-link/`** — it's vendored from `publik`.
- Comments in this repo explain *why*, not *what*. Match that style; keep them to a line where possible.
- The codebase deliberately **avoids native modules** so `npm install` stays clean (hence the JSON settings store instead of `electron-store`).
- `state.busy` guards only LLM calls. Never use it to gate audio capture.
- macOS Screen Recording + Microphone permissions must be granted to cue itself; the onboarding flow deep-links to the right panes.

---

## 15. Change history (this fork — author `duttarohan152`)

Chronological, oldest → newest.

| Commit | Summary |
|---|---|
| `47c7862` | **win install error** — fixed Windows install failure (`package.json`, `applink.js`). |
| `b80d128` | **bedrock support** — added `@anthropic-ai/bedrock-sdk`; `streamBedrock` sharing the Anthropic path; `bedrock` credential object + model defaults; provider button + credential fields. |
| `817ee57` | **separate bedrock from other providers** — Keys tab now swaps the API-key group and Bedrock group by provider; Deepgram split into its own always-visible Transcription section. |
| `8bfbcbf`, `13ce8ed` | gitignore + untrack `.vscode/`. |
| `91c8996` | **ui spacing of buttons** — shortened "What should I say?" → "What to say"; removed inline shortcut chips (moved to hover tooltips); hid `Follow-up`/`Recap`; added the **Solve** (`leetcode`) button + `code` icon; added `⌘⇧K` Clear shortcut; fixed the handler to target `.act[data-mode]` only. |
| `de74faa` | **coding language select** — `codeLanguage` setting (default `cpp`), `codeLanguageDirective()`, composer dropdown, injected into `code` modes. |
| `c62e464` | **hide hints and language selector** — replaced the native `<select>` with a custom dropdown and reworked tooltip/hint rendering (native tooltips leaked through content protection). |
| `165671d` | **long output token limit for coding** — per-mode `maxTokens` in `runFeature`. |
| `4643822` | **increase output token limit, better prompt** — `PROVIDER_MAX_OUTPUT` clamp, raised budgets (code 16k/8192, chat 2800/1400), added `CODING_GUIDANCE`. |
| `b9b11c7` | **close button** — toolbar close button + `app:quit` IPC. |
| `236b432`, `7954c97` | **app icon change / fix** — `build-resources/icon.ico` + builder wiring. |
| `6ba30a6` | **app name change** — `productName` → "Steam". |
| `613dffb` | **assist fine-tuned to tech interview** — `assist` re-pointed at TECHNICAL / CODING / EXPERIENCE / PROJECT routing. |
| `1073d61`, `0edb677` | **taskbar app name** — window title + `setAppUserModelId` fix. |
| `043a214` | **compress large sized screenshots** — `MAX_EDGE` 1568 + PNG→JPEG quality ladder under a 4.5 MB base64 target. |
| `1666a75` | **hide shortcut** — `⌘\` / `Ctrl+\` → `shortcut:hide`. |

**Net effect vs upstream:** a 4th LLM provider (Bedrock), a coding-language selector, much larger coding output budgets with per-provider clamping, a compact action row with a dedicated Solve button, screenshot compression, extra shortcuts (hide/clear), and stronger app-identity disguise.
