/**
 * assistantNlu.js — understanding layer of the Abasyn Voice Assistant.
 *
 * Speech engines hand us messy text in English, Roman Urdu or Urdu script
 * ("CS three one three ka paper kab hai", "عائشہ کی ڈیوٹی کہاں ہے", "nine eight four
 * one ki seat"). Everything here is PURE (no DB) so it can be tested:
 *
 *   normalize(text)                 → clean Latin text: Urdu script transliterated,
 *                                     Urdu/English number words → digits, spelled
 *                                     codes joined ("c s 3 1 3" → "cs313")
 *   detect(text, kb)                → { intent, teacher, student, course, room, date,
 *                                     slot, section, scores… } against the knowledge base
 *   best(alternatives, kb)          → the most confident parse among the ASR guesses
 */

// ── Urdu script → Latin ──────────────────────────────────────────────────────
const UR_MAP = {
  'آ': 'aa', 'ا': 'a', 'ب': 'b', 'پ': 'p', 'ت': 't', 'ٹ': 't', 'ث': 's', 'ج': 'j', 'چ': 'ch', 'ح': 'h',
  'خ': 'kh', 'د': 'd', 'ڈ': 'd', 'ذ': 'z', 'ر': 'r', 'ڑ': 'r', 'ز': 'z', 'ژ': 'zh', 'س': 's', 'ش': 'sh',
  'ص': 's', 'ض': 'z', 'ط': 't', 'ظ': 'z', 'ع': 'a', 'غ': 'gh', 'ف': 'f', 'ق': 'q', 'ک': 'k', 'ك': 'k', 'گ': 'g',
  'ل': 'l', 'م': 'm', 'ن': 'n', 'ں': 'n', 'و': 'o', 'ہ': 'h', 'ه': 'h', 'ھ': 'h', 'ة': 'h', 'ی': 'i', 'ي': 'i',
  'ے': 'e', 'ۓ': 'e', 'ئ': 'y', 'ء': '', 'أ': 'a', 'إ': 'i', 'ؤ': 'o',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '،': ',', '؟': '?', '۔': '.',
};
const DIACRITIC = /[ً-ٰٟۖ-ۭ]/g;
const hasUrdu = (s) => /[؀-ۿ]/.test(s || '');

