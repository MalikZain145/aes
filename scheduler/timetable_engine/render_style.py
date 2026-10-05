"""
Styled export (AUIC house style) — reads timetable.json (+ config.json) and writes
Timetable_styled.pdf and Timetable_styled.xlsx in the official Abasyn layout:
landscape day x time-slot grid, cream header band + green slot headers + gray Break
column, orange outer border, department-coloured class lines. One page/sheet per
level (BS, MS). Labs are not scheduled yet, so a "Labs are currently unavailable"
note is shown. The engine + timetable.json are untouched — this only re-renders.

Usage (in the run folder):  python render_style.py
"""
import json, re, os, collections

CREAM = '#FFF1CC'; GREEN = '#DAFAD8'; ORANGE = '#E69138'; GRAYBRK = '#C9C9C9'
MAROON = '#7B1113'; INK = '#12261C'
PALETTE = ['#1F3A93', '#1E7145', '#C0392B', '#7D3C98', '#B9770E', '#0E6655',
           '#A93226', '#2874A6', '#BA4A00', '#6C3483', '#117A65', '#884EA0', '#1A5276']
LAB_NOTE = 'Labs are currently unavailable'

def dept_of(code):
    m = re.match(r'^[A-Za-z]+', str(code) or ''); return (m.group(0).upper() if m else 'X')
def color_for(code):
    d = dept_of(code); return PALETTE[sum(ord(c) for c in d) % len(PALETTE)]

def line_for(e):
    code = e.get('course_code', ''); sec = e.get('section', '')
    secp = f' ({sec})' if sec else ''
    teacher = e.get('teacher', 'TBA') or 'TBA'
    room = e.get('room', ''); tag = e.get('tag', '')
    tagp = f' {tag}' if tag else ''
    return f"{code}{secp}-{e.get('course_title','')}-{teacher} [{room}]{tagp}"

def display_columns(spec):
    """slot labels with a Break inserted after break_after_slot (index into slots)."""
    slots = spec.get('slots', []); ba = spec.get('break_after_slot', -1)
    cols = []  # list of (kind, label, slot_index)
    for i, s in enumerate(slots):
        cols.append(('slot', s, i))
        if ba is not None and ba >= 0 and i == ba:
            cols.append(('break', 'Break', None))
    return cols

def grid(entries):
    g = collections.defaultdict(list)
    for e in entries:
        g[(e['day'], e['slot_index'])].append(e)
    for k in g:
        g[k].sort(key=lambda e: (e.get('room', ''), e.get('course_code', '')))
    return g

