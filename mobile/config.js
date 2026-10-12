// ── Exam server address ──────────────────────────────────────────────────────
// The scanner app talks ONLY to this server. Put your hosted server's address
// here (with http:// or https://, no trailing slash), then rebuild the app, e.g.
//   export const API_BASE = 'https://exams.abasynisb.edu.pk';
//   export const API_BASE = 'http://203.0.113.25:5000';
// There is no IP auto-detection and no manual IP entry in the app any more.
export const API_BASE = 'https://abasyn-scheduler.onrender.com';

// Legacy: old cards embedded a "{base}/verify/<token>" URL; still supported.
export const VERIFY_PATH = '/verify/';
