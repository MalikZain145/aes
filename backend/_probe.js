require('dotenv').config();
const jwt = require('jsonwebtoken');
const m = require('mongoose');
const UG = {
  examType: 'finals', startDate: '2026-10-31', windowMode: 'by_days', numDays: 7,
  programLevel: 'Undergraduate',
  mergeGroups: [['SU103','VS101'],['SU106','DP112','DP113'],['SU105','RT116'],['RT102','SU102','VS102'],['DP207','SU104'],['VS401','SS401']],
  excludeCourses: ['VS205','VS206','VS214','VS215','VS304','VS305','VS306','VS314','VS316','VS404','VS406','VS407','VS412','VS413','DP319','DP329','DP339','DP349','DP437','DP419','DP449','OT206'],
};
(async () => {
  await m.connect(process.env.MONGO_URI);
  const admin = await require('./models/User').findOne({ role: 'admin' });
  const token = jwt.sign({ id: admin._id.toString(), username: admin.username, role: admin.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
  await m.disconnect();
  console.log('firing UG POST at', new Date().toISOString());
  const t0 = Date.now();
  try {
    const r = await fetch('http://localhost:5000/api/generate/datesheet', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(UG),
    });
    const txt = await r.text();
    console.log('HTTP', r.status, 'in', ((Date.now() - t0) / 1000).toFixed(0) + 's');
    console.log('BODY:', txt.slice(0, 2000));
  } catch (e) {
    console.log('CLIENT ERROR after', ((Date.now() - t0) / 1000).toFixed(0) + 's:', String(e), e.cause ? String(e.cause) : '');
  }
})().catch((e) => { console.error(e); process.exit(1); });
