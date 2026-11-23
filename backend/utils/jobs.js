/**
 * jobs.js — long requests (dataset import, datesheet import, admit cards) run in
 * the BACKGROUND, so a hosted server's request timeout (Render ~100 s) or a weak
 * connection can never cut them off half-way.
 *
 * A route wrapped with asJob(handler) behaves exactly as before for old clients.
 * When the client sends the header  X-Async-Job: 1  the server answers at once with
 *   202 { jobId }
 * runs the handler in the background with a recording `res`, and the client polls
 *   GET /api/jobs/:id  → { state: 'running' | 'done', status, body, progress }
 * Jobs live in memory for an hour (one server instance).
 */
const crypto = require('crypto');

const JOBS = new Map();
const TTL_MS = 60 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [id, j] of JOBS) if (now - j.updatedAt > TTL_MS) JOBS.delete(id);
}
setInterval(sweep, 10 * 60 * 1000).unref();

function recordingRes(job) {
  const res = {
    statusCode: 200,
    headersSent: false,
    locals: {},
    status(c) { this.statusCode = c; return this; },
    set() { return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    type() { return this; },
    json(b) { finish(job, this.statusCode, b); this.headersSent = true; return this; },
    send(b) {
      let body = b;
      if (typeof b === 'string') { try { body = JSON.parse(b); } catch { body = { message: b }; } }
      finish(job, this.statusCode, body); this.headersSent = true; return this;
    },
    end() { if (!this.headersSent) finish(job, this.statusCode, null); this.headersSent = true; return this; },
    sendStatus(c) { finish(job, c, null); this.headersSent = true; return this; },
    on() { return this; },
    once() { return this; },
  };
  return res;
}

function finish(job, status, body) {
  if (job.state === 'done') return;
  job.state = 'done';
  job.status = status;
  job.body = body;
  job.updatedAt = Date.now();
}

/** Wrap an Express handler so it can run as a background job. */
function asJob(handler, { label = 'task' } = {}) {
  return (req, res, next) => {
    if (String(req.get('X-Async-Job') || '') !== '1') return handler(req, res, next);
    const id = crypto.randomBytes(12).toString('hex');
    const job = {
      id, label, state: 'running', status: null, body: null, progress: null,
      owner: req.user ? String(req.user._id || req.user.id || '') : '',
      startedAt: Date.now(), updatedAt: Date.now(),
    };
    JOBS.set(id, job);
    req.job = { progress(p) { job.progress = p; job.updatedAt = Date.now(); } };
    res.status(202).json({ jobId: id, state: 'running' });
    const fake = recordingRes(job);
    Promise.resolve()
      .then(() => handler(req, fake, (err) => { if (err) finish(job, 500, { error: err.message || String(err) }); }))
      .catch((e) => { console.error(`job ${label}:`, e && e.message); finish(job, 500, { error: (e && e.message) || 'The task failed.' }); });
  };
}

/** GET /api/jobs/:id */
function jobStatus(req, res) {
  const job = JOBS.get(String(req.params.id || ''));
  if (!job) return res.status(404).json({ error: 'This task is no longer known — the server may have restarted. Please run it again.' });
  const me = req.user ? String(req.user._id || req.user.id || '') : '';
  if (job.owner && me && job.owner !== me && !(req.user && req.user.role === 'admin')) return res.status(404).json({ error: 'Task not found.' });
  res.json({
    id: job.id, label: job.label, state: job.state, status: job.status, body: job.body,
    progress: job.progress, seconds: Math.round((Date.now() - job.startedAt) / 1000),
  });
}

module.exports = { asJob, jobStatus, _jobs: JOBS };
