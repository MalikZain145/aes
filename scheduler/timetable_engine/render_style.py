"""
Styled export — the OFFICIAL AUIC timetable layout (same as "AUIC UNDERGRADUATE
TIMETABLE"): reads timetable.json and writes Timetable_styled.pdf + Timetable_styled.xlsx.

Layout (US Letter landscape):
  • cream header band with orange border: "ABASYN UNIVERSITY, ISLAMABAD CAMPUS" (green),
    "UNDERGRADUATE TIMETABLE - FALL SEMESTER 2026" (purple), Abasyn logo on the right
  • per day: a time-slot header row (green for the first day, light blue after), a grey
    Break column, the day row with every class of that slot centred, one per line, as
        CODE (SEC)-ABBR-TEACHER [ROOM]          e.g.  CS200-OOP-MS [I-108]
    coloured by department, and a lab sub-row (labs are added later)
  • "Color Coding" legend at the end; common courses in bold black
One run → BS (Undergraduate) then MS (Postgraduate), each with its own header band.
The engine and timetable.json are untouched — this only re-renders.

Usage (in the run folder):  python render_style.py
"""
import json, re, os, collections

# ── colours / fonts taken from the official PDF ────────────────────────────────
BAND = '#FFF2CC'; ORANGE = '#FF9900'; HEAD1 = '#DBFBD8'; HEADN = '#E1EAFF'; GREY = '#D9D9D9'
TITLE = '#3B6828'; SUBTITLE = '#351C75'
DEPTS = collections.OrderedDict([
    ('common', ('Common Courses', '#000000')),
    ('cs', ('Computer Science', '#00B050')),
    ('ee', ('Electrical Engineering', '#BF8F00')),
    ('civil', ('Civil Engineering', '#0070C0')),
    ('mgmt', ('Management & MC', '#EE0000')),
    ('mlt', ('Microbiology/MLT', '#984806')),
    ('psy', ('PSY', '#E36C09')),
    ('eng', ('ENG', '#C00000')),
    ('pharm', ('Pharm D', '#0000FF')),
    ('dpt', ('DPT', '#FF33CC')),
    ('hnd', ('HND/RT/OT/VS', '#002060')),
])
PROGRAM_RULES = [   # programme text → department (first match wins)
    ('dpt', r'physical\s*therap|\bdpt\b'),
    ('pharm', r'pharm'),
    ('hnd', r'nutrition|dietetic|\bhnd\b|radiolog|imaging|operation\s*theat|\bott?\b|vision|optometr|surg|anesth|respirat|cardi'),
    ('mlt', r'medical\s*lab|\bmlt\b|microbio|biotech|biochem'),
    ('psy', r'psycholog'),
    ('eng', r'english'),
    ('mgmt', r'business|\bbba\b|\bmba\b|management|media|communication|commerce|accounting|account|econom|finance'),
    ('cs', r'computer|software|artificial|data\s*science|information\s*tech|cyber'),
    ('ee', r'electric|electronic'),
    ('civil', r'civil|construct'),
]
PREFIX_DEPT = {   # fallback when a class has no student list: course-code prefix
    'CS': 'cs', 'SE': 'cs', 'AI': 'cs', 'DS': 'cs', 'IT': 'cs',
    'EE': 'ee', 'ELC': 'ee', 'ELT': 'ee', 'ET': 'ee', 'ELQ': 'ee', 'ELI': 'ee',
    'CE': 'civil', 'CET': 'civil', 'CT': 'civil', 'CM': 'civil', 'TCT': 'civil', 'TET': 'civil',
    'MG': 'mgmt', 'MC': 'mgmt', 'LT': 'mlt', 'MB': 'mlt', 'PSY': 'psy', 'ENG': 'eng',
    'PD': 'pharm', 'DP': 'dpt', 'HN': 'hnd', 'RT': 'hnd', 'OT': 'hnd', 'VS': 'hnd', 'SU': 'hnd',
}


def _prefix(code):
    m = re.match(r'[A-Za-z]+', str(code or ''))
    return m.group(0).upper() if m else ''


