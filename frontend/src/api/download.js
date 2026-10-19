import api from './client';

/**
 * Downloads a file from an authenticated API endpoint.
 *
 * The file itself goes through a NATIVE browser download (an <a> pointed at the
 * API URL) so the ~13 MB admit-card PDF streams straight to disk instead of being
 * buffered in memory. But a native download can't show WHY it failed — the
 * browser just says "File wasn't available on site". So first the same URL is
 * requested once (only the status line + headers are read, then the transfer is
 * cancelled): if the server answers with an error, its real message is shown on
 * screen and nothing is downloaded.
 *
 * Auth: a browser navigation can't send an Authorization header, so the JWT is
 * appended as `?token=`; the API's auth middleware accepts it for GET downloads.
 * Returns true when the download was started, false (after showing the reason)
 * when the server refused.
 */
export async function downloadFile(url, filename) {
  const base = (api.defaults.baseURL || '/api').replace(/\/$/, '');
  const token = localStorage.getItem('abasyn_token') || '';
  const sep = url.includes('?') ? '&' : '?';
  const href = `${base}${url}${token ? `${sep}token=${encodeURIComponent(token)}` : ''}`;

  // ── pre-check: does the server actually have this file for us? ──
  try {
    const ctrl = new AbortController();
    const res = await fetch(href, { method: 'GET', signal: ctrl.signal, cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) {
      let msg = `Download failed (${res.status}).`;
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* not JSON */ }
      ctrl.abort();
      if (res.status === 401) { window.location.href = '/login'; return false; }
      notify(msg);
      return false;
    }
    ctrl.abort();   // headers say OK — let the browser fetch the bytes natively
  } catch (e) {
    if (e && e.name !== 'AbortError') { notify('Could not reach the server for this download. Check the connection and try again.'); return false; }
  }

  const a = document.createElement('a');
  a.href = href;
  if (filename) a.download = filename; // hint; the server's Content-Disposition wins
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return true;
}

// small self-contained notice (works on every page, with or without the toast context)
function notify(msg) {
  try {
    const el = document.createElement('div');
    el.setAttribute('role', 'alert');
    el.textContent = msg;
    Object.assign(el.style, {
      position: 'fixed', left: '50%', bottom: '28px', transform: 'translateX(-50%)', zIndex: 99999,
      maxWidth: 'min(560px, calc(100vw - 32px))', padding: '12px 18px', borderRadius: '12px',
      background: '#842029', color: '#fff', font: '600 13.5px/1.45 system-ui, -apple-system, Segoe UI, sans-serif',
      boxShadow: '0 12px 32px rgba(0,0,0,.25)', textAlign: 'center',
    });
    document.body.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; }, 6000);
    setTimeout(() => el.remove(), 6600);
  } catch { window.alert(msg); }
}
