// The QR generator (Kazuhiko Arase) and JSZip used by the original Student Affairs
// desktop app, served from /public/affairs-lib and loaded only when this module opens.
const loaded = new Map();
function loadScript(src) {
  if (!loaded.has(src)) {
    loaded.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { loaded.delete(src); s.remove(); reject(new Error(`Could not load ${src}`)); };
      document.head.appendChild(s);
    }));
  }
  return loaded.get(src);
}
export async function loadAffairsLibs() {
  await Promise.all([
    window.qrcode ? null : loadScript('/affairs-lib/qrcode.js'),
    window.JSZip ? null : loadScript('/affairs-lib/jszip.min.js'),
  ]);
  if (!window.qrcode || !window.JSZip) throw new Error('Card libraries did not load.');
  return { JSZip: window.JSZip };
}
