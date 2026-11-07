"""
Exam attendance workbooks (Excel) with summary tables and native Excel charts.

    python attendance_export.py <input.json> <output.xlsx>

input.json:
  {
    "type": "absent" | "present" | "all",
    "heading": "Mid Term Examination Fall 2026",
    "levelLabel": "All students (BS + MS)",
    "generatedAt": "2026-11-07 18:40",
    "preparedBy": "examcell",
    "rows": [ { "date": "2026-11-05", "dateDisp": "05-Nov-2026", "day": "Thursday",
                "slot": "09:00-10:30", "code": "CS101", "courseName": "...",
                "section": "A", "room": "R-101", "seat": "12A",
                "studentId": "...", "name": "...", "program": "...", "batch": "...",
                "status": "P" | "A" | "N", "note": "" }, ... ]
  }

status: P = present (scanned / marked P), A = absent (paper over, not scanned / marked A),
N = not yet held (the paper has not ended and no scan yet).

Sheets
  Summary      overall totals + course-wise, date-wise and room-wise tables + charts
  Course-wise  one block per course: its students (reg no, name, ...) + subtotal; grand total
  List         every student-paper of this file in exam order + totals (filterable)
"""
import json
import re
import sys

from openpyxl import Workbook
from openpyxl.chart import BarChart, PieChart, Reference
from openpyxl.chart.label import DataLabelList
from openpyxl.chart.series import DataPoint
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

GREEN = "0F5132"
HEAD = "14663F"
ALT = "F2F8F5"
SOFT = "E2F3EC"
RED = "9C1C1C"
P_FILL = "D1E7DD"
A_FILL = "F8D7DA"
N_FILL = "E9ECEF"
C_PRESENT = "2E8B57"
C_ABSENT = "C0392B"

thin = Side(style="thin", color="B9CFC2")
BOX = Border(top=thin, bottom=thin, left=thin, right=thin)
F_TITLE = Font(bold=True, size=15, color=GREEN)
F_SUB = Font(bold=True, size=11, color="444444")
F_NOTE = Font(italic=True, size=9, color="6C757D")
F_WHITE = Font(bold=True, color="FFFFFF")
F_BLOCK = Font(bold=True, size=11.5, color="FFFFFF")
F_SUM = Font(bold=True, color=GREEN)
F_GRAND = Font(bold=True, size=12, color="FFFFFF")
FILL = lambda c: PatternFill("solid", fgColor=c)
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
LEFT = Alignment(horizontal="left", vertical="center", wrap_text=False)
WRAP = Alignment(horizontal="left", vertical="center", wrap_text=True)

STATUS_TEXT = {"P": "Present", "A": "Absent", "N": "Not yet held"}
STATUS_FILL = {"P": P_FILL, "A": A_FILL, "N": N_FILL}


def minutes(t):
    m = re.search(r"(\d{1,2}):(\d{2})", str(t or ""))
    if not m:
        return 0
    h = int(m.group(1))
    if 1 <= h <= 7:
        h += 12
    return h * 60 + int(m.group(2))


def time_label(slot):
    def fmt(t):
        m = re.search(r"(\d{1,2}):(\d{2})", str(t or ""))
        if not m:
            return str(t or "")
        h = int(m.group(1))
        if 1 <= h <= 7:
            h += 12
        return f"{(h + 11) % 12 + 1}:{m.group(2)} {'PM' if h >= 12 else 'AM'}"
    parts = str(slot or "").split("-")
    return f"{fmt(parts[0])} – {fmt(parts[1] if len(parts) > 1 else '')}"


def seat_key(seat):
    m = re.search(r"(\d+)\s*([A-Za-z]?)", str(seat or ""))
    if not m:
        return 999999
    return int(m.group(1)) * 10 + (1 if m.group(2) else 0)


def room_key(room):
    return [int(x) if x.isdigit() else x.lower() for x in re.split(r"(\d+)", str(room or ""))]


def pct(a, t):
    return (a / t) if t else None


