/* Abasyn Student Affairs — card renderer, photo enhancer, QR, validity helpers
 * (ported 1:1 from the standalone desktop app; the QR library is loaded by libs.js) */
const Card = (() => {
  // CR80 portrait in design units (= 300 DPI px). Rendered at SCALE x → 600 DPI.
  const U = { W: 638, H: 1012 };
  const SCALE = 2;
  const PHOTO = { x: 189, y: 272, w: 260, h: 320 };
  const FONT = '"Segoe UI","Inter","Helvetica Neue",Arial,sans-serif';
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  /* ---------------- dates ---------------- */
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const human = d => `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const isExpired = (d, now = new Date()) => now.getTime() > new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59).getTime();
  /** Accepts 2031-08-31, 31/08/2031, 31-08-2031, 31.08.2031, 31 Aug 2031, Aug 31 2031 (day-first for numeric dates). */
  function parseDate(v) {
    const s = String(v ?? '').trim(); if (!s) return null;
    let m, d;
    if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) d = new Date(+m[1], +m[2] - 1, +m[3]);
    else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/))) { let y = +m[3]; if (y < 100) y += 2000; d = new Date(y, +m[2] - 1, +m[1]); }
    else if ((m = s.match(/^(\d{1,2})[\s-]+([a-z]{3,})[\s,-]+(\d{4})$/i)) && MONTHS.some(x => m[2].toLowerCase().startsWith(x.toLowerCase()))) d = new Date(+m[3], MONTHS.findIndex(x => m[2].toLowerCase().startsWith(x.toLowerCase())), +m[1]);
    else { const t = Date.parse(s); if (!isNaN(t)) d = new Date(t); }
    return d && !isNaN(d) && d.getFullYear() > 1990 && d.getFullYear() < 2200 ? d : null;
  }

  /* ---------------- canvas helpers ---------------- */
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function font(ctx, w, s) { ctx.font = `${w} ${s}px ${FONT}`; }
  function spacing(ctx, px) { if ('letterSpacing' in ctx) ctx.letterSpacing = px + 'px'; }
  function fit(ctx, text, weight, size, maxW, min = 11) {
    let s = size; font(ctx, weight, s);
    while (ctx.measureText(text).width > maxW && s > min) { s -= 0.5; font(ctx, weight, s); }
    return s;
  }
  function wrap(ctx, text, maxW) {
    const words = String(text).split(/\s+/); const lines = []; let cur = '';
    for (const w of words) { const t = cur ? cur + ' ' + w : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; }
    if (cur) lines.push(cur); return lines;
  }
  function hexToRgb(h) { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); const n = parseInt(h, 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function shade(hex, p) { const [r, g, b] = hexToRgb(hex); const f = v => Math.max(0, Math.min(255, Math.round(p < 0 ? v * (1 + p) : v + (255 - v) * p))); return `rgb(${f(r)},${f(g)},${f(b)})`; }
  function rgba(hex, a) { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }

  /* ---------------- photo enhancement (crop → HD upscale → sharpen) ---------------- */
  async function loadBitmap(blob) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
    catch (e) {
      const url = URL.createObjectURL(blob);
      try {
        const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Unsupported or corrupt image')); i.src = url; });
        return img;
      } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    }
  }
  function resample(src, w, h) {
    const c = canvas(w, h), x = c.getContext('2d');
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, c.width, c.height); return c;
  }
  function unsharp(c, amount) {
    const ctx = c.getContext('2d'), { width: w, height: h } = c;
    const id = ctx.getImageData(0, 0, w, h), d = id.data, o = new Uint8ClampedArray(d);
    const W4 = w * 4;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * W4 + x * 4;
        for (let k = 0; k < 3; k++) {
          const j = i + k;
          const blur = (o[j - W4 - 4] + 2 * o[j - W4] + o[j - W4 + 4] + 2 * o[j - 4] + 4 * o[j] + 2 * o[j + 4] + o[j + W4 - 4] + 2 * o[j + W4] + o[j + W4 + 4]) / 16;
          d[j] = o[j] + amount * (o[j] - blur);
        }
      }
    }
    ctx.putImageData(id, 0, 0);
  }
  function autoLevels(c) {
    const ctx = c.getContext('2d'), id = ctx.getImageData(0, 0, c.width, c.height), d = id.data;
    const hist = new Uint32Array(256); const n = d.length / 4;
    for (let i = 0; i < d.length; i += 16) hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++;
    const total = n / 4; let lo = 0, hi = 255, acc = 0;
    while (lo < 255 && (acc += hist[lo]) < total * 0.005) lo++;
    acc = 0; while (hi > 0 && (acc += hist[hi]) < total * 0.005) hi--;
    if (hi - lo > 225 || hi <= lo) return; // already well exposed
    const lo2 = Math.min(lo, 18), hi2 = Math.max(hi, 236), sc = 255 / (hi2 - lo2);
    for (let i = 0; i < d.length; i += 4) { d[i] = (d[i] - lo2) * sc; d[i + 1] = (d[i + 1] - lo2) * sc; d[i + 2] = (d[i + 2] - lo2) * sc; }
    ctx.putImageData(id, 0, 0);
  }
  /** Returns { blob (JPEG HD), upscaled:boolean, srcW, srcH } */
  async function enhancePhoto(file) {
    const W = PHOTO.w * SCALE, H = PHOTO.h * SCALE;
    const bmp = await loadBitmap(file);
    const iw = bmp.width, ih = bmp.height;
    if (!iw || !ih) throw new Error('Empty image');
    const tr = W / H, ir = iw / ih;
    let sx, sy, sw, sh;
    if (ir > tr) { sh = ih; sw = ih * tr; sx = (iw - sw) / 2; sy = 0; }
    else { sw = iw; sh = iw / tr; sx = 0; sy = (ih - sh) * 0.18; } // keep head: bias crop towards top
    // first pass: crop, and pre-shrink very large photos to save RAM
    const first = Math.min(1, (W * 2) / sw);
    let c = canvas(sw * first, sh * first);
    const cx = c.getContext('2d'); cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
    cx.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    while (c.width / 2 >= W) c = resample(c, c.width / 2, c.height / 2);
    const upscaled = c.width < W * 0.98;
    const factor = W / c.width;
    while (c.width * 1.8 < W) c = resample(c, c.width * 1.8, c.height * 1.8); // progressive upscale
    c = resample(c, W, H);
    autoLevels(c);
    unsharp(c, upscaled ? Math.min(1.1, 0.45 + factor * 0.12) : 0.35);
    if (upscaled && factor > 2.5) unsharp(c, 0.3);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95));
    c.width = c.height = 1;
    return { blob, upscaled, srcW: iw, srcH: ih };
  }

  /* ---------------- QR ---------------- */
  function drawQR(ctx, text, x, y, size, color) {
    const qr = window.qrcode(0, 'M'); qr.addData(text); qr.make();
    const n = qr.getModuleCount();
    const px = Math.floor((size * SCALE) / n), total = px * n;
    const ox = Math.round(x * SCALE + (size * SCALE - total) / 2), oy = Math.round(y * SCALE + (size * SCALE - total) / 2);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = color;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(ox + c * px, oy + r * px, px, px);
    ctx.restore();
  }
  /* ---------------- drawing parts ---------------- */
  function drawLogo(ctx, x, y, s, S, logo) {
    ctx.save();
    ctx.beginPath(); ctx.arc(x + s / 2, y + s / 2, s / 2, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = S.accent; ctx.stroke();
    if (logo) {
      const r = Math.min((s * 0.8) / logo.width, (s * 0.5) / logo.height); // wide wordmark inscribed in the circle
      const w = logo.width * r, h = logo.height * r;
      ctx.drawImage(logo, x + (s - w) / 2, y + (s - h) / 2, w, h);
    } else {
      ctx.fillStyle = S.primary; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; font(ctx, 800, s * 0.4);
      ctx.fillText('AU', x + s / 2, y + s / 2 + 1);
    }
    ctx.restore();
  }
  function background(ctx, S) {
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, U.W, U.H);
    // fine guilloche security pattern
    ctx.save(); ctx.strokeStyle = rgba(S.primary, 0.045); ctx.lineWidth = 1;
    for (let k = 0; k < 26; k++) {
      ctx.beginPath();
      for (let x = 0; x <= U.W; x += 6) { const y = 230 + k * 28 + Math.sin(x / 38 + k * 0.7) * 10; x ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
    }
    ctx.restore();
  }
  function watermark(ctx, S, logo, cy) {
    ctx.save(); ctx.globalAlpha = 0.05;
    if (logo) { const s = 360, r = Math.min(s / logo.width, s / logo.height); ctx.drawImage(logo, (U.W - logo.width * r) / 2, cy - logo.height * r / 2, logo.width * r, logo.height * r); }
    else { ctx.fillStyle = S.primary; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; font(ctx, 900, 230); ctx.fillText('AU', U.W / 2, cy); }
    ctx.restore();
  }
  function header(ctx, S, logo, h, compact) {
    const edge = h - 28;
    const g = ctx.createLinearGradient(0, 0, U.W, h); g.addColorStop(0, shade(S.primary, -0.35)); g.addColorStop(1, S.primary);
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(U.W, 0); ctx.lineTo(U.W, edge);
    ctx.quadraticCurveTo(U.W / 2, h + 28, 0, edge); ctx.closePath(); ctx.fill();
    ctx.save(); ctx.clip(); ctx.globalAlpha = 0.07; ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(U.W - 40, 20, 120, 0, 7); ctx.fill(); ctx.beginPath(); ctx.arc(30, h - 10, 80, 0, 7); ctx.fill(); ctx.restore();
    ctx.strokeStyle = S.accent; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(0, edge + 9); ctx.quadraticCurveTo(U.W / 2, h + 37, U.W, edge + 9); ctx.stroke();
    const ls = compact ? 62 : 76, ly = compact ? 15 : 19;
    drawLogo(ctx, U.W / 2 - ls / 2, ly, ls, S, logo);
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#fff';
    spacing(ctx, 2); fit(ctx, S.uniName.toUpperCase(), 800, compact ? 34 : 39, U.W - 70); ctx.fillText(S.uniName.toUpperCase(), U.W / 2, ly + ls + (compact ? 38 : 44));
    ctx.fillStyle = S.accent; spacing(ctx, 6); fit(ctx, S.campus.toUpperCase(), 700, compact ? 18 : 20, U.W - 100);
    ctx.fillText(S.campus.toUpperCase(), U.W / 2, ly + ls + (compact ? 66 : 76)); spacing(ctx, 0);
  }
  function bottomBar(ctx, S, y) {
    const g = ctx.createLinearGradient(0, y, U.W, U.H); g.addColorStop(0, S.primary); g.addColorStop(1, shade(S.primary, -0.35));
    ctx.fillStyle = g; ctx.fillRect(0, y, U.W, U.H - y);
    ctx.fillStyle = S.accent; ctx.fillRect(0, y, U.W, 5);
  }
  function placeholder(ctx, x, y, w, h) {
    ctx.fillStyle = '#e8ecf4'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#c2cadb'; ctx.beginPath(); ctx.arc(x + w / 2, y + h * 0.38, w * 0.2, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x + w / 2, y + h * 0.88, w * 0.36, h * 0.25, 0, Math.PI, 0); ctx.fill();
    ctx.fillStyle = '#8a94aa'; ctx.textAlign = 'center'; font(ctx, 700, 14); ctx.fillText('PHOTO NOT AVAILABLE', x + w / 2, y + h - 14);
  }

  /* ---------------- FRONT ---------------- */
  async function front(st, S, assets) {
    const c = canvas(U.W * SCALE, U.H * SCALE), ctx = c.getContext('2d');
    ctx.scale(SCALE, SCALE); ctx.imageSmoothingQuality = 'high';
    background(ctx, S); watermark(ctx, S, assets.logo, 640);
    header(ctx, S, assets.logo, 215, false);
    // ribbon
    ctx.fillStyle = S.accent; rr(ctx, U.W / 2 - 122, 224, 244, 34, 17); ctx.fill();
    ctx.fillStyle = S.primary; ctx.textAlign = 'center'; font(ctx, 800, 16); spacing(ctx, 4); ctx.fillText('STUDENT CARD', U.W / 2, 247); spacing(ctx, 0);
    // photo frame
    const P = { x: PHOTO.x, y: PHOTO.y + 4, w: PHOTO.w, h: PHOTO.h };
    ctx.save(); ctx.shadowColor = 'rgba(6,40,24,.28)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6;
    ctx.fillStyle = '#fff'; rr(ctx, P.x - 8, P.y - 8, P.w + 16, P.h + 16, 22); ctx.fill(); ctx.restore();
    ctx.lineWidth = 3; ctx.strokeStyle = S.accent; rr(ctx, P.x - 8, P.y - 8, P.w + 16, P.h + 16, 22); ctx.stroke();
    ctx.save(); rr(ctx, P.x, P.y, P.w, P.h, 15); ctx.clip();
    if (assets.photo) ctx.drawImage(assets.photo, P.x, P.y, P.w, P.h); else placeholder(ctx, P.x, P.y, P.w, P.h);
    ctx.restore();
    // name
    const name = st.name.toUpperCase();
    ctx.fillStyle = S.primary; ctx.textAlign = 'center'; fit(ctx, name, 800, 36, U.W - 70, 18); ctx.fillText(name, U.W / 2, 654);
    // reg no pill
    font(ctx, 700, 23); spacing(ctx, 2); const rw = Math.min(U.W - 80, ctx.measureText(st.regNo).width + 44);
    ctx.fillStyle = S.primary; rr(ctx, (U.W - rw) / 2, 668, rw, 40, 20); ctx.fill();
    ctx.fillStyle = '#fff'; fit(ctx, st.regNo, 700, 23, rw - 30); ctx.fillText(st.regNo, U.W / 2, 696); spacing(ctx, 0);
    // details (open-ended columns chosen for the card)
    let y = 748;
    for (const [k, v] of (st.cardFields || []).slice(0, 5)) {
      ctx.textAlign = 'left'; ctx.fillStyle = '#6b7280'; fit(ctx, String(k).toUpperCase(), 600, 16, 150, 10); ctx.fillText(String(k).toUpperCase(), 62, y);
      ctx.fillStyle = '#111827'; fit(ctx, String(v), 700, 21, 352, 11); ctx.fillText(String(v), 224, y);
      ctx.fillStyle = '#e9ecf3'; ctx.fillRect(62, y + 13, U.W - 124, 1.2);
      y += 39;
    }
    // validity bar
    bottomBar(ctx, S, 932);
    ctx.textAlign = 'center'; ctx.fillStyle = S.accent; font(ctx, 700, 14); spacing(ctx, 4); ctx.fillText('VALID UPTO', U.W / 2, 964);
    ctx.fillStyle = '#fff'; font(ctx, 800, 28); spacing(ctx, 1); ctx.fillText(st.expiryText || '—', U.W / 2, 997); spacing(ctx, 0);
    return c;
  }

  /* ---------------- BACK ---------------- */
  async function back(st, S, assets) {
    const c = canvas(U.W * SCALE, U.H * SCALE), ctx = c.getContext('2d');
    ctx.scale(SCALE, SCALE); ctx.imageSmoothingQuality = 'high';
    background(ctx, S); header(ctx, S, assets.logo, 185, true);
    ctx.textAlign = 'center'; ctx.fillStyle = S.primary; font(ctx, 800, 16); spacing(ctx, 5); ctx.fillText('VERIFY WITH ABASYN SCANNER', U.W / 2, 226); spacing(ctx, 0);
    const Q = { s: 360, x: (U.W - 360) / 2, y: 244 };
    ctx.save(); ctx.shadowColor = 'rgba(6,40,24,.2)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 5;
    ctx.fillStyle = '#fff'; rr(ctx, Q.x, Q.y, Q.s, Q.s, 22); ctx.fill(); ctx.restore();
    ctx.lineWidth = 3; ctx.strokeStyle = S.accent; rr(ctx, Q.x, Q.y, Q.s, Q.s, 22); ctx.stroke();
    // corner brackets
    ctx.strokeStyle = S.primary; ctx.lineWidth = 5; const b = 34, o = 10;
    [[Q.x + o, Q.y + o, 1, 1], [Q.x + Q.s - o, Q.y + o, -1, 1], [Q.x + o, Q.y + Q.s - o, 1, -1], [Q.x + Q.s - o, Q.y + Q.s - o, -1, -1]].forEach(([x, y, dx, dy]) => {
      ctx.beginPath(); ctx.moveTo(x, y + b * dy); ctx.lineTo(x, y); ctx.lineTo(x + b * dx, y); ctx.stroke();
    });
    if (st.token) drawQR(ctx, st.token, Q.x + 26, Q.y + 26, Q.s - 52, '#061a10');
    else { ctx.fillStyle = '#9aa3b5'; ctx.textAlign = 'center'; font(ctx, 700, 18); ctx.fillText('QR + secure key', U.W / 2, Q.y + Q.s / 2 - 6); font(ctx, 500, 15); ctx.fillText('added when card is generated', U.W / 2, Q.y + Q.s / 2 + 18); }
    ctx.fillStyle = S.primary; ctx.textAlign = 'center'; font(ctx, 700, 22); spacing(ctx, 2); ctx.fillText(st.regNo, U.W / 2, 646); spacing(ctx, 0);
    ctx.fillStyle = S.accent; ctx.fillRect(U.W / 2 - 40, 664, 80, 3);
    const info = [['ADDRESS', S.address], ['TELEPHONE', S.tel], ['WEBSITE', S.web]];
    let y = 716;
    for (const [k, v] of info) {
      ctx.fillStyle = S.accent; font(ctx, 800, 13); spacing(ctx, 4); ctx.fillText(k, U.W / 2, y); spacing(ctx, 0);
      ctx.fillStyle = '#1f2937'; fit(ctx, v, 600, 20, U.W - 80, 13); ctx.fillText(v, U.W / 2, y + 25);
      y += 64;
    }
    bottomBar(ctx, S, 948);
    ctx.fillStyle = '#fff'; font(ctx, 700, 16); spacing(ctx, 5); ctx.fillText('OFFICE OF STUDENT AFFAIRS', U.W / 2, 988); spacing(ctx, 0);
    return c;
  }

  /* ---------------- export helpers ---------------- */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  /** Inserts a pHYs chunk so printers/Word read the PNG as 600 DPI. */
  function pngWithDpi(u8, dpi) {
    const ppm = Math.round(dpi / 0.0254);
    const chunk = new Uint8Array(21); const dv = new DataView(chunk.buffer);
    dv.setUint32(0, 9); chunk.set([0x70, 0x48, 0x59, 0x73], 4); dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;
    dv.setUint32(17, crc32(chunk.subarray(4, 17)));
    const at = 33; // signature(8) + IHDR(25)
    const out = new Uint8Array(u8.length + 21); out.set(u8.subarray(0, at)); out.set(chunk, at); out.set(u8.subarray(at), at + 21);
    return out;
  }
  async function toBytes(c, format) {
    const blob = await new Promise(r => c.toBlob(r, format === 'jpg' ? 'image/jpeg' : 'image/png', 0.95));
    const u8 = new Uint8Array(await blob.arrayBuffer());
    if (format === 'jpg') {
      // set JFIF density to 600 DPI when the APP0 header is present
      if (u8[2] === 0xFF && u8[3] === 0xE0 && u8[6] === 0x4A && u8[7] === 0x46) {
        const d = 300 * SCALE; u8[13] = 1; u8[14] = d >> 8; u8[15] = d & 255; u8[16] = d >> 8; u8[17] = d & 255;
      }
      return u8;
    }
    return pngWithDpi(u8, 300 * SCALE);
  }

  return { U, SCALE, parseDate, iso, human, isExpired, enhancePhoto, loadBitmap, front, back, toBytes };
})();

export default Card;
