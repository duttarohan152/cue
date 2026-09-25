// Screenshot via desktopCapturer (main process).
// The first call can trigger the system permission prompt for the app.
const { desktopCapturer, screen } = require('electron');

// Cap the long edge and the payload size. Claude hard-limits the base64 image
// to 5 MB, so a full-resolution hi-DPI screenshot (a multi-MB PNG) would 400
// out. We cap resolution, keep PNG while it fits (crisp for on-screen code and
// text), and fall back to JPEG otherwise.
//
// These are the HIGH-RESOLUTION tier limits, which Claude 4.7 and later — so
// Sonnet 5 and Opus 5 — use. The old 1568px cap here was the standard tier for
// earlier models and was throwing away more than half the detail the current
// models accept, on screenshots of code that they have to read character by
// character. Claude counts an image in 28x28 patches, so both limits bind:
// the long edge AND ceil(w/28) * ceil(h/28) visual tokens.
const MAX_EDGE = 2576;
const MAX_VISUAL_TOKENS = 4784;
const B64_TARGET = Math.floor(4.5 * 1024 * 1024); // safety margin under the 5 MB cap

function visualTokens(w, h) {
  return Math.ceil(w / 28) * Math.ceil(h / 28);
}

// Sending anything past these limits only costs time-to-first-token: Claude
// downscales it server-side and gives nothing back for the extra pixels.
//
// Binary search on the scale rather than shrinking iteratively, because the
// ceil() in the patch count makes small reductions no-ops — a naive loop stalls
// and settles well under the budget, throwing away resolution for nothing.
function fitToLimits(w, h) {
  const at = (s) => ({ width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) });
  const fits = (s) => {
    const { width, height } = at(s);
    return Math.max(width, height) <= MAX_EDGE && visualTokens(width, height) <= MAX_VISUAL_TOKENS;
  };
  const edgeScale = Math.min(1, MAX_EDGE / Math.max(w, h));
  if (fits(edgeScale)) return at(edgeScale);
  let lo = 0, hi = edgeScale;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  return at(lo);
}

// On macOS the first getSources() call in a fresh process reliably hands back an
// empty thumbnail — ScreenCaptureKit hasn't produced a frame yet — and sometimes
// the second one does too. The source itself is present and the permission is
// granted, so there is nothing to report; it just needs another go. Without this
// the first Assist/Solve after launch answered without ever seeing the screen.
const ATTEMPTS = 4;
const RETRY_MS = 200;

function fitsBase64(buf) {
  return Math.ceil(buf.length / 3) * 4 <= B64_TARGET;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function grabThumbnail(primary, thumbW, thumbH) {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: thumbW, height: thumbH }
  });
  if (!sources.length) return null;
  // Prefer the primary display source.
  const src = sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0];
  const img = src.thumbnail;
  return img && !img.isEmpty() ? img : null;
}

async function captureScreenshot() {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.size;
  const scale = primary.scaleFactor || 1;
  const nativeW = Math.floor(width * scale);
  const nativeH = Math.floor(height * scale);
  const { width: thumbW, height: thumbH } = fitToLimits(nativeW, nativeH);

  let img = null;
  for (let attempt = 0; attempt < ATTEMPTS && !img; attempt++) {
    if (attempt) await wait(RETRY_MS);
    img = await grabThumbnail(primary, thumbW, thumbH);
  }
  // Throw rather than return null: a silent null left runFeature sending the
  // question to the model with no image and no warning, so the answer looked
  // like the model had simply ignored the screen.
  if (!img) throw new Error('Screen capture came back blank after ' + ATTEMPTS + ' attempts.');

  // PNG first (crisp text); fall back to progressively smaller JPEG if needed.
  const png = img.toPNG();
  if (fitsBase64(png)) return 'data:image/png;base64,' + png.toString('base64');
  for (const quality of [85, 70, 55, 40]) {
    const jpg = img.toJPEG(quality);
    if (fitsBase64(jpg)) return 'data:image/jpeg;base64,' + jpg.toString('base64');
  }
  // Last resort: downscale further and compress hard so it always fits.
  const small = img.resize({ width: Math.max(1, Math.round(thumbW * 0.6)) });
  return 'data:image/jpeg;base64,' + small.toJPEG(40).toString('base64');
}

// Absorbs the warm-up above at launch instead of during an interview: primed,
// a capture settles at a steady ~400ms, unprimed it runs 1-4s while the retries
// play out. Fire-and-forget — if it fails, captureScreenshot still retries.
async function primeCapture() {
  try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 2, height: 2 } }); }
  catch (e) { /* ignore */ }
}

module.exports = { captureScreenshot, primeCapture };
