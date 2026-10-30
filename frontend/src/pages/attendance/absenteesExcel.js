/**
 * "Export Absentees" workbook — built in the browser (xlsx-js-style) from
 * GET /api/attendance/absentees. Sheets:
 *   1 Summary       overall totals + course-wise and room-wise totals (grand total rows)
 *   2 All Absentees every absent student of every paper, in exam order + total
 *   3 Course-wise   one block per course: its absent students + subtotal, grand total
 *   4 Room-wise     one block per room: its absent students + subtotal, grand total
 *   5 Date-wise     absentees per exam day / time + total
 */
import * as XLSX from 'xlsx-js-style';

const GREEN = '0F5132'; const HEAD = '14663F'; const ALT = 'F2F8F5'; const SOFT = 'E2F3EC'; const RED = '9C1C1C';
const B = { style: 'thin', color: { rgb: 'B9CFC2' } };
const BOX = { top: B, bottom: B, left: B, right: B };
const S = {
  title: { font: { bold: true, sz: 15, color: { rgb: GREEN } } },
  sub: { font: { bold: true, sz: 11, color: { rgb: '444444' } } },
  note: { font: { italic: true, sz: 9, color: { rgb: '6C757D' } } },
  block: { font: { bold: true, sz: 11.5, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: GREEN } }, alignment: { vertical: 'center' } },
  th: { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: HEAD } }, border: BOX, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } },
  td: { border: BOX, alignment: { vertical: 'center' } },
  tdc: { border: BOX, alignment: { horizontal: 'center', vertical: 'center' } },
  alt: { border: BOX, fill: { fgColor: { rgb: ALT } }, alignment: { vertical: 'center' } },
  altc: { border: BOX, fill: { fgColor: { rgb: ALT } }, alignment: { horizontal: 'center', vertical: 'center' } },
  sum: { font: { bold: true, color: { rgb: GREEN } }, fill: { fgColor: { rgb: SOFT } }, border: BOX },
  grand: { font: { bold: true, sz: 12, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: RED } }, border: BOX },
};
const pct = (a, t) => (t ? `${((a / t) * 100).toFixed(1)}%` : '0.0%');
const timeLabel = (slot) => {
  const fmt = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); if (!m) return t; let h = Number(m[1]); if (h >= 1 && h <= 7) h += 12; return `${((h + 11) % 12) + 1}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`; };
  const [a, b] = String(slot || '').split('-'); return `${fmt(a)} – ${fmt(b)}`;
};

/** A sheet writer: rows are added top-down with a style per cell, widths auto-fit. */
function Sheet(ncol) {
  const aoa = []; const styles = []; const merges = [];
  const api = {
    row(vals, st, opts = {}) {
      const r = aoa.length;
      aoa.push(vals.map((v) => (v == null ? '' : v)));
      styles.push(vals.map((_, i) => (Array.isArray(st) ? st[i] : st)));
      if (opts.merge) merges.push({ s: { r, c: 0 }, e: { r, c: ncol - 1 } });
      return api;
    },
    blank() { aoa.push([]); styles.push([]); return api; },
    header(title, sub) {
      api.row(['ABASYN UNIVERSITY ISLAMABAD CAMPUS'], S.title, { merge: true });
      api.row([title], S.sub, { merge: true });
      if (sub) api.row([sub], S.note, { merge: true });
      return api.blank();
    },
    table(cols, rows, center = []) {
      api.row(cols, S.th);
      rows.forEach((vals, i) => api.row(vals, vals.map((_, c) => (i % 2 ? (center.includes(c) ? S.altc : S.alt) : (center.includes(c) ? S.tdc : S.td)))));
      return api;
    },
    build(widths) {
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      styles.forEach((rs, r) => rs.forEach((st, c) => { const a = XLSX.utils.encode_cell({ r, c }); if (st && ws[a]) ws[a].s = st; }));
      ws['!merges'] = merges;
      ws['!cols'] = widths.map((w) => ({ wch: w }));
      return ws;
    },
  };
  return api;
}

const STUDENT_COLS = ['S.No', 'Reg No', 'Student Name', 'Degree / Batch', 'Sec', 'Seat'];