// whole Urdu words first (meaning-preserving), then letter-by-letter
const UR_WORDS = [
  [/ڈیوٹی|ڈیوٹیاں|ڈیوٹیز/g, ' duty '], [/نگرانی|نگران/g, ' invigilation '], [/پرچہ|پرچے|پیپر|پیپرز/g, ' paper '],
  [/امتحان|امتحانات/g, ' exam '], [/سیٹ|نشست/g, ' seat '], [/کمرہ|کمرے|روم/g, ' room '], [/سیکشن/g, ' section '],
  [/ڈیٹ\s?شیٹ/g, ' datesheet '], [/ایڈمٹ\s?کارڈ|داخلہ\s?کارڈ/g, ' admitcard '], [/فیس/g, ' fee '],
  [/طالب\s?علم|طلبہ|طلباء|اسٹوڈنٹ|سٹوڈنٹ|بچے|بچوں/g, ' student '], [/استاد|اساتذہ|ٹیچر|ٹیچرز|فیکلٹی/g, ' teacher '],
  [/کورس|کورسز|مضمون|مضامین|سبجیکٹ/g, ' course '], [/کتنے|کتنی|کتنا|تعداد/g, ' kitne '], [/کب/g, ' kab '],
  [/کہاں/g, ' kahan '], [/کون/g, ' kaun '], [/کس/g, ' kis '], [/کیا/g, ' kya '], [/بتاؤ|بتائیں|بتا/g, ' batao '],
  [/دکھاؤ|دکھائیں/g, ' dikhao '], [/آج/g, ' aaj '], [/کل/g, ' kal '], [/صبح/g, ' subah '], [/دوپہر/g, ' dopahar '],
  [/تاریخ/g, ' tareekh '], [/بجے/g, ' baje '], [/لیب|لیبز/g, ' lab '],
  [/پیر|سوموار/g, ' monday '], [/منگل/g, ' tuesday '], [/بدھ/g, ' wednesday '], [/جمعرات/g, ' thursday '],
  [/جمعہ/g, ' friday '], [/ہفتہ|سنیچر/g, ' saturday '], [/اتوار/g, ' sunday '],
  [/جنوری/g, ' january '], [/فروری/g, ' february '], [/مارچ/g, ' march '], [/اپریل/g, ' april '], [/مئی/g, ' may '],
  [/جون/g, ' june '], [/جولائی/g, ' july '], [/اگست/g, ' august '], [/ستمبر/g, ' september '],
  [/اکتوبر/g, ' october '], [/نومبر/g, ' november '], [/دسمبر/g, ' december '],
  [/اباسین|ابا\s?سین|اباسن|ابیسین/g, ' abasyn '],
  [/(^|\s)ایک(?=\s|$)/g, ' aik '], [/(^|\s)تین(?=\s|$)/g, ' teen '], [/(^|\s)چار(?=\s|$)/g, ' chaar '], [/(^|\s)پانچ(?=\s|$)/g, ' paanch '],
  [/(^|\s)چھ(?=\s|$)/g, ' chhe '], [/(^|\s)سات(?=\s|$)/g, ' saat '], [/(^|\s)آٹھ(?=\s|$)/g, ' aath '], [/(^|\s)نو(?=\s|$)/g, ' nau '],
  [/(^|\s)دس(?=\s|$)/g, ' das '], [/(^|\s)سو(?=\s|$)/g, ' sau '], [/(^|\s)ہزار(?=\s|$)/g, ' hazar '], [/(^|\s)صفر(?=\s|$)/g, ' sifar '],
];
// spelled course / room codes in Urdu script: "سی ایس 313" → "c s 313"
const UR_LETTERS = { 'اے': 'a', 'بی': 'b', 'سی': 'c', 'ڈی': 'd', 'ای': 'e', 'ایف': 'f', 'ایچ': 'h', 'آئی': 'i', 'جے': 'j',
  'ایل': 'l', 'ایم': 'm', 'این': 'n', 'او': 'o', 'پی': 'p', 'کیو': 'q', 'آر': 'r', 'ایس': 's', 'ٹی': 't', 'یو': 'u', 'وی': 'v',
  'ڈبلیو': 'w', 'ایکس': 'x', 'وائی': 'y', 'زیڈ': 'z', 'جی': 'g', 'کے': 'k' };
function urduLetters(t) {
  const names = Object.keys(UR_LETTERS).sort((a, b) => b.length - a.length).join('|');
  const run = new RegExp(`((?:(?:${names})\\s*){1,5})(?=[\\s-]*(?:[0-9۰-۹٠-٩]|ایک|دو|تین|چار|پانچ|چھ|سات|آٹھ|نو|صفر))`, 'g');
  return t.replace(run, (m) => ' ' + m.trim().split(/\s+/).map((w) => UR_LETTERS[w] || w).join(' ') + ' ');
}
function urduToLatin(s) {
  if (!hasUrdu(s)) return s;
  let t = urduLetters(String(s).replace(DIACRITIC, ''));
  for (const [re, v] of UR_WORDS) t = t.replace(re, v);
  return t.split('').map((c) => (UR_MAP[c] !== undefined ? UR_MAP[c] : (/[؀-ۿ]/.test(c) ? '' : c))).join('');
}

