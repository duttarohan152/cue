const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const store = require('./src/store');
const { captureScreenshot, primeCapture } = require('./src/screen');
const { createSTT } = require('./src/stt');
const { createLLM } = require('./src/llm');
const { MODES, codeLanguageDirective, CODING_GUIDANCE } = require('./src/prompts');
const { rms16 } = require('./src/wav');
const { createStreamingSTT } = require('./src/stt-streaming');
const { AdaptiveVAD, AudioRingBuffer } = require('./src/vad');
const { buildInterviewContext, detectCategory } = require('./src/interview-context');
const { startAppLink, stopAppLink, recordEvent, appLinkConsentState, revokeAppLinkCaller } = require('./src/applink');

let win = null;
// Which global shortcuts cue actually holds. `globalShortcut.register` returns
// false when another application already owns the combination, and nothing used
// to look at that — so the only symptom was a key that did nothing. Iris reads
// this and can say which key is taken instead of guessing from a screenshot.
const shortcutState = { assist: false, say: false, leetcode: false, debug: false, clear: false, hide: false, quit: false, smart: false, lang: false };
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

// -------- Windows version helpers --------
// WDA_EXCLUDEFROMCAPTURE (setContentProtection) requires Windows 10 build 19041+.
// os.release() returns the NT kernel version e.g. "10.0.19041" or "10.0.22000" (Win11).
function getWindowsBuild() {
  if (!isWindows) return 0;
  const parts = os.release().split('.').map(Number);
  return parts[2] || 0; // third segment is the build number
}
const WIN_BUILD = getWindowsBuild();
const WIN_SUPPORTS_CONTENT_PROTECTION = !isWindows || WIN_BUILD >= 19041;

// -------- capture / transcript state --------
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } };
let sttDisabled = false; // set when the key can't reach any speech model (stops retry spam)
const buffers = { you: [], them: [] };
const transcript = []; // { channel, text, ts } — capped at MAX_TRANSCRIPT_TURNS
// A turn is one finalized STT utterance, not an exchange, so these accumulate
// at roughly 6-10 per minute of conversation — the old cap of 200 was silently
// dropping the start of any interview past ~20-30 minutes, including the
// problem statement a later question referred back to. 1000 turns is ~67 KB of
// strings and covers a long interview end to end.
const MAX_TRANSCRIPT_TURNS = 1000;

// cue's own recent answers, replayed as assistant turns so a follow-up lands on
// the solution it actually gave rather than one re-derived from whatever is on
// screen. Without this the model could contradict its own earlier reasoning —
// it had no idea it had said anything.
//
// Bounded twice over, because a stale answer is worse than none: an answer from
// the previous problem would quietly steer a fresh question. Three is enough to
// carry a solution plus a round of follow-ups.
const answerHistory = []; // { label, text, ts }
const ANSWER_HISTORY_MAX = 3;
const ANSWER_HISTORY_MS = 15 * 60 * 1000;
const ANSWER_CLIP = 8000; // chars — a full solution is well under this
const FLUSH_MS = 900;
const MIN_BYTES = Math.floor(16000 * 2 * 0.12); // ~0.12s
const RMS_GATE = 180;
let flushTimer = null;

// -------- streaming STT state --------
let streamingSTT = { you: null, them: null }; // streaming STT instances per channel
let streamingMode = false; // true when using WebSocket streaming STT
const vad = {
  you: new AdaptiveVAD({
    onsetThreshold: 220,
    offsetThreshold: 130,
    silenceFrames: 18,       // ~540ms silence before end
    onSpeechStart: () => send('vad:state', { channel: 'you', speaking: true }),
    onSpeechEnd: (dur) => send('vad:state', { channel: 'you', speaking: false, durationMs: dur })
  }),
  them: new AdaptiveVAD({
    onsetThreshold: 200,
    offsetThreshold: 120,
    silenceFrames: 20,       // ~600ms for remote audio (more forgiving)
    onSpeechStart: () => send('vad:state', { channel: 'them', speaking: true }),
    onSpeechEnd: (dur) => send('vad:state', { channel: 'them', speaking: false, durationMs: dur })
  })
};
// Pre-speech ring buffers (300ms) so we never clip the start of a word
const ringBuffers = {
  you: new AudioRingBuffer(300, 16000),
  them: new AudioRingBuffer(300, 16000)
};

