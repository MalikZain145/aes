/**
 * Client-side Excel (.xlsx) and PDF export with a formatted Abasyn header.
 * Every file — whichever view — carries the same letterhead:
 *   Abasyn University Islamabad Campus
 *   Abasyn University Examination System
 *   Prepared by <admin> · <date> <time>
 *   <heading>
 * …then the formatted table(s). Excel styling via xlsx-js-style; PDF via jsPDF.
 */
import * as XLSX from 'xlsx-js-style';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

const GREEN = '0F5132';
const MID = '198754';
const GREY = '6C757D';
const ROW_ALT = 'F2F8F5';
const BRAND = [15, 81, 50];
const BRAND_MID = [25, 135, 84];
const BRAND_SOFT = [226, 243, 236];

const safe = (s) => String(s == null ? '' : s);
const stampDateTime = () =>
  new Date().toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

const THIN = {
  top: { style: 'thin', color: { rgb: 'CBD5E0' } },
  bottom: { style: 'thin', color: { rgb: 'CBD5E0' } },
  left: { style: 'thin', color: { rgb: 'CBD5E0' } },
  right: { style: 'thin', color: { rgb: 'CBD5E0' } },
};

/**
 * Build one styled worksheet with the Abasyn letterhead + one or more table
 * blocks. sheet: { name, columns, rows } (single table) OR
 *              { name, blocks:[{title, columns, rows}] } (stacked tables).
 */
function makeSheet(sheet, header) {
  const blocks = sheet.blocks || [{ columns: sheet.columns, rows: sheet.rows }];
  const ncol = Math.max(1, ...blocks.map((b) => b.columns.length));

  const aoa = [
    ['Abasyn University Islamabad Campus'],
    ['Abasyn University Examination System'],
    [`Prepared by ${header.admin || 'Admin'}  ·  ${stampDateTime()}`],
    [header.heading || ''],
    [],
  ];
  const put = (ws, addr, s) => { if (ws[addr]) ws[addr].s = s; };
  const styleSpots = [];   // {r, kind, ...}

  for (const b of blocks) {
    if (b.title) { styleSpots.push({ r: aoa.length, kind: 'blocktitle' }); aoa.push([b.title]); }
    styleSpots.push({ r: aoa.length, kind: 'thead', ncol: b.columns.length });
    aoa.push(b.columns.map((c) => c.label));
    for (const row of b.rows) {
      const isTotal = /total|utilization|day /i.test(String(row[b.columns[0].key]));
      styleSpots.push({ r: aoa.length, kind: 'trow', ncol: b.columns.length, isTotal, alt: b.rows.indexOf(row) % 2 === 1 });
      aoa.push(b.columns.map((c) => safe(r_get(row, c.key))));
    }
    aoa.push([]);            // spacer between blocks
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = [0, 1, 2, 3].map((r) => ({ s: { r, c: 0 }, e: { r, c: ncol - 1 } }));
  styleSpots.filter((s) => s.kind === 'blocktitle').forEach((s) =>
    (ws['!merges'].push({ s: { r: s.r, c: 0 }, e: { r: s.r, c: ncol - 1 } })));

  // column widths
  ws['!cols'] = Array.from({ length: ncol }, (_, i) => {
    let w = 10;
    for (const b of blocks) {
      if (b.columns[i]) w = Math.max(w, String(b.columns[i].label).length);
      for (const row of b.rows) if (b.columns[i]) w = Math.max(w, String(safe(r_get(row, b.columns[i].key))).length);
    }
    return { wch: Math.min(w + 2, 60) };
  });
  ws['!rows'] = [{ hpt: 21 }, { hpt: 16 }, { hpt: 14 }, { hpt: 19 }, { hpt: 6 }];

  put(ws, 'A1', { font: { bold: true, sz: 15, color: { rgb: GREEN } }, alignment: { horizontal: 'center' } });
  put(ws, 'A2', { font: { bold: true, sz: 11, color: { rgb: MID } }, alignment: { horizontal: 'center' } });
  put(ws, 'A3', { font: { sz: 9, color: { rgb: GREY } }, alignment: { horizontal: 'center' } });
  put(ws, 'A4', { font: { bold: true, sz: 12, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: MID } }, alignment: { horizontal: 'center' } });

  for (const s of styleSpots) {
    if (s.kind === 'blocktitle') {
      put(ws, XLSX.utils.encode_cell({ r: s.r, c: 0 }), { font: { bold: true, sz: 11, color: { rgb: GREEN } }, fill: { fgColor: { rgb: 'DCEFE5' } } });
    } else if (s.kind === 'thead') {
      for (let c = 0; c < s.ncol; c++) put(ws, XLSX.utils.encode_cell({ r: s.r, c }), {
        font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: GREEN } },
        alignment: { horizontal: 'center', vertical: 'center' }, border: THIN,
      });
    } else if (s.kind === 'trow') {
      for (let c = 0; c < s.ncol; c++) put(ws, XLSX.utils.encode_cell({ r: s.r, c }), {
        border: THIN, alignment: { vertical: 'center', horizontal: c === 0 ? 'left' : 'center' },
        font: s.isTotal ? { bold: true, color: { rgb: GREEN } } : undefined,
        fill: s.isTotal ? { fgColor: { rgb: 'E8F2EC' } } : (s.alt ? { fgColor: { rgb: ROW_ALT } } : undefined),
      });
    }
  }
  return ws;
}
const r_get = (row, key) => (row && key in row ? row[key] : '');

