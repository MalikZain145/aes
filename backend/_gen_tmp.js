// Regenerate BS(UG)+BTech + MS(PG). The backend completes a datesheet request even
// if the HTTP client aborts (undici ~300s headers timeout), so we fire the request
// and then POLL MongoDB for the fresh records instead of relying on the fetch body.
process.chdir('D:/abasyn-scheduler/backend');
require('dotenv').config();
const jwt = require('jsonwebtoken');
const m = require('mongoose');
const fs = require('fs');

const OUT = 'C:/Users/malik/AppData/Local/Temp/claude/D--Sehat-Line-App/ce08be22-6e1a-4a10-97c5-3d48bba51813/scratchpad/gen_result.json';
const log = (o) => { fs.writeFileSync(OUT, JSON.stringify(o, null, 2)); console.log(JSON.stringify(o)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UG = {
  examType: 'finals', startDate: '2026-10-31', windowMode: 'by_days', numDays: 7,
  programLevel: 'Undergraduate',
  mergeGroups: [
    ['SU103', 'VS101'], ['SU106', 'DP112', 'DP113'], ['SU105', 'RT116'],
    ['RT102', 'SU102', 'VS102'], ['DP207', 'SU104'], ['VS401', 'SS401'],
  ],
  excludeCourses: [
    'VS205','VS206','VS214','VS215','VS304','VS305','VS306','VS314','VS316','VS404','VS406','VS407','VS412','VS413',
    'DP319','DP329','DP339','DP349','DP437','DP419','DP449','OT206',
  ],
};
const PG = {
  examType: 'finals', startDate: '2026-10-31', windowMode: 'by_days', numDays: 7,
  programLevel: 'Postgraduate',
  mergeGroups: [['MS501', 'CS601'], ['CE614', 'PM616'], ['CE611', 'PM615']],
};

async function main() {
  await m.connect(process.env.MONGO_URI);
  const User = require('./models/User');
  const GF = require('./models/GeneratedFile');
  const admin = await User.findOne({ role: 'admin' });
  const token = jwt.sign({ id: admin._id.toString(), username: admin.username, role: admin.role }, process.env.JWT_SECRET, { expiresIn: '3h' });

  const fire = (body) => fetch('http://localhost:5000/api/generate/datesheet', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body),
  }).then((r) => r.json()).catch((e) => ({ _clientErr: String(e) }));

  // wait until >=want datesheet records of a cohort predicate were created after sinceTs
  const waitFor = async (pred, want, sinceTs, label, maxMs = 25 * 60 * 1000) => {
    const t0 = Date.now();
    for (;;) {
      const recs = await GF.find({ kind: 'datesheet', createdAt: { $gt: sinceTs } }).lean();
      const hit = recs.filter(pred);
      if (hit.length >= want) return hit;
      if (Date.now() - t0 > maxMs) throw new Error(`timeout waiting for ${label} (${hit.length}/${want})`);
      await sleep(8000);
    }
  };
  const isBtech = (d) => d.meta && d.meta.btech;
  const isPG = (d) => /post/i.test((d.meta && d.meta.programLevel) || '');
  const isBS = (d) => !isBtech(d) && !isPG(d);

  const state = { startedAt: new Date().toISOString(), ug: 'running', pg: 'pending' };
  log(state);

  // ---- UG (BS + BTech) ----
  const ugSince = new Date();
  const ugResp = fire(UG); // may reject client-side; server keeps going
  try {
    const ugRecs = await waitFor((d) => isBS(d) || isBtech(d), 2, ugSince, 'UG BS+BTech');
    await ugResp.catch(() => {});
    state.ug = 'done';
    state.ugResult = ugRecs.map((d) => ({ cohort: isBtech(d) ? 'BTech' : 'BS', title: d.title, summary: d.summary }));
  } catch (e) { state.ug = 'error'; state.ugResult = String(e); }
  log(state);

  // ---- PG (MS) ----
  state.pg = 'running'; log(state);
  const pgSince = new Date();
  const pgResp = fire(PG);
  try {
    const pgRecs = await waitFor(isPG, 1, pgSince, 'MS');
    await pgResp.catch(() => {});
    state.pg = 'done';
    state.pgResult = pgRecs.map((d) => ({ cohort: 'MS', title: d.title, summary: d.summary }));
  } catch (e) { state.pg = 'error'; state.pgResult = String(e); }

  state.finishedAt = new Date().toISOString();
  log(state);
  await m.disconnect();
}
main().catch((e) => { log({ fatal: String(e) }); process.exit(1); });