function pushTranscript(turn) {
  transcript.push(turn);
  if (transcript.length > MAX_TRANSCRIPT_TURNS) transcript.splice(0, transcript.length - MAX_TRANSCRIPT_TURNS);
}

function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }

// Replayed as real user/assistant pairs rather than pasted into the prompt, so
// the model treats them as its own prior turns. The stand-in user turn is a
// short label, not the original message — that one embedded the whole
// transcript as it stood then, which is both huge and now out of date.
function historyTurns(def) {
  if (def.skipHistory) return [];
  const cutoff = Date.now() - ANSWER_HISTORY_MS;
  const turns = [];
  for (const a of answerHistory) {
    if (a.ts < cutoff) continue;
    turns.push({ role: 'user', text: a.label });
    turns.push({ role: 'assistant', text: a.text });
  }
  return turns;
}

function rememberAnswer(label, text) {
  if (!text || !text.trim()) return;
  answerHistory.push({ label, text: text.slice(0, ANSWER_CLIP), ts: Date.now() });
  if (answerHistory.length > ANSWER_HISTORY_MAX) answerHistory.splice(0, answerHistory.length - ANSWER_HISTORY_MAX);
}

// -------- window --------
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 700, H = 600;

  const savedSettings = store.getSettings();
  let startX = Math.round(workArea.x + (workArea.width - W) / 2);
  let startY = workArea.y + 6;

  if (savedSettings.windowX !== null && savedSettings.windowY !== null) {
    const clampedX = Math.max(workArea.x - W + 100, Math.min(savedSettings.windowX, workArea.x + workArea.width - 100));
    const clampedY = Math.max(workArea.y, Math.min(savedSettings.windowY, workArea.y + workArea.height - 40));
    startX = clampedX;
    startY = clampedY;
  }

  const winOptions = {
    width: W,
    height: H,
    x: startX,
    y: startY,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  };

  // Fix 1: On Windows, set type:'toolbar' which sets WS_EX_TOOLWINDOW.
  // This removes the window from Alt+Tab AND the taskbar entirely.
  // On macOS 'panel' is an NSPanel with NSWindowStyleMaskNonactivatingPanel, so
  // clicking the overlay never activates cue (dock hiding + Mission Control
  // already cover what 'toolbar' does on Windows).
  if (isWindows) {
    winOptions.type = 'toolbar';
  } else if (isMac) {
    winOptions.type = 'panel';
  }

  // Dragging the overlay or pressing one of its buttons used to make the window
  // behind it go inactive, and on a screen share that dimming is the giveaway.
  // A non-focusable window still receives clicks, it just never becomes the key
  // window, so the app behind keeps its caret and its active title bar. The
  // renderer turns this back on for text fields (see 'window:focusable').
  // Skipped on Linux, where focusable:false stops the window talking to the WM.
  if (isMac || isWindows) winOptions.focusable = false;

  win = new BrowserWindow(winOptions);

  // Fix 2: Only call setContentProtection if the OS supports it.
  // On Windows, WDA_EXCLUDEFROMCAPTURE requires build 19041+ (Windows 10 May 2020 Update).
  // On older builds we skip it silently to avoid a no-op and send a warning to the renderer.
  const shouldProtect = !process.env.CUE_NO_PROTECT;
  if (shouldProtect) {
    if (WIN_SUPPORTS_CONTENT_PROTECTION) {
      win.setContentProtection(true);
    } else {
      // Will notify the renderer after it loads
      console.log(`[cue] Windows build ${WIN_BUILD} < 19041 — setContentProtection not supported. Window may appear in screen shares.`);
    }
  }

  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (isMac && typeof win.setHiddenInMissionControl === 'function') win.setHiddenInMissionControl(true);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  let moveSaveTimer = null;
  win.on('moved', () => {
    clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) {
        const [x, y] = win.getPosition();
        store.setSettings({ windowX: x, windowY: y });
      }
    }, 500);
  });

  win.setTitle('Steam'); // set before load

  win.webContents.on('did-finish-load', () => {
    win.showInactive();
    win.setTitle('Steam');
    // Warn about missing content protection on old Windows builds
    if (isWindows && shouldProtect && !WIN_SUPPORTS_CONTENT_PROTECTION) {
      send('status', {
        message: `Heads up: your Windows version (build ${WIN_BUILD}) does not support screen-share hiding. Upgrade to Windows 10 build 19041+ or Windows 11 to enable invisibility in screen shares.`
      });
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log('[cue] renderer gone', JSON.stringify(d));
    recordEvent({ level: 'fatal', event: 'renderer_gone', code: d && d.reason, msg: 'renderer process ended: ' + JSON.stringify(d), frame: 'BrowserWindow' });
  });
}

