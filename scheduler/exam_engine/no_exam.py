"""
No-exam helpers for the Date Sheets "remove courses" step.

  python -m exam_engine.no_exam auto --data export.json [--db-no-exam codes.json]
      → courses that get NO written paper automatically (FYP / thesis / internship /
        project-I/II / labs incl. the "L" lab codes / clinical rotations / seminars),
        plus courses flagged no-exam in the DB (yellow at import) — except the old
        "Project" false positives (Software Project Management etc. ARE papers).

  python -m exam_engine.no_exam highlights FILE.xls|.xlsx
      → every course code on a YELLOW-highlighted row of an uploaded report.

Both print ONE JSON line. Nothing is written anywhere.
"""
import argparse
import json
import re
import sys
from pathlib import Path

from .rules import classify_course, norm_code, norm_text

CODE_RE = re.compile(r"\b([A-Za-z]{2,6}\s?\d{3,4}(?:-I{1,3})?)\b")


# ── automatic list ───────────────────────────────────────────────────────────
def auto(data_path, db_no_exam=()):
    data = json.load(open(data_path, encoding="utf-8"))
    titles, comps = {}, {}
    for c in data.get("courses", []):
        k = norm_code(c.get("code"))
        if not k:
            continue
        titles.setdefault(k, norm_text(c.get("name")))
        comps.setdefault(k, set()).add(str(c.get("component") or "Lecture").lower())
    registered = {norm_code(x) for r in data.get("student_registrations", []) for x in (r.get("courses") or [])}
    out = {}
    for k, t in titles.items():
        ok, why = classify_course(k, t, titles, "Lab" if comps.get(k) == {"lab"} else "")
        if not ok:
            out[k] = {"code": k, "title": t, "reason": why, "source": "rule"}
    for k in {norm_code(x) for x in db_no_exam}:
        if k in out:
            continue
        t = titles.get(k, "")
        ok, _ = classify_course(k, t, titles)
        if ok and "project" in t.lower():
            continue                      # old importer false positive → it IS a paper
        out[k] = {"code": k, "title": t, "reason": "marked no-exam (highlighted at import)", "source": "db"}
    items = sorted(out.values(), key=lambda x: x["code"])
    for it in items:
        it["registered"] = it["code"] in registered
    return {"status": "ok", "items": items}


# ── yellow highlights in an uploaded report ──────────────────────────────────
def _is_yellow_rgb(r, g, b):
    return r >= 200 and g >= 180 and b <= 140


def _row_code(values):
    for v in values:
        m = CODE_RE.search(str(v or ""))
        if m:
            return norm_code(m.group(1)), values
    return None, values


def _title_after(values, code):
    for v in values:
        s = norm_text(v)
        if s and not CODE_RE.fullmatch(s) and not re.fullmatch(r"[\d.]+", s) and code not in s.upper().replace(" ", ""):
            return s
    return ""


def highlights(path):
    p = Path(path)
    found, sheets = {}, {}
    ext = p.suffix.lower()
    if ext == ".xls":
        import xlrd
        wb = xlrd.open_workbook(str(p), formatting_info=True)
        for sh in wb.sheets():
            for r in range(sh.nrows):
                yellow = False
                for c in range(sh.ncols):
                    xf = wb.xf_list[sh.cell_xf_index(r, c)]
                    if xf.background.fill_pattern:
                        rgb = wb.colour_map.get(xf.background.pattern_colour_index)
                        if rgb and _is_yellow_rgb(*rgb):
                            yellow = True
                            break
                if yellow:
                    vals = sh.row_values(r)
                    code, _ = _row_code(vals)
                    if code and code not in found:
                        found[code] = _title_after(vals, code)
                        sheets[code] = sh.name
    elif ext in (".xlsx", ".xlsm"):
        import openpyxl
        wb = openpyxl.load_workbook(str(p), data_only=True)
        for ws in wb.worksheets:
            for row in ws.iter_rows():
                yellow = False
                for cell in row:
                    f = cell.fill
                    if not f or f.fill_type in (None, "none"):
                        continue
                    col = f.fgColor
                    rgb = None
                    if col is not None and col.type == "rgb" and isinstance(col.rgb, str) and len(col.rgb) >= 6:
                        h = col.rgb[-6:]
                        rgb = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
                    elif col is not None and col.type == "indexed" and col.indexed in (5, 13, 43, 51):
                        rgb = (255, 255, 0)
                    if rgb and _is_yellow_rgb(*rgb):
                        yellow = True
                        break
                if yellow:
                    vals = [c.value for c in row]
                    code, _ = _row_code(vals)
                    if code and code not in found:
                        found[code] = _title_after(vals, code)
                        sheets[code] = ws.title
    else:
        return {"status": "error", "error": "Upload the .xls or .xlsx report — highlights cannot be read from CSV."}
    items = [{"code": k, "title": v, "sheet": sheets.get(k, "")} for k, v in sorted(found.items())]
    if not items:
        return {"status": "error", "error": "No yellow-highlighted course rows were found in this file."}
    return {"status": "ok", "items": items}


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("auto")
    a.add_argument("--data", required=True)
    a.add_argument("--db-no-exam", help="JSON file with a list of codes")
    h = sub.add_parser("highlights")
    h.add_argument("file")
    args = ap.parse_args()
    try:
        if args.cmd == "auto":
            codes = json.load(open(args.db_no_exam, encoding="utf-8")) if args.db_no_exam else []
            res = auto(args.data, codes)
        else:
            res = highlights(args.file)
    except Exception as e:
        res = {"status": "error", "error": str(e)}
    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