class Writer:
    """Top-down writer for one sheet."""

    def __init__(self, ws, ncol):
        self.ws = ws
        self.ncol = ncol
        self.r = 1

    def merged(self, text, font=None, fill=None, height=None, align=LEFT):
        c = self.ws.cell(row=self.r, column=1, value=text)
        if font:
            c.font = font
        if fill:
            for k in range(1, self.ncol + 1):
                self.ws.cell(row=self.r, column=k).fill = fill
        c.alignment = align
        self.ws.merge_cells(start_row=self.r, start_column=1, end_row=self.r, end_column=self.ncol)
        if height:
            self.ws.row_dimensions[self.r].height = height
        self.r += 1

    def header(self, title, sub):
        self.merged("ABASYN UNIVERSITY ISLAMABAD CAMPUS", F_TITLE, height=22)
        self.merged(title, F_SUB)
        if sub:
            self.merged(sub, F_NOTE)
        self.r += 1

    def th(self, cols):
        for k, v in enumerate(cols, 1):
            c = self.ws.cell(row=self.r, column=k, value=v)
            c.font = F_WHITE
            c.fill = FILL(HEAD)
            c.border = BOX
            c.alignment = CENTER
        self.ws.row_dimensions[self.r].height = 20
        self.r += 1
        return self.r - 1

    def tr(self, vals, i, center=(), fmt=None, fills=None):
        for k, v in enumerate(vals, 1):
            c = self.ws.cell(row=self.r, column=k, value=v)
            c.border = BOX
            c.alignment = CENTER if (k - 1) in center else LEFT
            if i % 2:
                c.fill = FILL(ALT)
            if fills and (k - 1) in fills:
                c.fill = FILL(fills[k - 1])
            if fmt and (k - 1) in fmt:
                c.number_format = fmt[k - 1]
        self.r += 1
        return self.r - 1

    def total(self, vals, grand=False, fmt=None):
        for k in range(1, self.ncol + 1):
            v = vals[k - 1] if k - 1 < len(vals) else None
            c = self.ws.cell(row=self.r, column=k, value=v)
            c.border = BOX
            c.font = F_GRAND if grand else F_SUM
            c.fill = FILL(RED if grand else SOFT)
            c.alignment = LEFT if k == 1 else CENTER
            if fmt and (k - 1) in fmt:
                c.number_format = fmt[k - 1]
        self.r += 1
        return self.r - 1

    def blank(self, n=1):
        self.r += n


def widths(ws, ws_widths):
    for k, w in enumerate(ws_widths, 1):
        ws.column_dimensions[get_column_letter(k)].width = w


def page_setup(ws, landscape=True):
    ws.page_setup.orientation = "landscape" if landscape else "portrait"
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.print_options.horizontalCentered = True
    ws.page_margins.left = ws.page_margins.right = 0.4


