import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 360000, // generation can take a while
});

// Long tasks run as BACKGROUND JOBS on the server (no hosted-server timeout, no
// lost work on a weak connection): the server answers 202 { jobId } at once and
// this client polls /jobs/:id until the task is done, then hands the caller the
// task's own reply exactly as before — so pages need no changes.
const JOB_URLS = [/^\/?dataset\/upload$/, /^\/?generate\/admit-cards$/, /^\/?generate\/datesheet-import$/];
const isJobUrl = (cfg) => String(cfg.method || 'get').toLowerCase() === 'post'
  && JOB_URLS.some((re) => re.test(String(cfg.url || '').split('?')[0]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForJob(res) {
  const { jobId } = res.data;
  const started = Date.now();
  let misses = 0;
  for (;;) {
    await sleep(Date.now() - started < 20000 ? 1500 : 3000);
    let j;
    try {
      j = (await api.get(`/jobs/${jobId}`, { timeout: 30000 })).data;
      misses = 0;
    } catch (e) {
      if (e.response && e.response.status === 404) throw e;   // server restarted — task lost
      if (++misses > 40) throw e;                                // ~2 min without a connection
      continue;                                                  // weak network → keep waiting
    }
    if (j.state === 'done') {
      const out = { ...res, status: j.status || 200, data: j.body };
      if ((j.status || 200) >= 400) {
        const err = new Error((j.body && j.body.error) || `Request failed (${j.status})`);
        err.response = { status: j.status, data: j.body };
        err.config = res.config;
        throw err;
      }
      return out;
    }
    if (Date.now() - started > 3 * 60 * 60 * 1000) throw new Error('The task is taking too long. Check the result list later.');
  }
}

// Attach the JWT on every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('abasyn_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  if (isJobUrl(config)) config.headers['X-Async-Job'] = '1';
  return config;
});

// On 401, clear the session and bounce to login.
// On 403 PASSWORD_CHANGE_REQUIRED, open the blocking "set your password" screen.
api.interceptors.response.use(
  (res) => (res.status === 202 && res.data && res.data.jobId && isJobUrl(res.config) ? waitForJob(res) : res),
  (err) => {
    if (err.response?.status === 403 && err.response?.data?.code === 'PASSWORD_CHANGE_REQUIRED') {
      window.dispatchEvent(new CustomEvent('abasyn:password-change-required'));
    }
    if (err.response?.status === 401 && !String(err.config?.url || '').includes('/auth/login')) {
      localStorage.removeItem('abasyn_token');
      localStorage.removeItem('abasyn_admin');
      const p = window.location.pathname;
      if (!(p.startsWith('/login') || p.startsWith('/admin'))) {
        window.location.href = localStorage.getItem('abasyn_portal') === 'staff' ? '/admin' : '/login';
      }
    }
    return Promise.reject(err);
  }
);

// Helper to extract a friendly error message
export function errMsg(err, fallback = 'Something went wrong.') {
  return err?.response?.data?.error || err?.message || fallback;
}

export default api;
