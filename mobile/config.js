// ── Exam server address (SEED / FALLBACK ONLY) ───────────────────────────────
// The app AUTO-DETECTS the exam server on whatever WiFi it's on: it probes
// /api/health across the phone's own subnet and caches the hit (see App.js
// discoverBackend). So changing networks needs no config. This value is just a
// first candidate to try (your usual home IP) + a fallback if discovery fails;
// you can also set the IP manually from the app's server bar.
export const API_BASE = 'http://192.168.1.8:5000';

// Legacy: old cards embedded a "{base}/verify/<token>" URL; still supported.
export const VERIFY_PATH = '/verify/';