// ── numbers ──────────────────────────────────────────────────────────────────
const NUM = {
  zero: 0, sifar: 0, one: 1, aik: 1, ek: 1, two: 2, three: 3, teen: 3, tin: 3, four: 4, char: 4, chaar: 4,
  five: 5, panch: 5, paanch: 5, panc: 5, six: 6, chay: 6, chhe: 6, chey: 6, chh: 6, seven: 7, saat: 7, eight: 8, aath: 8, ath: 8, aat: 8,
  nine: 9, nau: 9, nao: 9, ten: 10, das: 10, eleven: 11, gyara: 11, gyarah: 11, twelve: 12, bara: 12, barah: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
// words that are ALSO common Urdu/English words — only digits when they sit next to other digits
const AMBIG = new Set(['do', 'tin', 'ath', 'aat', 'char', 'ek', 'nau', 'nao', 'das', 'bara']);

function wordsToDigits(text) {
  const toks = text.split(/\s+/).filter(Boolean);
  const isNum = (w) => Object.prototype.hasOwnProperty.call(NUM, w);
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i];
    if (!isNum(w) && w !== 'do') { out.push(w); continue; }
    const nb = (j) => j >= 0 && j < toks.length && (isNum(toks[j]) || /^\d+$/.test(toks[j]) || /^(hundred|sau|thousand|hazar)$/.test(toks[j]));
    // an ambiguous word ("do", "char", "nau") is a number only beside other SPOKEN numbers
    const nbWord = (j) => j >= 0 && j < toks.length && ((isNum(toks[j]) && !AMBIG.has(toks[j])) || /^\d$/.test(toks[j]) || /^(hundred|sau|thousand|hazar)$/.test(toks[j]));
    const ambiguous = AMBIG.has(w) || w === 'do';
    // …or right before "baje" (time) or a month ("das november")
    const ctx = /^(baje|bje|bajay|bajey|oclock|november|october|december|nov|oct|dec|tareekh|tarikh)$/.test(toks[i + 1] || '');
    if (ambiguous && !ctx && !nbWord(i - 1) && !nbWord(i + 1)) { out.push(w); continue; }
    if (w === 'do') { out.push('2'); continue; }
    let v = NUM[w];
    // "twenty one" / "forty five"
    if (v >= 20 && v % 10 === 0 && isNum(toks[i + 1]) && NUM[toks[i + 1]] < 10) { v += NUM[toks[i + 1]]; i++; }
    out.push(String(v));
  }
  // "4 hundred 3" / "char sau teen" / "4 so 3" → 403 ; "9 thousand 8 hundred 41" → 9841
  const t2 = [];
  for (let i = 0; i < out.length; i++) {
    const w = out[i];
    if (/^\d+$/.test(w) && /^(hundred|sau|so)$/.test(out[i + 1] || '')) {
      let v = Number(w) * 100; i++;
      if (/^\d{1,2}$/.test(out[i + 1] || '')) { v += Number(out[i + 1]); i++; }
      if (t2.length && /^\d+000$/.test(t2[t2.length - 1])) v += Number(t2.pop());
      t2.push(String(v)); continue;
    }
    if (/^\d+$/.test(w) && /^(thousand|hazar|hazaar|hajar)$/.test(out[i + 1] || '')) { t2.push(String(Number(w) * 1000)); i++; continue; }
    if (/^\d{1,2}$/.test(w) && t2.length && /^\d+[1-9]00$|^\d+000$/.test(t2[t2.length - 1]) && Number(t2[t2.length - 1]) % 100 === 0) { t2.push(String(Number(t2.pop()) + Number(w))); continue; }
    t2.push(w);
  }
  return t2.join(' ');
}

/** join digit runs ("9 8 4 1" → "9841") and spelled codes ("c s 313" → "cs313", "j 214" → "j214") */
const EN_LETTERS = { gee: 'g', jee: 'g', see: 'c', sea: 'c', si: 'c', es: 's', ess: 's', em: 'm', en: 'n', jay: 'j', jey: 'j', bee: 'b', dee: 'd', pee: 'p', tee: 't', ee: 'e', eff: 'f', ef: 'f', el: 'l', ell: 'l', are: 'r', aar: 'r', aay: 'a', ay: 'a', eh: 'a' };
function joinTokens(text) {
  // letter names right before a number: "see es 313" → "c s 313"
  let t = text.replace(/\b((?:[a-z]{1,4}\s+){1,4})(?=\d)/g, (m) => {
    const w = m.trim().split(/\s+/);
    const tail = []; for (let i = w.length - 1; i >= 0 && (EN_LETTERS[w[i]] || /^[a-z]$/.test(w[i])); i--) tail.unshift(w[i]);
    if (!tail.length || (tail.length === 1 && !/^[a-z]$/.test(tail[0]) && !EN_LETTERS[tail[0]])) return m;
    const head = w.slice(0, w.length - tail.length);
    return (head.length ? head.join(' ') + ' ' : '') + tail.map((x) => EN_LETTERS[x] || x).join(' ') + ' ';
  });
  for (let k = 0; k < 4; k++) t = t.replace(/\b(\d)\s+(?=\d\b)/g, '$1');
  t = t.replace(/\b(\d{1,2})\s+(?=\d{2,3}\b)/g, (m, a) => (a.length === 1 ? a : m));   // "3 13" → "313"
  // spelled letters: "c s" "m g" → "cs" "mg"
  t = t.replace(/\b([a-z])\s([a-z])\b(?=\s*\d)/g, '$1$2');
  t = t.replace(/\b([a-z]{1,6})\s*-?\s*(\d{3,4}[a-z]?)\b/g, '$1$2');   // "cs 313" → "cs313", "j 214" → "j214"
  return t;
}