// -------- STT flushing (batch mode fallback) --------
async function flushChannel(channel) {
  if (state.transcribing[channel]) return;
  const chunks = buffers[channel];
  if (!chunks.length) return;
  const pcm = Buffer.concat(chunks);
  buffers[channel] = [];
  if (pcm.length < MIN_BYTES) return;
  if (rms16(pcm) < RMS_GATE) return; // silence gate

  state.transcribing[channel] = true;
  try {
    const settings = store.getSettings();
    const stt = createSTT(settings);
    if (!stt.available) {
      if (!sttDisabled) { sttDisabled = true; send('status', { message: 'No transcription key set. Add an OpenAI (Whisper), Deepgram, or Gemini key in Settings to enable listening. Screen/LeetCode features work without it.' }); }
      return;
    }
    const res = await stt.transcribe(pcm);
    if (res.error) {
      handleSttError(res.error, settings);
      return;
    }
    if (res.text && res.text.trim()) {
      const turn = { channel, text: res.text.trim(), ts: Date.now() };
      pushTranscript(turn);
      send('transcript', turn);
    }
  } catch (e) {
    console.log('[stt] error', e && e.message);
    recordEvent({ level: 'error', event: 'stt_failed', msg: e && e.message ? e.message : String(e), frame: 'flushChannel', context: { channel } });
  } finally {
    state.transcribing[channel] = false;
  }
}

function handleSttError(err, settings) {
  console.log('[stt] error', err.provider, err.status, err.code, err.message);
  // Recorded before the early return, because the second and hundredth
  // occurrence still tell you the state cue is stuck in.
  recordEvent({
    level: 'error',
    event: 'stt_rejected',
    code: err.code || (err.status ? 'http_' + err.status : null),
    msg: err.message,
    frame: 'handleSttError',
    context: { provider: err.provider, status: err.status || null, alreadyDisabled: sttDisabled },
  });
  if (sttDisabled) return;
  const noAccess = err.status === 403 || err.status === 401 || err.code === 'model_not_found';
  sttDisabled = true; // stop hammering the API every few seconds
  if (noAccess) {
    send('status', { message: 'Transcription off: your ' + err.provider + ' key has no access to a speech-to-text model (403). Screen + LeetCode still work. To enable listening: give the key Whisper/transcription access, or add a Gemini key in Settings and reopen.' });
  } else {
    send('status', { message: 'Transcription error (' + err.provider + '): ' + err.message });
  }
}

function startFlushLoop() {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushChannel('you'); flushChannel('them'); }, FLUSH_MS);
}
function stopFlushLoop() { if (flushTimer) { clearInterval(flushTimer); flushTimer = null; } }

// -------- streaming STT setup --------
function initStreamingSTT() {
  const settings = store.getSettings();
  const keys = settings.apiKeys || {};

  // Check if we have a streaming-capable key
  if (!keys.deepgram && !keys.openai) {
    streamingMode = false;
    return false;
  }

  streamingMode = true;

  ['you', 'them'].forEach((channel) => {
    const sttInstance = createStreamingSTT(settings, channel, {
      onTranscript: (ch, text) => {
        const turn = { channel: ch, text, ts: Date.now() };
        pushTranscript(turn);
        send('transcript', turn);
        send('stt:final', { channel: ch, text });
      },
      onInterim: (ch, text) => {
        send('stt:interim', { channel: ch, text });
      },
      onError: (err) => {
        console.log('[streaming-stt] error', err.provider, err.message);
        // If streaming fails, disconnect cleanly then fall back to batch mode
        stopStreamingSTT(); // close WebSockets and clear keep-alive intervals
        if (!sttDisabled) {
          send('status', { message: `Streaming transcription (${err.provider}) error: ${err.message}. Falling back to batch mode.` });
        }
        streamingMode = false;
        startFlushLoop(); // activate batch fallback
      },
      onStatusChange: (ch, status) => {
        send('stt:status', { channel: ch, status });
        if (status === 'connected') {
          console.log(`[streaming-stt] ${ch} channel connected`);
        }
      }
    });

    if (sttInstance.type === 'streaming' && sttInstance.instance) {
      streamingSTT[channel] = sttInstance.instance;
      sttInstance.instance.connect();
    }
  });

  return streamingMode;
}