# ─────────────────────────────────────────────────────────── PDF (reportlab)
def build_pdf(data, out_path, logo=None):
    from reportlab.lib.pagesizes import landscape, A4
    from reportlab.lib import colors
    from reportlab.lib.units import cm
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, Image
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.enums import TA_CENTER, TA_LEFT

    from reportlab.platypus import PageBreak
    PAGE = landscape(A4); W, H = PAGE
    content_w = PAGE[0] - 1.4 * cm
    term = data.get('term', '')
    cell_st = ParagraphStyle('cell', fontName='Helvetica', fontSize=5.7, leading=6.9, alignment=TA_CENTER, textColor=colors.HexColor(INK))
    hslot = ParagraphStyle('hslot', fontName='Helvetica-Bold', fontSize=8, alignment=TA_CENTER, textColor=colors.HexColor(INK))
    daylbl = ParagraphStyle('day', fontName='Helvetica-Bold', fontSize=10, alignment=TA_CENTER, textColor=colors.HexColor(INK))
    brk = ParagraphStyle('brk', fontName='Helvetica-Bold', fontSize=7.5, alignment=TA_CENTER, textColor=colors.HexColor('#555555'))

    tmap = data.get('timetables', {})
    order = [n for n in ('BS', 'MS') if n in tmap] + [n for n in tmap if n not in ('BS', 'MS')]
    pages = []   # (name, day) — one page each, matching the reference (a day per page)
    for name in order:
        if not tmap[name].get('entries'):
            continue
        for d in tmap[name].get('days', []):
            pages.append((name, d))

    # header drawn in the top margin of EVERY page (never orphaned, always with its grid)
    def draw_header(canvas, docu):
        idx = min(max(docu.page - 1, 0), len(pages) - 1) if pages else 0
        name = pages[idx][0] if pages else ''
        x = docu.leftMargin; w = W - docu.leftMargin - docu.rightMargin
        hh = 1.3 * cm; y = H - 0.35 * cm - hh
        canvas.saveState()
        canvas.setFillColor(colors.HexColor(CREAM)); canvas.setStrokeColor(colors.HexColor(ORANGE)); canvas.setLineWidth(1.4)
        canvas.rect(x, y, w, hh, fill=1, stroke=1)
        canvas.setFillColor(colors.HexColor(INK)); canvas.setFont('Helvetica-Bold', 11)
        canvas.drawString(x + 9, y + hh - 14, 'ABASYN UNIVERSITY, ISLAMABAD CAMPUS')
        canvas.setFillColor(colors.HexColor(MAROON)); canvas.setFont('Helvetica-Bold', 10)
        canvas.drawString(x + 9, y + hh - 26, f'{name} TIMETABLE — {term.upper()}')
        canvas.setFillColor(colors.HexColor('#C0392B')); canvas.setFont('Helvetica-BoldOblique', 7.5)
        canvas.drawString(x + 9, y + hh - 36, LAB_NOTE)
        if logo and os.path.exists(logo):
            try: canvas.drawImage(logo, x + w - 2.4 * cm, y + 4, width=2.2 * cm, height=hh - 8, preserveAspectRatio=True, mask='auto')
            except Exception: pass
        canvas.restoreState()

    doc = SimpleDocTemplate(out_path, pagesize=PAGE, leftMargin=0.7 * cm, rightMargin=0.7 * cm,
                            topMargin=1.5 * cm, bottomMargin=0.5 * cm, title='AUIC Timetable')
    story = []
    for pi, (name, d) in enumerate(pages):
        t = tmap[name]
        spec = {'slots': t.get('slots', []), 'break_after_slot': t.get('break_after_slot', (2 if name == 'BS' else -1)), 'days': t.get('days', [])}
        cols = display_columns(spec); g = grid(t['entries'])
        n = len(cols); daycol = 1.2 * cm
        brk_w = 1.1 * cm; nbrk = sum(1 for c in cols if c[0] == 'break')
        slot_w = (content_w - daycol - brk_w * nbrk) / max(1, (n - nbrk))
        widths = [daycol] + [brk_w if c[0] == 'break' else slot_w for c in cols]

        head_row = [Paragraph('', hslot)] + [Paragraph(c[1], hslot if c[0] == 'slot' else brk) for c in cols]
        row = [Paragraph(d, daylbl)]
        for c in cols:
            if c[0] == 'break':
                row.append(Paragraph('Prayer &amp;<br/>Lunch<br/>Break', brk))
            else:
                items = g.get((d, c[2]), [])
                html = '<br/>'.join(f"<font color='{color_for(e.get('course_code',''))}'>{_esc(line_for(e))}</font>" for e in items)
                row.append(Paragraph(html or '&nbsp;', cell_st))
        tbl = Table([head_row, row], colWidths=widths)
        style = [
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor(GREEN)),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#D9C9A0')),
            ('BOX', (0, 0), (-1, -1), 1.4, colors.HexColor(ORANGE)),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
            ('LEFTPADDING', (0, 0), (-1, -1), 2), ('RIGHTPADDING', (0, 0), (-1, -1), 2),
        ]
        for ci, c in enumerate(cols, start=1):
            if c[0] == 'break':
                style.append(('BACKGROUND', (ci, 1), (ci, 1), colors.HexColor(GRAYBRK)))
        tbl.setStyle(TableStyle(style))
        story.append(tbl)
        if pi != len(pages) - 1:
            story.append(PageBreak())
    if not story:
        story.append(Paragraph('No timetable to display.', ParagraphStyle('x', fontSize=12)))
    doc.build(story, onFirstPage=draw_header, onLaterPages=draw_header)

def _esc(s):
    return str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