const FILLERS = /\b(abasyn|abasin|abaseen|abasen|absin|please|plz|zara|zra|mujhe|mujhy|muje|yaar|yar|sir|madam|mam|maam|ji|jee|bhai|hey|hello|ok|okay)\b/g;

function normalize(text) {
  let t = urduToLatin(String(text || ''));
  t = t.toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9\s:.\-/]/g, ' ')
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    .replace(/[.\-/](?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ').trim();
  t = wordsToDigits(t);
  t = joinTokens(t);
  t = t.replace(FILLERS, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

// ── fuzzy matching ───────────────────────────────────────────────────────────
const TITLES = /\b(mr|mrs|ms|miss|dr|engr|eng|prof|professor|sir|madam|mam|syed|hafiz|muhammad|mohammad|muhammed|mohd|m)\b/g;
/** phonetic skeleton so Roman-Urdu spellings meet: "Ayesha"≈"Aisha", "Muneeb"≈"Munib" */
function skel(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z ]/g, ' ')
    .replace(/ph/g, 'f').replace(/kh/g, 'k').replace(/gh/g, 'g').replace(/sh/g, 's').replace(/ch/g, 'c')
    .replace(/th/g, 't').replace(/dh/g, 'd').replace(/q/g, 'k').replace(/z/g, 'j').replace(/w/g, 'v')
    .replace(/ee|ii|ie|ey/g, 'i').replace(/oo|uu|ou/g, 'u').replace(/aa/g, 'a').replace(/y/g, 'i')
    .replace(/h\b/g, '').replace(/(.)\1+/g, '$1')
    .replace(/\s+/g, ' ').trim();
}
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const ratio = (a, b) => (!a || !b ? 0 : 1 - lev(a, b) / Math.max(a.length, b.length));
/** consonants only — Urdu script drops most vowels ("عائشہ" → "aysh" ≈ "Ayesha") */
const cons = (s) => String(s || '').replace(/[aeiou ]/g, '');

/** all contiguous word windows (1..maxN words) of the utterance */
function windows(text, maxN = 4) {
  const w = text.split(' ').filter(Boolean);
  const out = [];
  for (let n = 1; n <= maxN; n++) for (let i = 0; i + n <= w.length; i++) out.push({ s: w.slice(i, i + n).join(' '), i, n });
  return out;
}

/**
 * Best person match: each person has keys (name without titles, aliases). A window of
 * the utterance matches when its phonetic skeleton is close to a key; a key of 2+
 * words also matches on its distinctive words (first + last name).
 */
function matchPerson(text, people, opts = {}) {
  const min = opts.min || 0.8;
  const wins = windows(text, 4).map((x) => ({ ...x, k: skel(x.s.replace(TITLES, ' ')) })).filter((x) => x.k.replace(/ /g, '').length >= 3);
  const scored = [];
  for (const p of people) {
    let best = 0; let hit = null;
    for (const key of p.keys) {
      const kk = skel(key.replace(TITLES, ' '));
      if (!kk || kk.replace(/ /g, '').length < 3) continue;
      const kw = kk.split(' ').length;
      for (const x of wins) {
        if (Math.abs(x.n - kw) > 1) continue;
        let r = ratio(x.k.replace(/ /g, ''), kk.replace(/ /g, ''));
        const cx = cons(x.k); const ck = cons(kk);
        if (opts.urdu && cx.length >= 3 && ck.length >= 3) r = Math.max(r, ratio(cx, ck) * 0.92);
        if (x.n < kw && kw >= 2) r *= 0.93;                 // said only part of the name
        if (r > best) { best = r; hit = x.s; }
      }
      // one distinctive word (≥5 letters) said alone: "Khola", "Nazabat"
      for (const part of kk.split(' ')) {
        if (part.length < 5) continue;
        for (const x of wins) if (x.n === 1) {
          let r = ratio(x.k, part) * 0.9;
          if (opts.urdu && cons(x.k).length >= 3) r = Math.max(r, ratio(cons(x.k), cons(part)) * 0.86);
          if (r > best) { best = r; hit = x.s; }
        }
      }
    }
    if (best >= min) scored.push({ item: p, score: best, said: hit });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// ── intents ──────────────────────────────────────────────────────────────────
const RX = {
  duty: /\b(duty|duties|dooty|dyuti|duti|invigilat\w*|nigran\w*|ngrani|supervision|supervise)\b/,
  seat: /\b(seat|seats|sit|sitting|baith\w*|beth\w*|admit\s?card|admitcard|card|roll|kahan\s+(?:hai|he|ho))\b/,
  paper: /\b(paper|papers|exam|exams|imtihan|imtehan|imthan|test|parcha|parchay)\b/,
  when: /\b(kab|when|date|tareekh|tarikh|din|day|timing|time|waqt)\b/,
  where: /\b(kahan|kahaan|where|room|kamra|kamre|hall|venue)\b/,
  count: /\b(kitne|kitni|kitna|how many|how much|count|total|number of|tadad|tadaad)\b/,
  who: /\b(kaun|kon|who|kis|kin)\b/,
  section: /\b(section|sections|sec)\b/,
  fee: /\b(fee|fees|paid|unpaid|payment|challan)\b/,
  teach: /\b(parhat\w*|prhat\w*|padhat\w*|pdhat\w*|teaches|teaching|teacher of|ustad|teacher|course\w*|subject\w*)\b/,
  list: /\b(list|sab|saray|sare|saare|all|tamam|dikhao|show)\b/,
  datesheet: /\b(datesheet|date sheet|schedule|nizam)\b/,
  greet: /^(?:hi|hello|salam|salaam|assalam\w*|aoa|suno|sun lo|listen|kaise ho|kya haal)\b/,
  help: /\b(help|madad|kya kar sakt\w*|what can you)\b/,
};
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_ALIAS = { sun: 'sunday', mon: 'monday', peer: 'monday', somwar: 'monday', tue: 'tuesday', tues: 'tuesday', mangal: 'tuesday',
  wed: 'wednesday', budh: 'wednesday', bud: 'wednesday', thu: 'thursday', thur: 'thursday', thurs: 'thursday', jumerat: 'thursday', jumeraat: 'thursday',
  fri: 'friday', juma: 'friday', jumma: 'friday', jumah: 'friday', sat: 'saturday', hafta: 'saturday', hafte: 'saturday', itwar: 'sunday', itwaar: 'sunday' };
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

/** exam dates (ISO list) the utterance points at: "3 nov", "november 3", "3 tareekh", "tuesday", "aaj", "kal" */
function detectDates(text, examDates, today = new Date()) {
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const found = new Set();
  const year = examDates.length ? Number(examDates[0].slice(0, 4)) : today.getFullYear();
  const add = (dd, word) => {
    const mon = String(word).slice(0, 3);
    if (MONTHS[mon] === undefined || dd < 1 || dd > 31) return;
    found.add(iso(new Date(year, MONTHS[mon], dd)));
  };
  for (const m of text.matchAll(/\b(\d{1,2})\s*(?:of\s+)?([a-z]{3,9})\b/g)) add(Number(m[1]), m[2]);   // "3 november"
  for (const m of text.matchAll(/\b([a-z]{3,9})\s+(\d{1,2})\b/g)) add(Number(m[2]), m[1]);              // "november 3"
  const t = text.match(/\b(\d{1,2})\s*(?:tareekh|tarikh|date)\b|\b(?:tareekh|tarikh|date)\s*(\d{1,2})\b/);
  if (t && !found.size) {
    const dd = Number(t[1] || t[2]);
    for (const d of examDates) if (Number(d.slice(8, 10)) === dd) found.add(d);
  }
  if (/\baaj\b|\btoday\b/.test(text)) found.add(iso(today));
  if (/\bkal\b|\btomorrow\b/.test(text)) { const d = new Date(today); d.setDate(d.getDate() + 1); found.add(iso(d)); }
  for (const tok of text.split(' ')) {
    const day = DAYS.includes(tok) ? tok : DAY_ALIAS[tok];
    if (!day || (tok === 'sat' && /\b\d+\s+sat\b/.test(text))) continue;
    for (const d of examDates) if (DAYS[new Date(`${d}T00:00:00`).getDay()] === day) found.add(d);
  }
  return [...found].sort();
}

/** exam slot the utterance points at ("9 baje", "11", "1 bje", "teen baje", "subah") */
function detectSlot(text, slots) {
  const start = (s) => Number(String(s).split(':')[0]);
  let h = null;
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(?:baje|bje|bajay|oclock|o clock|am|pm)\b/) || text.match(/\b(?:at|ko)\s+(\d{1,2})(?::\d{2})?\b/);
  if (m) h = Number(m[1]);
  else if (/\bsubah\b|\bmorning\b/.test(text)) h = 9;
  else if (/\bdopahar\b|\bafternoon\b/.test(text)) h = 1;
  else if (/\bshaam\b|\bevening\b/.test(text)) h = 3;
  if (h == null) return null;
  const toMin = (x) => { const [a, b] = String(x).split(':').map(Number); return ((a < 8 ? a + 12 : a) * 60) + (b || 0); };
  const hm = (h < 8 ? h + 12 : h) * 60;
  return (slots || []).find((s) => start(s) === h)
    || (slots || []).find((s) => { const [a, b] = s.split('-'); return toMin(a) <= hm && hm < toMin(b); }) || null;
}

function detectCourse(text, courses) {
  // explicit code: letters + digits ("cs313", "mg403", "cs499ii")
  for (const m of text.matchAll(/\b([a-z]{2,6})(\d{3,4})([a-z]{0,2})\b/g)) {
    const code = (m[1] + m[2]).toUpperCase(); const full = (m[1] + m[2] + m[3]).toUpperCase();
    const hit = courses.find((c) => c.code === full) || courses.find((c) => c.code === code);
    if (hit) return { course: hit, score: 1, said: m[0] };
    // letters mis-heard ("see as 313" → digits match one code only)
    const byNum = courses.filter((c) => c.code.replace(/^[A-Z]+/, '') === m[2]);
    if (byNum.length === 1) return { course: byNum[0], score: 0.85, said: m[0] };
  }
  // by name (3+ letter words), longest good window
  let best = null;
  for (const x of windows(text, 6)) {
    if (x.s.length < 6) continue;
    const xs = skel(x.s);
    for (const c of courses) {
      const cn = skel(c.name);
      let r = ratio(xs, cn);
      // said the first words of a long title ("operating systems" → Operating Systems Concepts)
      if (r < 0.82 && x.n >= 2 && xs.length >= 10 && cn.startsWith(xs) && xs.length / cn.length >= 0.5) r = 0.84;
      if (r >= 0.82 && (!best || r > best.score || (r === best.score && x.n > best.n))) best = { course: c, score: r, said: x.s, n: x.n };
    }
  }
  return best;
}

function detectRoom(text, rooms) {
  const flat = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const r of rooms) {
    const f = flat(r);
    if (f.length >= 3 && text.replace(/\s/g, '').includes(f)) return { room: r, score: 1 };
  }
  const m = text.match(/\b([a-z])?\s?(\d{3})\b/);
  if (m) {
    const hits = rooms.filter((r) => (String(r).match(/\d{3}/) || [])[0] === m[2] && (!m[1] || flat(r).startsWith(m[1])));
    if (hits.length === 1 && (/\b(room|kamra|hall|j|i)\b/.test(text) || m[1])) return { room: hits[0], score: 0.95 };
  }
  for (const [kw, rx] of [['auditorium', /\baud\w*/], ['main hall', /\bmain\s?hall\w*|\bhall b\b/], ['gp1', /\bgp\s?1\b/], ['gp2', /\bgp\s?2\b/]]) {
    if (rx.test(text)) { const r = rooms.find((x) => flat(x).includes(flat(kw))); if (r) return { room: r, score: 0.95 }; }
  }
  return null;
}

/**
 * Parse one transcript against the knowledge base.
 * kb = { teachers:[{name, keys}], students:[{sid,name,keys}], courses:[{code,name}], rooms:[], examDates:[], slots:[] }
 */
function detect(raw, kb, opts = {}) {
  const text = normalize(raw);
  const r = { raw, text, intent: null, confidence: 0 };
  for (const [k, rx] of Object.entries(RX)) r[`kw_${k}`] = rx.test(text);
  const LET = { a: 'A', ay: 'A', ae: 'A', e: 'A', b: 'B', bi: 'B', bee: 'B', c: 'C', si: 'C', see: 'C', d: 'D', di: 'D', dee: 'D' };
  const sec = text.match(/\bsection\s+(a|ay|ae|b|bi|bee|c|si|see|d|di|dee)\b|\b(a|b|c|d|bi|si|di)\s+section\b/);
  if (sec) r.section = LET[sec[1] || sec[2]];

  // a student by registration number (3-6 digits not used as a room/date)
  const roomHit = detectRoom(text, kb.rooms || []);
  if (roomHit) r.room = roomHit.room;
  const course = detectCourse(text, kb.courses || []);
  if (course) r.course = course.course;
  const dates = detectDates(text, kb.examDates || [], opts.today);
  if (dates.length) r.dates = dates;
  const slot = detectSlot(text, kb.slots || []);
  if (slot) r.slot = slot;

  const nums = [...text.matchAll(/\b(\d{3,6})\b/g)].map((m) => m[1]);
  const sidHit = nums.find((n) => (kb.studentIds || new Set()).has(n) && !(r.room && String(r.room).includes(n)) && !(r.course && r.course.code.includes(n)));
  if (sidHit) r.student = (kb.studentById || new Map()).get(sidHit);

  // people: teachers always; students by name only when the question is about a student
  const urdu = hasUrdu(raw);
  const t = matchPerson(text, kb.teachers || [], { min: 0.8, urdu });
  if (t.length) { r.teacher = t[0].item; r.teacherScore = t[0].score; r.teacherAlts = t.slice(0, 4).map((x) => x.item.name); }
  const studentAsk = /\b(student|bacha|bache|bachay|larka|larki|ki seat|ka seat|ki card|admitcard)\b/.test(text) || r.kw_seat || r.kw_fee;
  if (!r.student && studentAsk && (kb.students || []).length) {
    const s = matchPerson(text, kb.students, { min: 0.86, urdu });
    if (s.length && (!r.teacher || s[0].score > r.teacherScore + 0.04)) { r.student = s[0].item; r.studentScore = s[0].score; r.studentAlts = s.slice(0, 4).map((x) => `${x.item.sid} ${x.item.name}`); }
  }

  // decide the intent
  const I = (name, c) => { r.intent = name; r.confidence = c; return r; };
  if (!text && String(raw || '').trim()) return I('greet', 0.8);   // only the wake word / a hello
  if (r.kw_greet && !r.teacher && !r.course && !r.student && !r.room && !dates.length && text.split(' ').length <= 4) return I('greet', 0.9);
  if (r.kw_help && !r.teacher && !r.course && !r.student) return I('help', 0.9);
  if (r.kw_count && !r.teacher && !r.student && !r.course && !r.room) return I('count', 0.85);
  if (r.student) return I(r.kw_fee ? 'student_fee' : 'student', sidHit ? 0.97 : r.studentScore || 0.85);
  if (r.teacher && (r.kw_duty || (!r.course && !r.kw_teach && !r.kw_paper))) return I('teacher_duty', r.teacherScore);
  if (r.teacher && (r.kw_paper || r.kw_teach || r.kw_when)) return I('teacher_courses', r.teacherScore);
  const teacherWord = /\b(teacher|ustad|parhat\w*|prhat\w*|padhat\w*|teaches|teaching)\b/.test(text);
  if (r.course && ((teacherWord && !r.kw_when && !r.kw_where) || (r.kw_who && (r.section || teacherWord)))) return I('course_teacher', course.score);
  if (r.course) return I('course', course.score);
  if (r.room) return I('room', 0.9);
  if (dates.length) return I('date', 0.85);
  if (r.kw_duty) return I('duty_overview', 0.6);
  if (r.kw_datesheet || r.kw_paper) return I('datesheet_overview', 0.55);
  return I(null, 0);
}

/** the most confident parse among the recognizer's alternatives */
function best(alternatives, kb, opts) {
  const list = [...new Set((alternatives || []).map((a) => String(a || '').trim()).filter(Boolean))];
  let top = null;
  list.forEach((a, i) => {
    const p = detect(a, kb, opts);
    const score = (p.intent ? p.confidence : 0) - i * 0.015;   // earlier alternatives are the engine's own favourites
    if (!top || score > top.score) top = { ...p, score };
  });
  return top || detect('', kb, opts);
}

module.exports = { normalize, urduToLatin, wordsToDigits, skel, ratio, matchPerson, detect, best, detectDates, detectSlot, detectCourse, detectRoom, hasUrdu };
