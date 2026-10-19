/**
 * The exam clock — always Pakistan time (or EXAM_TZ), whatever time zone the
 * server itself runs in. A hosted server (Render) runs on UTC, which would make
 * every paper start / end five hours late for scanning and attendance.
 */
const TZ = process.env.EXAM_TZ || 'Asia/Karachi';

let fmt = null;
function parts(d = new Date()) {
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }
  const o = {};
  for (const p of fmt.formatToParts(d)) o[p.type] = p.value;
  const h = Number(o.hour) % 24;
  return { date: `${o.year}-${o.month}-${o.day}`, minutes: h * 60 + Number(o.minute) };
}

// '01:00' on the exam clock is 1 PM → hours 1–7 are afternoon.
function toMinutes(hhmm) {
  const m = String(hhmm || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2]);
  if (h >= 1 && h <= 7) h += 12;
  return h * 60 + min;
}

/** 'before' | 'during' | 'after' for a paper on `date` (YYYY-MM-DD) in `slot` ('09:00-10:30') */
function slotPhase(date, slot) {
  const now = parts();
  const [a, b] = String(slot || '').split('-');
  const st = toMinutes(a); const fi = toMinutes(b);
  if (!date) return 'before';
  if (date < now.date) return 'after';
  if (date > now.date) return 'before';
  if (fi != null && now.minutes > fi) return 'after';
  if (st != null && now.minutes >= st) return 'during';
  return 'before';
}

module.exports = { TZ, now: parts, toMinutes, slotPhase };