def dept_of_program(p):
    t = str(p or '').lower()
    for k, rx in PROGRAM_RULES:
        if re.search(rx, t):
            return k
    return None


def dept_of(e):
    """department of a class = the programme most of its students come from; a class
    shared by several departments (no department >= 70 %) is a COMMON course."""
    cnt = collections.Counter()
    for c in e.get('cohorts') or []:
        m = re.match(r'(.*?)\s*\((\d+)\)\s*$', str(c))
        prog, n = (m.group(1), int(m.group(2))) if m else (str(c), 1)
        d = dept_of_program(prog.split('|')[0])
        if d:
            cnt[d] += n
    if cnt:
        top, n = cnt.most_common(1)[0]
        if len(cnt) > 1 and n < 0.7 * sum(cnt.values()):
            return 'common'
        return top
    return PREFIX_DEPT.get(_prefix(e.get('course_code')), 'common')


# ── the class line: CODE (SEC)-ABBR-TEACHER [ROOM] ─────────────────────────────
ROMAN = {'I', 'II', 'III', 'IV', 'V', 'VI'}
SMALL = {'of', 'the', 'in', 'for', 'a', 'an', 'on', 'with', 'at', 'by'}


def abbr(title):
    t = re.sub(r'\(.*?\)', ' ', str(title or ''))
    t = t.replace('&', ' & ').replace('/', ' / ')
    words = [w for w in re.split(r'[\s\-–,:]+', t) if w]
    if not words:
        return ''
    suffix = ''
    if words[-1].upper() in ROMAN:
        suffix = '-' + words.pop().upper()
    elif re.fullmatch(r'\d+', words[-1]) and len(words) > 1:
        suffix = '-' + words.pop()
    core = [w for w in words if w.lower() not in SMALL]
    if not core:
        core = words
    if len(core) == 1:
        w = core[0]
        return (w if len(w) <= 9 else w[:7]) + suffix
    out = ''
    for w in core:
        if w in ('&', '/'):
            out += w
        elif w.lower() == 'and':
            out += '&'
        elif re.fullmatch(r'\d+', w):
            out += w
        else:
            out += w[0].upper()
    return out + suffix


def teacher_initials(name):
    n = str(name or '').strip()
    if not n or n.upper() in ('TBA', 'NONE', 'NULL', 'NO TEACHER', 'N/A', '-'):
        return 'TBA'
    n = re.sub(r'^[A-Z]{2,4}-\d+\s*-\s*', '', n)
    dr = bool(re.match(r'^\s*(dr|prof)\b\.?', n, re.I))
    n = re.sub(r'\b(mr|ms|mrs|miss|dr|engr|prof|sir|madam)\b\.?', ' ', n, flags=re.I)
    parts = [p for p in re.split(r'[\s.]+', n) if p and p[0].isalpha()]
    ini = ''.join(p[0].upper() for p in parts)[:4] or 'TBA'
    return ('Dr' + ini) if dr else ini


def short_room(name):
    """'Auditorium (J-205)' → 'J-205', 'Main Hall-B(J-Block)' → 'Main Hall-B' (as on the official sheet)"""
    n = str(name or '').strip()
    m = re.search(r'\(([A-Z]-\d+[A-Z]?)\)', n)
    if m:
        return m.group(1)
    return re.sub(r'\s*\(.*?\)\s*', '', n).strip() or n


def line_for(e, multi):
    code = e.get('course_code', '')
    sec = e.get('section', '')
    secp = f' ({sec})' if multi and sec else ''
    return f"{code}{secp}-{abbr(e.get('course_title', ''))}-{teacher_initials(e.get('teacher'))} [{short_room(e.get('room', ''))}]"


def ampm(hhmm):
    m = re.match(r'(\d{1,2}):(\d{2})', str(hhmm or ''))
    if not m:
        return str(hhmm)
    h, mi = int(m.group(1)), m.group(2)
    if 1 <= h <= 7:
        h += 12
    suf = 'pm' if h >= 12 else 'am'
    h12 = h - 12 if h > 12 else h
    return f'{h12:02d}:{mi}{suf}'