/**
 * Export one or more sheets to a styled .xlsx workbook with the Abasyn header.
 * sheets: [{ name, columns, rows }]; header: { admin, heading }
 */
export function exportExcel(sheets, filename, header = {}) {
  const wb = XLSX.utils.book_new();
  const used = new Set();
  for (const sheet of sheets) {
    let name = (sheet.name || 'Sheet').slice(0, 31);
    let n = name; let i = 2;
    while (used.has(n)) { n = `${name.slice(0, 28)} ${i++}`; }
    used.add(n);
    XLSX.utils.book_append_sheet(wb, makeSheet(sheet, header), n);
  }
  XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
}

/** Draw the Abasyn letterhead band on a jsPDF doc; returns the y to start below. */
function pdfHeader(doc, header) {
  const pageW = doc.internal.pageSize.getWidth();
  doc.setFillColor(...BRAND);
  doc.rect(0, 0, pageW, 60, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
  doc.text('Abasyn University Islamabad Campus', pageW / 2, 22, { align: 'center' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5);
  doc.text('Abasyn University Examination System', pageW / 2, 38, { align: 'center' });
  doc.setFontSize(8);
  doc.text(`Prepared by ${header.admin || 'Admin'}  ·  ${stampDateTime()}`, pageW / 2, 51, { align: 'center' });
  let y = 60;
  if (header.heading) {
    doc.setFillColor(...BRAND_MID);
    doc.rect(0, y, pageW, 20, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5);
    doc.text(header.heading, pageW / 2, y + 14, { align: 'center' });
    y += 20;
  }
  return y + 12;
}

/**
 * Export table section(s) to a landscape PDF with the Abasyn letterhead.
 * Accepts either a single {columns, rows} or `sections: [{title, columns, rows}]`.
 */
export function exportPDF({ columns, rows, sections, heading, admin, filename, subtitle }) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  let y = pdfHeader(doc, { admin, heading: heading || subtitle });

  const secs = sections || [{ columns, rows }];
  for (const sec of secs) {
    if (sec.title) {
      doc.setTextColor(...BRAND); doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5);
      doc.text(sec.title, 26, y + 2);
      y += 10;
    }
    autoTable(doc, {
      startY: y,
      head: [sec.columns.map((c) => c.label)],
      body: sec.rows.map((r) => sec.columns.map((c) => safe(r[c.key]))),
      styles: { fontSize: 7.5, cellPadding: 3, overflow: 'linebreak', valign: 'middle' },
      headStyles: { fillColor: BRAND, textColor: 255, fontStyle: 'bold', fontSize: 8 },
      alternateRowStyles: { fillColor: BRAND_SOFT },
      // bold/tint the total & utilization rows
      didParseCell: (d) => {
        if (d.section === 'body' && /total|utilization|day /i.test(String(d.row.raw[0]))) {
          d.cell.styles.fontStyle = 'bold'; d.cell.styles.fillColor = [232, 242, 236]; d.cell.styles.textColor = BRAND;
        }
      },
      margin: { left: 24, right: 24 },
      didDrawPage: () => {
        doc.setFontSize(7); doc.setTextColor(120);
        doc.text(`Page ${doc.internal.getNumberOfPages()}`, pageW - 32, doc.internal.pageSize.getHeight() - 12, { align: 'right' });
      },
    });
    y = doc.lastAutoTable.finalY + 18;
  }
  doc.save(filename.endsWith('.pdf') ? filename : `${filename}.pdf`);
}
