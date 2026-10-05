import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 360000, // generation can take a while
});

// Attach the JWT on every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('abasyn_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// On 401, clear the session and bounce to login
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('abasyn_token');
      localStorage.removeItem('abasyn_admin');
      if (!window.location.pathname.includes('/login')) {
        window.location.href = '/login';
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