function stopStreamingSTT() {
  ['you', 'them'].forEach((channel) => {
    if (streamingSTT[channel]) {
      streamingSTT[channel].disconnect();
      streamingSTT[channel] = null;
    }
  });
  streamingMode = false;
}

// -------- audio routing (streaming or batch) --------
function routeAudio(channel, pcmBuffer) {
  const buf = Buffer.from(pcmBuffer);

  // Always run through VAD for speech state detection
  vad[channel].processChunk(buf);

  // Keep pre-speech buffer
  ringBuffers[channel].write(buf);

  if (streamingMode && streamingSTT[channel]) {
    // Streaming mode: send raw PCM directly to the WebSocket
    streamingSTT[channel].sendAudio(pcmBuffer);
  } else {
    // Batch mode: accumulate in buffers for periodic flush
    buffers[channel].push(buf);
  }
}

// -------- capture toggle --------
// Mic + system audio are both captured in the RENDERER (getUserMedia for the mic,
// getDisplayMedia loopback for system audio) so they run inside cue's own process
// and use cue's own Screen-Recording grant — no separate helper binary to authorize.
function setCapturing(active) {
  state.capturing = active;
  if (active) {
    sttDisabled = false; // reset on re-enable
    // Try streaming first, fall back to batch
    const streaming = initStreamingSTT();
    if (!streaming) {
      startFlushLoop();
    }
    console.log('[cue] capture started, mode:', streaming ? 'streaming' : 'batch');
  } else {
    stopFlushLoop();
    stopStreamingSTT();
    buffers.you = []; buffers.them = [];
    vad.you.reset(); vad.them.reset();
    ringBuffers.you.clear(); ringBuffers.them.clear();
  }
  send('capture:state', { active, streaming: streamingMode });
  return active;
}

