// Screenshot via desktopCapturer (main process).
// The first call can trigger the system permission prompt for the app.
const { desktopCapturer, screen } = require('electron');

// Cap the long edge and the payload size. Providers reject oversized images —
// Anthropic/Bedrock (Claude) hard-limit the base64 image to 5 MB and downscale
// anything past ~1568px on the long edge anyway — so a full-resolution hi-DPI
// screenshot (a multi-MB PNG) would 400 out. We cap resolution, keep PNG while
// it fits (crisp for on-screen code/text), and fall back to JPEG otherwise.
const MAX_EDGE = 1568;
const B64_TARGET = Math.floor(4.5 * 1024 * 1024); // safety margin under the 5 MB cap

function fitsBase64(buf) {
  return Math.ceil(buf.length / 3) * 4 <= B64_TARGET;
}

async function captureScreenshot() {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.size;
  const scale = primary.scaleFactor || 1;
  const nativeW = Math.floor(width * scale);
  const nativeH = Math.floor(height * scale);
  const capScale = Math.min(1, MAX_EDGE / Math.max(nativeW, nativeH));
  const thumbW = Math.max(1, Math.round(nativeW * capScale));
  const thumbH = Math.max(1, Math.round(nativeH * capScale));

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: thumbW, height: thumbH }
  });
  if (!sources.length) return null;
  // Prefer the primary display source.
  const src = sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0];
  const img = src.thumbnail;
  if (!img || img.isEmpty()) return null;

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

module.exports = { captureScreenshot };