export function buildAbsenteesWorkbook(data, { levelLabel = 'All students', preparedBy = '' } = {}) {
  const { papers = [], absentees = [] } = data;
  const wb = XLSX.utils.book_new();
  const sub = `${levelLabel} · generated ${data.generatedAt || ''} (PKT)${preparedBy ? ` · by ${preparedBy}` : ''}`;
  const totalSP = papers.reduce((n, p) => n + p.total, 0);
  const totalP = papers.reduce((n, p) => n + p.present, 0);
  const totalA = absentees.length;
  const uniqStudents = new Set(absentees.map((a) => a.studentId)).size;

  // ── aggregates ──
  const byCourse = new Map(); const byRoom = new Map(); const byDate = new Map();
  for (const p of papers) {
    if (!byCourse.has(p.code)) byCourse.set(p.code, { code: p.code, name: p.courseName, total: 0, present: 0, absent: 0, sittings: new Set(), rooms: new Set() });
    const c = byCourse.get(p.code); c.total += p.total; c.present += p.present; c.absent += p.absent; c.sittings.add(`${p.dateDisp} ${timeLabel(p.slot)}`); c.rooms.add(p.room);
    if (!byRoom.has(p.room)) byRoom.set(p.room, { room: p.room, total: 0, present: 0, absent: 0, papers: 0 });
    const r = byRoom.get(p.room); r.total += p.total; r.present += p.present; r.absent += p.absent; r.papers++;
    const dk = `${p.date}|${p.slot}`;
    if (!byDate.has(dk)) byDate.set(dk, { date: p.date, dateDisp: p.dateDisp, day: p.day, slot: p.slot, total: 0, present: 0, absent: 0, codes: new Set() });
    const d = byDate.get(dk); d.total += p.total; d.present += p.present; d.absent += p.absent; d.codes.add(p.code);
  }
  const courses = [...byCourse.values()].sort((a, b) => a.code.localeCompare(b.code));
  const rooms = [...byRoom.values()].sort((a, b) => String(a.room).localeCompare(String(b.room), undefined, { numeric: true }));
  const mins = (slot) => { const m = String(slot || '').match(/(\d{1,2}):(\d{2})/); if (!m) return 0; let h = Number(m[1]); if (h >= 1 && h <= 7) h += 12; return h * 60 + Number(m[2]); };
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date) || mins(a.slot) - mins(b.slot));

  // 1 ── Summary
  {
    const sh = Sheet(6).header('Mid Term Examination — Absentee Report (Summary)', sub);
    sh.row(['Overall'], S.block, { merge: true });
    sh.table(['Exam days', 'Papers (course · room)', 'Students expected', 'Present', 'Absent', 'Absent %'],
      [[new Set(papers.map((p) => p.date)).size, papers.length, totalSP, totalP, totalA, pct(totalA, totalSP)]], [0, 1, 2, 3, 4, 5]);
    sh.row(['Different students absent at least once', '', '', '', uniqStudents, ''], [S.sum, S.sum, S.sum, S.sum, S.sum, S.sum]);
    sh.blank().row(['Course-wise'], S.block, { merge: true });
    sh.table(['Course', 'Course Name', 'Expected', 'Present', 'Absent', 'Absent %'],
      courses.map((c) => [c.code, c.name, c.total, c.present, c.absent, pct(c.absent, c.total)]), [0, 2, 3, 4, 5]);
    sh.row(['GRAND TOTAL', `${courses.length} courses`, totalSP, totalP, totalA, pct(totalA, totalSP)], S.grand);
    sh.blank().row(['Room-wise'], S.block, { merge: true });
    sh.table(['Room', 'Papers held', 'Expected', 'Present', 'Absent', 'Absent %'],
      rooms.map((r) => [r.room, r.papers, r.total, r.present, r.absent, pct(r.absent, r.total)]), [0, 1, 2, 3, 4, 5]);
    sh.row(['GRAND TOTAL', papers.length, totalSP, totalP, totalA, pct(totalA, totalSP)], S.grand);
    XLSX.utils.book_append_sheet(wb, sh.build([16, 44, 16, 12, 12, 12]), 'Summary');
  }

  // 2 ── All Absentees
  {
    const sh = Sheet(12).header('All Absentees — every paper, every room', sub);
    sh.table(['S.No', 'Date', 'Day', 'Time', 'Course', 'Course Name', 'Room', 'Seat', 'Reg No', 'Student Name', 'Degree / Batch', 'Sec / Note'],
      absentees.map((a, i) => [i + 1, a.dateDisp, a.day, timeLabel(a.slot), a.code, a.courseName, a.room, a.seat, a.studentId, a.name, a.batch || a.program, [a.section, a.note].filter(Boolean).join(' · ')]),
      [0, 1, 2, 3, 4, 6, 7, 8]);
    sh.row(['TOTAL ABSENTEES', '', '', '', '', '', '', '', '', totalA, `${uniqStudents} different students`, ''], S.grand);
    XLSX.utils.book_append_sheet(wb, sh.build([6, 13, 11, 18, 10, 36, 16, 7, 11, 28, 40, 18]), 'All Absentees');
  }

  // 3 ── Course-wise
  {
    const sh = Sheet(6).header('Absentees — Course-wise', sub);
    for (const c of courses) {
      const list = absentees.filter((a) => a.code === c.code);
      sh.row([`${c.code} — ${c.name}   ·   ${[...c.sittings].join(' / ')}   ·   Rooms: ${[...c.rooms].join(', ')}`], S.block, { merge: true });
      if (list.length) {
        sh.table(['S.No', 'Room', 'Seat', 'Reg No', 'Student Name', 'Degree / Batch'],
          list.map((a, i) => [i + 1, a.room, a.seat, a.studentId, `${a.name}${a.section ? ` (Sec ${a.section})` : ''}`, a.batch || a.program]), [0, 1, 2, 3]);
      } else sh.row(['No absentee in this course'], S.note, { merge: true });
      sh.row([`Absent in ${c.code}`, '', '', `${c.absent} of ${c.total}`, `Present ${c.present}`, `Absent ${pct(c.absent, c.total)}`], S.sum);
      sh.blank();
    }
    sh.row(['GRAND TOTAL', `${courses.length} courses`, '', `${totalA} of ${totalSP}`, `Present ${totalP}`, `Absent ${pct(totalA, totalSP)}`], S.grand);
    XLSX.utils.book_append_sheet(wb, sh.build([12, 18, 8, 14, 34, 44]), 'Course-wise');
  }

  // 4 ── Room-wise
  {
    const sh = Sheet(8).header('Absentees — Room-wise', sub);
    for (const r of rooms) {
      const list = absentees.filter((a) => a.room === r.room);
      sh.row([`${r.room}   ·   ${r.papers} paper${r.papers > 1 ? 's' : ''} held`], S.block, { merge: true });
      if (list.length) {
        sh.table(['S.No', 'Date', 'Time', 'Course', 'Seat', 'Reg No', 'Student Name', 'Degree / Batch'],
          list.map((a, i) => [i + 1, a.dateDisp, timeLabel(a.slot), a.code, a.seat, a.studentId, a.name, a.batch || a.program]), [0, 1, 2, 3, 4, 5]);
      } else sh.row(['No absentee in this room'], S.note, { merge: true });
      sh.row([`Absent in ${r.room}`, '', '', '', '', `${r.absent} of ${r.total}`, `Present ${r.present}`, `Absent ${pct(r.absent, r.total)}`], S.sum);
      sh.blank();
    }
    sh.row(['GRAND TOTAL', `${rooms.length} rooms`, '', '', '', `${totalA} of ${totalSP}`, `Present ${totalP}`, `Absent ${pct(totalA, totalSP)}`], S.grand);
    XLSX.utils.book_append_sheet(wb, sh.build([8, 13, 18, 10, 7, 14, 30, 44]), 'Room-wise');
  }

  // 5 ── Date-wise
  {
    const sh = Sheet(7).header('Absentees — Date-wise', sub);
    sh.table(['Date', 'Day', 'Time', 'Courses', 'Expected', 'Present', 'Absent'],
      days.map((d) => [d.dateDisp, d.day, timeLabel(d.slot), [...d.codes].sort().join(', '), d.total, d.present, d.absent]), [0, 1, 2, 4, 5, 6]);
    sh.row(['GRAND TOTAL', '', `${days.length} sittings`, '', totalSP, totalP, totalA], S.grand);
    XLSX.utils.book_append_sheet(wb, sh.build([13, 11, 18, 60, 11, 11, 11]), 'Date-wise');
  }
  return wb;
}

export function downloadAbsentees(data, opts) {
  const wb = buildAbsenteesWorkbook(data, opts);
  const tag = opts && opts.fileTag ? `_${opts.fileTag}` : '';
  XLSX.writeFile(wb, `Absentees_MidTerm${tag}_${String(data.generatedAt || '').slice(0, 10)}.xlsx`);
}