def slot_label(s):
    a, b = (str(s).split('-') + [''])[:2]
    return f'{ampm(a)} - {ampm(b)}'


def term_title(term):
    """'Fall 2026' → 'FALL SEMESTER 2026'"""
    t = str(term or '').strip()
    m = re.match(r'^([A-Za-z]+)\s+(\d{4})$', t)
    return f'{m.group(1).upper()} SEMESTER {m.group(2)}' if m else t.upper()


LEVEL_NAME = {'BS': 'UNDERGRADUATE', 'MS': 'POSTGRADUATE'}


def prepare(data):
    """per timetable: days, slots, break index, cells[(day, slot)] = [(text, dept)]."""
    out = []
    tmap = data.get('timetables', {})
    order = [n for n in ('BS', 'MS') if n in tmap] + [n for n in tmap if n not in ('BS', 'MS')]
    for name in order:
        t = tmap[name]
        E = t.get('entries') or []
        if not E:
            continue
        nsec = collections.defaultdict(set)
        for e in E:
            nsec[e.get('course_code')].add(e.get('section'))
        cells = collections.defaultdict(list)
        for e in E:
            d = dept_of(e)
            cells[(e['day'], e['slot_index'])].append((line_for(e, len(nsec[e.get('course_code')]) > 1), d, e))
        for k in cells:
            # grouped by department (as in the official sheet), then course code
            cells[k].sort(key=lambda x: (list(DEPTS).index(x[1]), x[2].get('course_code', ''), x[2].get('section', '')))
        ba = t.get('break_after_slot', 2 if name == 'BS' else -1)
        out.append({'name': name, 'days': t.get('days', []), 'slots': t.get('slots', []), 'break': ba, 'cells': cells})
    return out


# ─────────────────────────────────────────────────────────── PDF (reportlab)
def _fonts():
    """Trebuchet MS (the official sheet's font) when the machine has it, else Helvetica."""
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    cands = [('C:/Windows/Fonts/trebuc.ttf', 'C:/Windows/Fonts/trebucbd.ttf'),
             ('/usr/share/fonts/truetype/msttcorefonts/trebuc.ttf', '/usr/share/fonts/truetype/msttcorefonts/trebucbd.ttf'),
             ('/usr/share/fonts/truetype/msttcorefonts/Trebuchet_MS.ttf', '/usr/share/fonts/truetype/msttcorefonts/Trebuchet_MS_Bold.ttf'),
             ('/Library/Fonts/Trebuchet MS.ttf', '/Library/Fonts/Trebuchet MS Bold.ttf')]
    for reg, bold in cands:
        if os.path.exists(reg) and os.path.exists(bold):
            try:
                pdfmetrics.registerFont(TTFont('Trebuchet', reg))
                pdfmetrics.registerFont(TTFont('Trebuchet-Bold', bold))
                return 'Trebuchet', 'Trebuchet-Bold'
            except Exception:
                pass
    return 'Helvetica', 'Helvetica-Bold'