# ─────────────────────────────────────────────────────────── Excel (openpyxl)
def build_xlsx(data, out_path, logo=None):
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter
    try:
        from openpyxl.cell.rich_text import CellRichText, TextBlock
        from openpyxl.cell.text import InlineFont
        RICH = True
    except Exception:
        RICH = False
    hx = lambda c: c.replace('#', '')
    thin = Side(style='thin', color='D9C9A0'); orange = Side(style='medium', color=hx(ORANGE))
    box = Border(left=orange, right=orange, top=orange, bottom=orange)
    grid_b = Border(left=thin, right=thin, top=thin, bottom=thin)
    center = Alignment(horizontal='center', vertical='center', wrap_text=True)

    wb = openpyxl.Workbook(); wb.remove(wb.active)
    tmap = data.get('timetables', {})
    order = [n for n in ('BS', 'MS') if n in tmap] + [n for n in tmap if n not in ('BS', 'MS')]
    for name in order:
        t = tmap[name]
        if not t.get('entries'): continue
        spec = {'slots': t.get('slots', []), 'break_after_slot': t.get('break_after_slot', (2 if name == 'BS' else -1)), 'days': t.get('days', [])}
        cols = display_columns(spec); days = spec['days']; g = grid(t['entries'])
        ws = wb.create_sheet(name)
        ncol = 1 + len(cols)
        # header band
        ws.merge_cells(start_row=1, start_column=1, end_row=2, end_column=ncol)
        h = ws.cell(row=1, column=1, value=f"ABASYN UNIVERSITY, ISLAMABAD CAMPUS\n{name} TIMETABLE — {data.get('term','').upper()}   ·   {LAB_NOTE}")
        h.font = Font(bold=True, size=12, color=hx(MAROON)); h.alignment = Alignment(horizontal='left', vertical='center', wrap_text=True)
        for c in range(1, ncol + 1):
            ws.cell(row=1, column=c).fill = PatternFill('solid', fgColor=hx(CREAM))
            ws.cell(row=2, column=c).fill = PatternFill('solid', fgColor=hx(CREAM))
        # slot header row (row 3)
        hr = 3
        ws.cell(row=hr, column=1, value='').fill = PatternFill('solid', fgColor=hx(GREEN))
        for ci, c in enumerate(cols, start=2):
            cell = ws.cell(row=hr, column=ci, value=c[1])
            cell.font = Font(bold=True, size=10); cell.alignment = center
            cell.fill = PatternFill('solid', fgColor=hx(GRAYBRK) if c[0] == 'break' else hx(GREEN))
            cell.border = grid_b
        ws.cell(row=hr, column=1).border = grid_b
        # day rows
        r = hr + 1
        for d in days:
            dc = ws.cell(row=r, column=1, value=d); dc.font = Font(bold=True, size=11); dc.alignment = center; dc.border = grid_b
            for ci, c in enumerate(cols, start=2):
                cell = ws.cell(row=r, column=ci); cell.alignment = center; cell.border = grid_b
                if c[0] == 'break':
                    cell.value = 'Prayer & Lunch Break'; cell.fill = PatternFill('solid', fgColor=hx(GRAYBRK))
                    continue
                items = g.get((d, c[2]), [])
                if not items: cell.value = ''
                elif RICH:
                    rt = CellRichText()
                    for j, e in enumerate(items):
                        if j: rt.append('\n')
                        rt.append(TextBlock(InlineFont(color='FF' + hx(color_for(e.get('course_code', ''))), sz=8), line_for(e)))
                    cell.value = rt
                else:
                    cell.value = '\n'.join(line_for(e) for e in items); cell.font = Font(size=8)
            r += 1
        # widths + border box
        ws.column_dimensions['A'].width = 8
        for ci, c in enumerate(cols, start=2):
            ws.column_dimensions[get_column_letter(ci)].width = 8 if c[0] == 'break' else 34
        ws.row_dimensions[1].height = 40
        ws.freeze_panes = ws.cell(row=hr + 1, column=2)
    if not wb.sheetnames:
        wb.create_sheet('Timetable').cell(row=1, column=1, value='No timetable to display.')
    wb.save(out_path)

if __name__ == '__main__':
    data = json.loads(open('timetable.json', encoding='utf-8').read())
    logo = 'logo.png' if os.path.exists('logo.png') else None
    build_pdf(data, 'Timetable_styled.pdf', logo)
    build_xlsx(data, 'Timetable_styled.xlsx', logo)
    print('styled outputs written')