def build(data, out_path):
    kind = data.get("type") or "all"
    if kind not in ("absent", "present", "all"):
        kind = "all"
    rows = data.get("rows") or []
    for r in rows:
        r["status"] = r.get("status") if r.get("status") in ("P", "A", "N") else "N"
    rows.sort(key=lambda r: (r.get("date") or "", minutes(r.get("slot")), str(r.get("code") or ""),
                             room_key(r.get("room")), seat_key(r.get("seat"))))

    heading = data.get("heading") or "Examination"
    what = {"absent": "Absentees", "present": "Presentees", "all": "Attendance (all students)"}[kind]
    sub = " · ".join(x for x in [data.get("levelLabel"), f"generated {data.get('generatedAt', '')} (PKT)",
                                  f"by {data['preparedBy']}" if data.get("preparedBy") else ""] if x)

    shown = [r for r in rows if kind == "all" or (kind == "absent" and r["status"] == "A")
             or (kind == "present" and r["status"] == "P")]

    tot_exp = len(rows)
    tot_p = sum(1 for r in rows if r["status"] == "P")
    tot_a = sum(1 for r in rows if r["status"] == "A")
    tot_n = tot_exp - tot_p - tot_a
    held = tot_p + tot_a

    # aggregates (always over every student-paper, so each file shows the full picture)
    def agg(keyf, labf):
        m = {}
        for r in rows:
            k = keyf(r)
            if k not in m:
                m[k] = dict(labf(r), exp=0, p=0, a=0, n=0)
            m[k]["exp"] += 1
            m[k][{"P": "p", "A": "a", "N": "n"}[r["status"]]] += 1
        return m

    courses = agg(lambda r: r.get("code") or "",
                  lambda r: {"code": r.get("code") or "", "name": r.get("courseName") or ""})
    for c in courses.values():
        c["sittings"] = sorted({(r.get("date") or "", minutes(r.get("slot")), f"{r.get('dateDisp')} {time_label(r.get('slot'))}")
                                for r in rows if r.get("code") == c["code"]})
        c["rooms"] = sorted({str(r.get("room") or "") for r in rows if r.get("code") == c["code"]}, key=room_key)
    courses = sorted(courses.values(), key=lambda c: c["code"])
    days = sorted(agg(lambda r: (r.get("date") or "", minutes(r.get("slot"))),
                      lambda r: {"date": r.get("dateDisp") or r.get("date") or "", "day": r.get("day") or "",
                                 "time": time_label(r.get("slot"))}).items())
    days = [v for _, v in days]
    rooms = sorted(agg(lambda r: str(r.get("room") or ""), lambda r: {"room": str(r.get("room") or "")}).values(),
                   key=lambda x: room_key(x["room"]))
    uniq_abs = len({r.get("studentId") for r in rows if r["status"] == "A"})
    uniq_all = len({r.get("studentId") for r in rows})

    wb = Workbook()

    # ───────────── Summary ─────────────
    ws = wb.active
    ws.title = "Summary"
    W = Writer(ws, 7)
    W.header(f"{heading} — {what} (Summary)", sub)
    W.merged("Overall", F_BLOCK, FILL(GREEN))
    W.th(["Students (unique)", "Student-papers expected", "Present", "Absent", "Not yet held", "Attendance %", "Absent %"])
    ov_row = W.tr([uniq_all, tot_exp, tot_p, tot_a, tot_n, pct(tot_p, held), pct(tot_a, held)], 0,
                  center=range(7), fmt={5: "0.0%", 6: "0.0%"})
    W.total(["Different students absent at least once", "", "", uniq_abs])
    W.merged("Attendance % and Absent % are of papers already held (present + absent).", F_NOTE)
    W.blank()

    W.merged("Course-wise", F_BLOCK, FILL(GREEN))
    W.th(["Course", "Course Name", "Expected", "Present", "Absent", "Attendance %", "Absent %"])
    c_first = W.r
    for i, c in enumerate(courses):
        h = c["p"] + c["a"]
        W.tr([c["code"], c["name"], c["exp"], c["p"], c["a"], pct(c["p"], h), pct(c["a"], h)], i,
             center=(0, 2, 3, 4, 5, 6), fmt={5: "0.0%", 6: "0.0%"})
    c_last = W.r - 1
    W.total(["GRAND TOTAL", f"{len(courses)} courses", tot_exp, tot_p, tot_a, pct(tot_p, held), pct(tot_a, held)],
            grand=True, fmt={5: "0.0%", 6: "0.0%"})
    W.blank()

    W.merged("Date-wise", F_BLOCK, FILL(GREEN))
    W.th(["Date", "Day", "Time", "Expected", "Present", "Absent", "Attendance %"])
    d_first = W.r
    for i, d in enumerate(days):
        h = d["p"] + d["a"]
        W.tr([d["date"], d["day"], d["time"], d["exp"], d["p"], d["a"], pct(d["p"], h)], i,
             center=range(7), fmt={6: "0.0%"})
    d_last = W.r - 1
    W.total(["GRAND TOTAL", "", f"{len(days)} sittings", tot_exp, tot_p, tot_a, pct(tot_p, held)], grand=True, fmt={6: "0.0%"})
    W.blank()

    W.merged("Room-wise", F_BLOCK, FILL(GREEN))
    W.th(["Room", "", "", "Expected", "Present", "Absent", "Attendance %"])
    for i, rm in enumerate(rooms):
        h = rm["p"] + rm["a"]
        W.tr([rm["room"], "", "", rm["exp"], rm["p"], rm["a"], pct(rm["p"], h)], i, center=range(7), fmt={6: "0.0%"})
    W.total(["GRAND TOTAL", f"{len(rooms)} rooms", "", tot_exp, tot_p, tot_a, pct(tot_p, held)], grand=True, fmt={6: "0.0%"})
    widths(ws, [22, 44, 16, 13, 13, 14, 13])
    ws.freeze_panes = "A5"
    page_setup(ws, landscape=False)

    # ───────────── Charts ─────────────
    ch = wb.create_sheet("Charts")
    CW = Writer(ch, 12)
    CW.header(f"{heading} — {what} (Charts)", sub)
    anchor_row = CW.r

    def bar(title, ytitle, series, cats, stacked=False, colors=None, horizontal=False, height=9.0, width=24.0):
        b = BarChart()
        b.type = "bar" if horizontal else "col"
        b.title = title
        b.y_axis.title = ytitle
        b.height = height
        b.width = width
        b.legend.position = "b"
        if stacked:
            b.grouping = "stacked"
            b.overlap = 100
        for ref, color in zip(series, colors or [None] * len(series)):
            b.add_data(ref, titles_from_data=True)
            if color:
                s = b.series[-1]
                s.graphicalProperties.solidFill = color
                s.graphicalProperties.line.solidFill = color
        b.set_categories(cats)
        b.y_axis.majorGridlines = None
        b.y_axis.delete = False
        b.x_axis.delete = False
        return b

    pos = anchor_row
    if kind == "all" and held:
        pie = PieChart()
        pie.title = "Overall: present vs absent (papers held)"
        pie.add_data(Reference(ws, min_col=3, max_col=4, min_row=ov_row, max_row=ov_row), from_rows=True, titles_from_data=False)
        pie.set_categories(Reference(ws, min_col=3, max_col=4, min_row=ov_row - 1, max_row=ov_row - 1))
        s = pie.series[0]
        for idx, color in enumerate([C_PRESENT, C_ABSENT]):
            pt = DataPoint(idx=idx)
            pt.graphicalProperties.solidFill = color
            s.dPt.append(pt)
        pie.dataLabels = DataLabelList()
        pie.dataLabels.showPercent = True
        pie.dataLabels.showVal = True
        pie.dataLabels.showSerName = False
        pie.dataLabels.showCatName = False
        pie.dataLabels.showLegendKey = False
        pie.height, pie.width = 9.0, 14.0
        ch.add_chart(pie, f"A{pos}")
        pos += 20

    if courses:
        cats = Reference(ws, min_col=1, min_row=c_first, max_row=c_last)
        tall = max(9.0, 0.45 * len(courses) + 3)
        if kind == "all":
            b = bar("Course-wise attendance (present and absent)", "Student-papers",
                    [Reference(ws, min_col=4, min_row=c_first - 1, max_row=c_last),
                     Reference(ws, min_col=5, min_row=c_first - 1, max_row=c_last)],
                    cats, stacked=True, colors=[C_PRESENT, C_ABSENT], horizontal=True, height=tall)
        elif kind == "absent":
            b = bar("Absentees per course", "Absent students",
                    [Reference(ws, min_col=5, min_row=c_first - 1, max_row=c_last)], cats,
                    colors=[C_ABSENT], horizontal=True, height=tall)
        else:
            b = bar("Presentees per course", "Present students",
                    [Reference(ws, min_col=4, min_row=c_first - 1, max_row=c_last)], cats,
                    colors=[C_PRESENT], horizontal=True, height=tall)
        ch.add_chart(b, f"A{pos}")
        pos += int(tall * 2.1) + 2

    if days:
        cats = Reference(ws, min_col=1, min_row=d_first, max_row=d_last)
        if kind == "all":
            b = bar("Attendance % by examination sitting", "Attendance %",
                    [Reference(ws, min_col=7, min_row=d_first - 1, max_row=d_last)], cats, colors=[C_PRESENT])
            b.y_axis.number_format = "0%"
            b.y_axis.scaling.min = 0
            b.y_axis.scaling.max = 1
        elif kind == "absent":
            b = bar("Absentees by examination sitting", "Absent students",
                    [Reference(ws, min_col=6, min_row=d_first - 1, max_row=d_last)], cats, colors=[C_ABSENT])
        else:
            b = bar("Presentees by examination sitting", "Present students",
                    [Reference(ws, min_col=5, min_row=d_first - 1, max_row=d_last)], cats, colors=[C_PRESENT])
        ch.add_chart(b, f"A{pos}")
    widths(ch, [12] * 12)
    page_setup(ch)

    # ───────────── Course-wise ─────────────
    show_status = kind == "all"
    cols = ["S.No", "Reg No", "Student Name", "Degree / Batch", "Sec", "Date", "Time", "Room", "Seat"]
    if show_status:
        cols.append("Status")
    cw = wb.create_sheet("Course-wise")
    W = Writer(cw, len(cols))
    W.header(f"{heading} — {what}, Course-wise", sub)
    for c in courses:
        lst = [r for r in shown if r.get("code") == c["code"]]
        lst.sort(key=lambda r: (str(r.get("section") or ""), r.get("date") or "", minutes(r.get("slot")),
                                room_key(r.get("room")), seat_key(r.get("seat"))))
        sittings = " / ".join(s[2] for s in c["sittings"])
        W.merged(f"{c['code']} — {c['name']}   ·   {sittings}   ·   Rooms: {', '.join(c['rooms'])}", F_BLOCK, FILL(GREEN),
                 align=WRAP)
        if lst:
            W.th(cols)
            for i, r in enumerate(lst):
                vals = [i + 1, r.get("studentId"), r.get("name"), r.get("batch") or r.get("program"),
                        r.get("section") or "", r.get("dateDisp"), time_label(r.get("slot")), r.get("room"), r.get("seat")]
                fills = None
                if show_status:
                    vals.append(STATUS_TEXT[r["status"]])
                    fills = {len(vals) - 1: STATUS_FILL[r["status"]]}
                W.tr(vals, i, center=(0, 1, 4, 5, 6, 7, 8, 9), fills=fills)
        else:
            W.merged({"absent": "No absentee in this course.", "present": "No student present in this course yet.",
                      "all": "No students."}[kind], F_NOTE)
        h = c["p"] + c["a"]
        W.total([f"Total — {c['code']}", f"Expected {c['exp']}", f"Present {c['p']}", f"Absent {c['a']}",
                 "", f"Attendance {pct(c['p'], h) * 100:.1f}%" if h else "Not yet held"])
        W.blank()
    W.total(["GRAND TOTAL", f"{len(courses)} courses", f"Total Present: {tot_p}", f"Total Absent: {tot_a}",
             "", f"Expected: {tot_exp}", f"Attendance: {pct(tot_p, held) * 100:.1f}%" if held else ""], grand=True)
    widths(cw, [7, 15, 30, 40, 6, 13, 18, 14, 8, 13][:len(cols)])
    page_setup(cw)

    # ───────────── List ─────────────
    lname = {"absent": "All Absentees", "present": "All Presentees", "all": "All Students"}[kind]
    ls = wb.create_sheet(lname)
    lcols = ["S.No", "Date", "Day", "Time", "Course", "Course Name", "Room", "Seat", "Reg No", "Student Name",
             "Degree / Batch", "Sec", "Status", "Note"]
    W = Writer(ls, len(lcols))
    W.header(f"{heading} — {lname}", sub)
    hr = W.th(lcols)
    for i, r in enumerate(shown):
        W.tr([i + 1, r.get("dateDisp"), r.get("day"), time_label(r.get("slot")), r.get("code"), r.get("courseName"),
              r.get("room"), r.get("seat"), r.get("studentId"), r.get("name"), r.get("batch") or r.get("program"),
              r.get("section") or "", STATUS_TEXT[r["status"]], r.get("note") or ""],
             i, center=(0, 1, 2, 3, 4, 6, 7, 8, 11, 12), fills={12: STATUS_FILL[r["status"]]})
    last = W.r - 1
    if shown:
        ls.auto_filter.ref = f"A{hr}:{get_column_letter(len(lcols))}{last}"
    ls.freeze_panes = ls.cell(row=hr + 1, column=1)
    W.blank()
    W.total(["TOTAL PRESENT", "", "", tot_p], grand=False)
    W.total(["TOTAL ABSENT", "", "", tot_a], grand=False)
    if tot_n:
        W.total(["NOT YET HELD", "", "", tot_n], grand=False)
    W.total(["TOTAL EXPECTED", "", "", tot_exp, "", f"Attendance {pct(tot_p, held) * 100:.1f}%" if held else ""], grand=True)
    widths(ls, [7, 13, 11, 18, 10, 34, 14, 7, 15, 28, 38, 6, 13, 22])
    page_setup(ls)

    wb.active = 0
    wb.properties.title = f"{heading} — {what}"
    wb.properties.creator = "Abasyn Scheduler"
    wb.save(out_path)
    return {"status": "ok", "rows": len(shown), "present": tot_p, "absent": tot_a, "pending": tot_n}


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as f:
        payload = json.load(f)
    print(json.dumps(build(payload, sys.argv[2])))