// -------- feature runner --------
async function runFeature(mode, userText) {
  if (state.busy) return;
  const def = MODES[mode];
  if (!def) return;
  state.busy = true;
  try {
    const settings = store.getSettings();
    const llm = createLLM(settings);
    const userBubble = def.userBubble !== null ? def.userBubble : (mode === 'ask' ? userText : null);
    // No category pill for the two impersonal modes — "Technical" over a list
    // of line numbers is noise, and neither gets a context block to match it.
    const category = (mode !== 'leetcode' && mode !== 'debug') ? detectCategory(transcript) : null;
    send('llm:start', { userBubble, small: !!def.small, category });

    if (!llm.ready) {
      send('llm:error', { message: 'Add your ' + settings.provider + ' API key in Settings (gear icon) to start. Model: ' + (llm.model || 'unset') + '.' });
      return;
    }

    let imageDataUrl = null;
    if (def.needsScreen) {
      try { imageDataUrl = await captureScreenshot(); }
      catch (e) {
        recordEvent({ level: 'error', event: 'screen_capture_failed', msg: e && e.message ? e.message : String(e), frame: 'captureScreenshot', context: { mode } });
        // Say that the answer is going out blind. Silently dropping the image
        // just made the model look like it had ignored the screen.
        send('status', { message: 'Could not see the screen — answering from the conversation alone. If this keeps happening, check that Screen Recording is granted in System Settings.' });
      }
    }

    const settingsForPrompt = store.getSettings();
    const contextBlock = buildInterviewContext(settingsForPrompt, mode, transcript);
    let system = def.buildSystem ? def.buildSystem(contextBlock) : (def.system || '');
    if (def.code) {
      // Debug reads code that already exists, so its fixes follow the language
      // on screen rather than the composer's pinned choice — 'auto' is the
      // directive that says to prefer what is visible.
      const dir = codeLanguageDirective(def.inferLanguage ? 'auto' : settingsForPrompt.codeLanguage);
      if (dir) system += '\n\n' + dir;
      // A mode may bring its own contract; CODING_GUIDANCE is only the default.
      // The two can't be combined — it mandates exactly three parts ending on
      // the complexity bullets with nothing after them.
      system += '\n\n' + (def.guidance || CODING_GUIDANCE);
    }
    const built = def.build({ transcript, userText: userText || '' });
    // max_tokens is a ceiling, not a target — the model still stops when the
    // answer is done — so these are set well clear of what an answer needs.
    // They have to be: Claude 5 counts thinking against this same budget, and
    // the old conversational figure (2800) could be spent entirely on reasoning
    // before a single visible word, which surfaces as a truncated reply rather
    // than an error. llm.js clamps per provider, so smaller models are unaffected.
    const maxTokens = def.code
      ? (settings.smart ? 64000 : 32000)
      : (settings.smart ? 32000 : 16000);
    const answer = await llm.stream({
      system,
      turns: [...historyTurns(def), { role: 'user', text: built }],
      imageDataUrl,
      maxTokens,
      effort: def.effort, // undefined for every mode but debug — API default is `high`
      onToken: (t) => send('llm:token', { text: t })
    });
    // Recorded even for modes that don't read the history back (leetcode), so a
    // follow-up asked through Assist can still pick up what Solve answered.
    rememberAnswer(mode === 'ask' && userText ? userText : (def.userBubble || 'Assist with what is on screen and being said.'), answer);
    send('llm:done', {});
  } catch (e) {
    recordEvent({ level: 'error', event: 'llm_failed', msg: e && e.message ? e.message : String(e), frame: 'runFeature', context: { mode, provider: store.getSettings().provider } });
    send('llm:error', { message: e && e.message ? e.message : String(e) });
  } finally {
    state.busy = false;
  }
}

// -------- IPC --------
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => { sttDisabled = false; return store.setSettings(patch); });
ipcMain.handle('capture:toggle', () => setCapturing(!state.capturing));
ipcMain.handle('capture:state', () => ({ active: state.capturing }));
ipcMain.handle('platform:info', () => ({
  platform: process.platform,
  winBuild: WIN_BUILD,
  winSupportsContentProtection: WIN_SUPPORTS_CONTENT_PROTECTION
}));
ipcMain.handle('transcript:clear', () => {
  transcript.splice(0, transcript.length);
  // Clear means start fresh, so cue's own answers go too — otherwise it would
  // keep referring back to a solution the user has deliberately moved on from.
  answerHistory.splice(0, answerHistory.length);
  return { ok: true };
});
ipcMain.on('ask', (_e, payload) => runFeature(payload.mode, payload.text));
ipcMain.on('mic:pcm', (_e, arrayBuffer) => { if (state.capturing) routeAudio('you', arrayBuffer); });
ipcMain.on('system:pcm', (_e, arrayBuffer) => { if (state.capturing) routeAudio('them', arrayBuffer); });
ipcMain.on('mouse:ignore', (_e, v) => { if (win) win.setIgnoreMouseEvents(!!v, { forward: true }); });
// Text entry is the only thing that genuinely needs the keyboard, so the
// renderer grants focusability for it and takes it back afterwards. Never
// release it with win.blur() — on macOS that also drops the window to the back
// of the z-order, which would undo always-on-top.
ipcMain.on('window:focusable', (_e, focusable) => {
  if (!win || win.isDestroyed() || (!isMac && !isWindows)) return;
  win.setFocusable(!!focusable);
  // Windows decides activation at mousedown, so the click that opened a field
  // races this message; focusing explicitly lands the caret on the first press.
  // Not done on macOS, where focus() activates the app and would reintroduce
  // exactly the un-focus this is meant to prevent — the non-activating panel
  // takes key status on its own.
  if (focusable && isWindows) win.focus();
});
ipcMain.on('open-pane', (_e, url) => { shell.openExternal(url).catch(() => {}); });
ipcMain.on('log', (_e, msg) => console.log('[renderer]', msg));
// Copying has to come from a click rather than ⌘C. The overlay is deliberately
// non-focusable so it can't pull focus off the window behind it, which also
// means keystrokes go to whatever app IS focused and never reach cue.
ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(String(text == null ? '' : text)));
ipcMain.on('app:quit', () => app.quit());
ipcMain.handle('applink:state', () => appLinkConsentState());
ipcMain.handle('applink:revoke', (_e, callerId) => revokeAppLinkCaller(callerId));