def build_pdf(data, out_path, logo=None):
    from reportlab.lib.pagesizes import landscape, letter
    from reportlab.lib import colors
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, Flowable, PageBreak, KeepTogether
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.enums import TA_CENTER, TA_LEFT
    from reportlab.pdfbase.pdfmetrics import stringWidth

    REG, BOLD = _fonts()
    PAGE = landscape(letter)                       # 792 x 612, as the official sheet
    LM, RM, TM, BM = 20, 24, 13, 18
    TW = 748                                       # table width (20 → 768)
    BAND_W, BAND_H = 753, 48
    term = term_title(data.get('term', ''))
    C = colors.HexColor

    class Band(Flowable):
        def __init__(self, sub):
            super().__init__(); self.sub = sub; self.width, self.height = BAND_W, BAND_H
        def wrap(self, aw, ah):
            return BAND_W, BAND_H
        def draw(self):
            c = self.canv
            c.setFillColor(C(BAND)); c.setStrokeColor(C(ORANGE)); c.setLineWidth(1)
            c.rect(0, 0, BAND_W, BAND_H, fill=1, stroke=1)
            c.setFillColor(C(TITLE)); c.setFont(BOLD, 16)
            c.drawString(7, BAND_H - 20, 'ABASYN UNIVERSITY, ISLAMABAD CAMPUS')
            c.setFillColor(C(SUBTITLE)); c.setFont(BOLD, 12)
            c.drawString(7, BAND_H - 38, self.sub)
            if logo and os.path.exists(logo):
                try:
                    c.drawImage(logo, 637.75, BAND_H - 45.5, width=82.5, height=36, preserveAspectRatio=True, mask='auto')
                except Exception:
                    pass

    hstyle = ParagraphStyle('h', fontName=BOLD, fontSize=12, leading=14, alignment=TA_CENTER)
    dstyle = ParagraphStyle('d', fontName=BOLD, fontSize=12, leading=14, alignment=TA_CENTER)

    def cell_par(items, width, size):
        st = ParagraphStyle('c', fontName=REG, fontSize=size, leading=size * 1.22, alignment=TA_CENTER)
        html = []
        for text, dept, _ in items:
            col = DEPTS[dept][1]
            esc = text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
            if dept == 'common':
                html.append(f"<font name='{BOLD}' color='{col}'>{esc}</font>")
            else:
                html.append(f"<font color='{col}'>{esc}</font>")
        return Paragraph('<br/>'.join(html) or '&nbsp;', st)

    def lines_needed(items, width, size):
        n = 0
        for text, dept, _ in items:
            w = stringWidth(text, BOLD if dept == 'common' else REG, size)
            n += max(1, int(w // (width - 6)) + 1)
        return n

    story = []
    for ti, tt in enumerate(prepare(data)):
        if ti:
            story.append(PageBreak())
        story.append(Band(f"{LEVEL_NAME.get(tt['name'], tt['name'])} TIMETABLE - {term}"))
        slots = tt['slots']; ba = tt['break']
        cols = []                                  # ('slot', i) / ('break', None)
        for i in range(len(slots)):
            cols.append(('slot', i))
            if ba is not None and ba >= 0 and i == ba and i != len(slots) - 1:
                cols.append(('break', None))
        DAYW, BRKW = 64, 51
        nslot = len(slots)
        slotw = (TW - DAYW - (BRKW if any(c[0] == 'break' for c in cols) else 0)) / max(1, nslot)
        widths = [DAYW] + [BRKW if c[0] == 'break' else slotw for c in cols]
        bi = next((k + 1 for k, c in enumerate(cols) if c[0] == 'break'), None)
        avail = PAGE[1] - TM - BM - 60             # one day row must fit on a page
        for di, day in enumerate(tt['days']):
            per = {i: tt['cells'].get((day, i), []) for i in range(nslot)}
            size = 8.0
            while size > 5.2 and max([lines_needed(v, slotw, size) for v in per.values()] + [0]) * size * 1.22 + 12 > avail:
                size -= 0.4
            head = [''] + [Paragraph('Break' if c[0] == 'break' and di == 0 else ('' if c[0] == 'break' else slot_label(slots[c[1]])), hstyle) for c in cols]
            row = [Paragraph(str(day).upper()[:3], dstyle)] + ['' if c[0] == 'break' else cell_par(per[c[1]], slotw, size) for c in cols]
            lab = [''] + ['' for _ in cols]
            data_rows = [head, row, lab]
            hh = 48 if di == 0 else 28
            tbl = Table(data_rows, colWidths=widths, rowHeights=[hh, None, 26])
            st = [
                ('GRID', (1, 0), (-1, -1), 1, C(ORANGE)),
                ('BOX', (0, 0), (-1, -1), 1, C(ORANGE)),
                ('LINEBEFORE', (1, 0), (1, -1), 1, C(ORANGE)),
                ('LINEBELOW', (0, -1), (-1, -1), 1, C(ORANGE)),
                ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
                ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
                ('LEFTPADDING', (0, 0), (-1, -1), 2), ('RIGHTPADDING', (0, 0), (-1, -1), 2),
                ('SPAN', (0, 1), (0, 2)),                              # day label spans class + lab rows
                ('BACKGROUND', (1, 0), (-1, 0), C(HEAD1 if di == 0 else HEADN)),
                ('LINEABOVE', (0, 0), (0, 0), 0, colors.white),
            ]
            if di == 0:
                st.append(('LINEBEFORE', (0, 0), (0, 0), 0, colors.white))
            if bi is not None:
                st += [('BACKGROUND', (bi, 1 if di == 0 else 0), (bi, -1), C(GREY)), ('SPAN', (bi, 1), (bi, 2))]
                if di == 0:
                    st.append(('BACKGROUND', (bi, 0), (bi, 0), C(HEAD1)))
                if bi > 2:
                    st.append(('SPAN', (1, 2), (bi - 1, 2)))         # lab row: morning block
                if bi < len(widths) - 2:
                    st.append(('SPAN', (bi + 1, 2), (len(widths) - 1, 2)))   # lab row: afternoon block
            tbl.setStyle(TableStyle(st))
            story.append(KeepTogether([tbl]))     # a day's header never sits alone at a page end
    # legend
    leg_h = ParagraphStyle('lh', fontName='Times-Bold', fontSize=14, leading=17)
    leg = ParagraphStyle('l', fontName='Times-Roman', fontSize=12, leading=15)
    items = [Spacer(1, 10), Paragraph('Color Coding', leg_h)]
    for k, (label, col) in DEPTS.items():
        items.append(Paragraph(f"<font name='Times-Bold' color='{col}'>{label}</font>" if k == 'common'
                               else f"<font color='{col}'>{label.replace('&', '&amp;')}</font>", leg))
    story.append(KeepTogether(items))
    if len(story) <= 1:
        story = [Paragraph('No timetable to display.', ParagraphStyle('x', fontSize=12))]
    doc = SimpleDocTemplate(out_path, pagesize=PAGE, leftMargin=LM, rightMargin=RM, topMargin=TM, bottomMargin=BM,
                            title='AUIC Timetable', author='Abasyn University Islamabad Campus')
    doc.build(story)


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
    hx = lambda c: c.replace('#', '').upper()
    o = Side(style='thin', color=hx(ORANGE))
    box = Border(left=o, right=o, top=o, bottom=o)
    center = Alignment(horizontal='center', vertical='center', wrap_text=True)
    fill = lambda c: PatternFill('solid', fgColor=hx(c))
    term = term_title(data.get('term', ''))

    wb = openpyxl.Workbook(); wb.remove(wb.active)
    for tt in prepare(data):
        ws = wb.create_sheet(tt['name'])
        slots = tt['slots']; ba = tt['break']
        cols = []
        for i in range(len(slots)):
            cols.append(('slot', i))
            if ba is not None and ba >= 0 and i == ba and i != len(slots) - 1:
                cols.append(('break', None))
        ncol = 1 + len(cols)
        ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=ncol)
        ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=ncol)
        a = ws.cell(row=1, column=1, value='ABASYN UNIVERSITY, ISLAMABAD CAMPUS')
        a.font = Font(name='Trebuchet MS', bold=True, size=16, color=hx(TITLE))
        b = ws.cell(row=2, column=1, value=f"{LEVEL_NAME.get(tt['name'], tt['name'])} TIMETABLE - {term}")
        b.font = Font(name='Trebuchet MS', bold=True, size=12, color=hx(SUBTITLE))
        for r in (1, 2):
            for c in range(1, ncol + 1):
                ws.cell(row=r, column=c).fill = fill(BAND)
        if logo and os.path.exists(logo):
            try:
                from openpyxl.drawing.image import Image as XLImage
                img = XLImage(logo); img.height = 44; img.width = 108
                ws.add_image(img, f'{get_column_letter(ncol)}1')
            except Exception:
                pass
        ws.row_dimensions[1].height = 24; ws.row_dimensions[2].height = 20
        r = 3
        bcol = next((k + 2 for k, c in enumerate(cols) if c[0] == 'break'), None)
        for di, day in enumerate(tt['days']):
            for ci, c in enumerate(cols, start=2):
                cell = ws.cell(row=r, column=ci, value=('Break' if di == 0 else '') if c[0] == 'break' else slot_label(slots[c[1]]))
                cell.font = Font(name='Trebuchet MS', bold=True, size=12); cell.alignment = center; cell.border = box
                cell.fill = fill(GREY if (c[0] == 'break' and di) else (HEAD1 if di == 0 else HEADN))
            ws.cell(row=r, column=1).border = box
            ws.row_dimensions[r].height = 36 if di == 0 else 22
            r += 1
            dc = ws.cell(row=r, column=1, value=str(day).upper()[:3])
            dc.font = Font(name='Trebuchet MS', bold=True, size=12); dc.alignment = center; dc.border = box
            ws.merge_cells(start_row=r, start_column=1, end_row=r + 1, end_column=1)
            maxn = 1
            for ci, c in enumerate(cols, start=2):
                cell = ws.cell(row=r, column=ci); cell.alignment = center; cell.border = box
                if c[0] == 'break':
                    cell.fill = fill(GREY); continue
                items = tt['cells'].get((day, c[1]), [])
                maxn = max(maxn, len(items))
                if not items:
                    continue
                if RICH:
                    rt = CellRichText()
                    for j, (text, dept, _) in enumerate(items):
                        if j:
                            rt.append('\n')
                        rt.append(TextBlock(InlineFont(rFont='Trebuchet MS', sz=8, b=(dept == 'common'), color='FF' + hx(DEPTS[dept][1])), text))
                    cell.value = rt
                else:
                    cell.value = '\n'.join(t for t, _, _ in items); cell.font = Font(size=8)
            ws.row_dimensions[r].height = min(409, 12 + 11 * maxn)
            r += 1
            # lab sub-row (labs are added later)
            for ci, c in enumerate(cols, start=2):
                cell = ws.cell(row=r, column=ci); cell.border = box
                if c[0] == 'break':
                    cell.fill = fill(GREY)
            if bcol:
                if bcol > 3:
                    ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=bcol - 1)
                if bcol < ncol - 1:
                    ws.merge_cells(start_row=r, start_column=bcol + 1, end_row=r, end_column=ncol)
                ws.merge_cells(start_row=r - 1, start_column=bcol, end_row=r, end_column=bcol)
            ws.row_dimensions[r].height = 20
            r += 2
        ws.column_dimensions['A'].width = 9
        for ci, c in enumerate(cols, start=2):
            ws.column_dimensions[get_column_letter(ci)].width = 7 if c[0] == 'break' else 30
        # legend
        ws.cell(row=r, column=1, value='Color Coding').font = Font(name='Times New Roman', bold=True, size=14)
        for k, (label, col) in DEPTS.items():
            r += 1
            ws.cell(row=r, column=1, value=label).font = Font(name='Times New Roman', size=12, bold=(k == 'common'), color=hx(col))
        ws.sheet_view.showGridLines = False
        ws.page_setup.orientation = 'landscape'; ws.page_setup.paperSize = ws.PAPERSIZE_LETTER
        ws.page_setup.fitToWidth = 1; ws.page_setup.fitToHeight = 0
        ws.sheet_properties.pageSetUpPr.fitToPage = True
    if not wb.sheetnames:
        wb.create_sheet('Timetable').cell(row=1, column=1, value='No timetable to display.')
    wb.save(out_path)


if __name__ == '__main__':
    data = json.loads(open('timetable.json', encoding='utf-8').read())
    logo = next((p for p in ('abasyn_logo.png', 'logo.png') if os.path.exists(p)), None)
    build_pdf(data, 'Timetable_styled.pdf', logo)
    build_xlsx(data, 'Timetable_styled.xlsx', logo)
    print('styled outputs written')
