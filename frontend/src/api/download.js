import api from './client';

/**
 * Downloads a file from an authenticated API endpoint.
 *
 * Uses a NATIVE browser download (an <a> element pointed straight at the API
 * URL) rather than fetching the whole response into an in-memory Blob via axios.
 * The browser streams the bytes directly to disk, which is far more reliable for
 * large files — the ~13 MB admit-card PDF was failing with a "network error"
 * when buffered as a Blob, while the smaller sheets succeeded. The server sets
 * Content-Disposition, so the friendly filename is preserved.
 *
 * Auth: a browser navigation can't send an Authorization header, so the JWT is
 * appended as `?token=`; the API's auth middleware accepts it for GET downloads.
 */
export async function downloadFile(url, filename) {
  const base = (api.defaults.baseURL || '/api').replace(/\/$/, '');
  const token = localStorage.getItem('abasyn_token') || '';
  const sep = url.includes('?') ? '&' : '?';
  const href = `${base}${url}${token ? `${sep}token=${encodeURIComponent(token)}` : ''}`;

  const a = document.createElement('a');
  a.href = href;
  if (filename) a.download = filename; // hint; the server's Content-Disposition wins
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