// -------- shortcuts --------
function registerShortcuts() {
  shortcutState.assist = globalShortcut.register('CommandOrControl+Return', () => runFeature('assist', ''));
  shortcutState.say = globalShortcut.register('CommandOrControl+Shift+Return', () => runFeature('say', ''));
  shortcutState.leetcode = globalShortcut.register('CommandOrControl+H', () => runFeature('leetcode', ''));
  shortcutState.debug = globalShortcut.register('CommandOrControl+Shift+D', () => runFeature('debug', ''));
  shortcutState.clear = globalShortcut.register('CommandOrControl+Shift+K', () => send('shortcut:clear', {}));
  shortcutState.hide = globalShortcut.register('CommandOrControl+\\', () => send('shortcut:hide', {}));
  // Both flip a setting the renderer already owns, so they go the same way as
  // clear/hide: the renderer does the work and is the only writer of settings.
  shortcutState.smart = globalShortcut.register('CommandOrControl+Shift+M', () => send('shortcut:smart', {}));
  shortcutState.lang = globalShortcut.register('CommandOrControl+Shift+L', () => send('shortcut:lang', {}));
  shortcutState.quit = globalShortcut.register('CommandOrControl+Shift+X', () => app.quit());
  for (const [name, wasRegistered] of Object.entries(shortcutState)) {
    if (!wasRegistered) {
      recordEvent({ level: 'warn', event: 'shortcut_unavailable', msg: 'another application holds the ' + name + ' shortcut', frame: 'registerShortcuts', context: { shortcut: name } });
    }
  }
}

// -------- lifecycle --------
app.whenReady().then(() => {
  app.setName('MicrosoftEdgeUpdate');
  if (isWindows) {
    process.title = 'MicrosoftEdgeUpdate';
    // Windows names and groups the taskbar item (including the pinned entry and
    // its right-click menu) by AppUserModelID. Setting it explicitly gives the
    // app a fresh identity so it resolves to the current window title ("Steam")
    // instead of a cached "cue" name from an earlier build/pin.
    app.setAppUserModelId('com.steam.overlay');
  }

  if (isMac && app.dock) app.dock.hide();

  const allowMedia = (permission) => permission === 'media' || permission === 'microphone' || permission === 'audioCapture' || permission === 'display-capture' || permission === 'screen';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

  // System-audio loopback for getDisplayMedia: hand back a screen source with 'loopback'
  // audio so the renderer can capture what's playing (Zoom/Meet) using cue's own grant.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (!sources.length) return callback();
      const request = { video: sources[0] };
      if (isWindows) request.audio = true;
      else request.audio = 'loopback';
      callback(request);
    }).catch(() => callback());
  }, { useSystemPicker: false });

  // Started before the shortcuts so their registration failures are recorded.
  startAppLink({
    snapshot: () => ({
      state,
      transcript,
      settings: store.getSettings(),
      sttDisabled,
      shortcuts: { ...shortcutState },
      windowAlive: !!(win && !win.isDestroyed()),
    }),
    setCapturing,
    // Looked up rather than captured: the window is recreated on 'activate',
    // so a reference taken at startup goes stale.
    getWindow: () => win,
  });

  createWindow();
  primeCapture(); // deliberately not awaited — startup must not wait on it
  registerShortcuts();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Best effort, deliberately not blocking the quit: the library also removes
  // the instance file from a `process.on('exit')` handler, and a file left
  // behind is harmless anyway because readers check whether the PID is alive.
  // Delaying shutdown to tidy a directory would be the wrong trade.
  stopAppLink();
});
app.on('window-all-closed', () => app.quit());
