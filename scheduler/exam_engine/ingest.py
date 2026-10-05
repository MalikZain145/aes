"""
Universal ingest — read whatever the exam office uploads and turn it into ONE
canonical dataset, without changing a single source value.

Recognised automatically (by header, not by file name; .xls / .xlsx / .csv):

  student-wise   "Courses with Names" (+ Student ID / Name / Academic Program / Batch Intake)
                 → per-student registrations  (the backbone of clash-free scheduling)
  course-wise    "Course Code" + "Course Title" + "Meta Details"/"Enrolled Students"
                 → course titles, credit hours, sections and TEACHERS
  timetable      Code / Name / Component / Program Batch / Primary Faculty …
                 → course components, teachers, program batches
  rooms          Room|Name + Capacity (+ Exam Capacity / Exam Venue / Type)
                 → exam venues

Header rows are detected even when the sheet has a title block above them.
Course codes are compared upper-cased ('Mg231' ≡ 'MG231'); the original spelling is
kept and reported as a data-quality note — the source file itself is never touched.
"""
import csv
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import pandas as pd

from .rules import norm_code, norm_text, cohort_of, classify_course

HEADER_TOKENS = {
    "student": ["courses with names"],
    "coursewise": ["course code", "course title", "meta details", "enrolled students"],
    "timetable": ["component", "program batch", "primary faculty", "class section"],
    "rooms": ["capacity", "exam capacity", "room"],
}


# ── low-level reading ────────────────────────────────────────────────────────
def _read_raw(path: Path) -> list:
    """Return a list of DataFrames (one per sheet) read with header=None."""
    ext = path.suffix.lower()
    if ext == ".csv":
        with open(path, newline="", encoding="utf-8-sig", errors="replace") as f:
            rows = list(csv.reader(f))
        return [("csv", pd.DataFrame(rows))]
    engine = "xlrd" if ext == ".xls" else None
    try:
        sheets = pd.read_excel(path, sheet_name=None, header=None, dtype=object, engine=engine)
    except Exception:
        # some ".xls" exports are really HTML tables
        tables = pd.read_html(str(path))
        sheets = {f"table{i}": t for i, t in enumerate(tables)}
    return list(sheets.items())


def _find_header(df: pd.DataFrame, max_scan: int = 25):
    """Index of the header row = the first row (within max_scan) containing ≥2 known tokens."""
    known = {t for toks in HEADER_TOKENS.values() for t in toks} | {
        "student id", "student name", "academic program", "batch intake", "code", "name",
        "credit hours", "sections", "room", "rooms", "venue", "s. no", "s.no"}
    best, best_hits = 0, -1
    for i in range(min(max_scan, len(df))):
        cells = [norm_text(x).lower() for x in df.iloc[i].tolist() if norm_text(x)]
        hits = sum(1 for c in cells if c in known)
        if hits > best_hits:
            best, best_hits = i, hits
        if hits >= 3:
            return i
    return best


def _frame(df: pd.DataFrame) -> pd.DataFrame:
    h = _find_header(df)
    cols = [norm_text(c) or f"col{j}" for j, c in enumerate(df.iloc[h].tolist())]
    out = df.iloc[h + 1:].copy()
    out.columns = cols
    out = out.dropna(how="all")
    return out


def detect_shape(cols) -> str:
    low = [str(c).lower().strip() for c in cols]
    has = lambda n: any(n in c for c in low)
    if has("courses with names"):
        return "student"
    if (has("course code") or has("course title")) and (has("meta details") or has("enrolled students")):
        return "coursewise"
    if "component" in low or ("code" in low and "name" in low):
        return "timetable"
    if has("capacity") and (has("room") or has("name") or has("venue")):
        return "rooms"
    return "unknown"


def _col(df, *names):
    low = {str(c).lower().strip(): c for c in df.columns}
    for n in names:
        if n in low:
            return low[n]
    for n in names:
        for k, c in low.items():
            if n in k:
                return c
    return None


# ── per-shape parsers ────────────────────────────────────────────────────────
# "CS313 - Operating Systems Concepts - 3.0, CS242 - Computer Architecture - 3.0,"
# Titles may themselves contain commas and " - " — the credit "- N.N," terminates an entry.
_ENTRY_RE = re.compile(r"\s*([A-Za-z]{1,6}[-\s]?\d{2,4}[A-Za-z]?(?:-[IVX]+)?)\s+-\s+(.*?)\s+-\s+(\d+(?:\.\d+)?)\s*(?:,|$)")


def parse_course_list(raw: str):
    s = norm_text(raw)
    if s and not s.endswith(","):
        s += ","
    out = []
    for code, title, cr in _ENTRY_RE.findall(s):
        out.append((code.strip(), norm_text(title), float(cr)))
    return out


def parse_student_wise(df, src, ds, quality):
    c_id = _col(df, "student id", "registration no", "reg no", "regno")
    c_nm = _col(df, "student name", "name")
    c_pg = _col(df, "academic program", "program")
    c_bt = _col(df, "batch intake", "intake", "batch")
    c_cs = _col(df, "courses with names")
    c_n = _col(df, "number of courses")
    for _, r in df.iterrows():
        sid = norm_text(r.get(c_id))
        if not sid or sid.lower() in ("nan", "student id"):
            continue
        if re.fullmatch(r"\d+\.0", sid):
            sid = sid[:-2]
        raw = str(r.get(c_cs) or "")
        entries = parse_course_list(raw)
        declared = r.get(c_n) if c_n else None
        try:
            declared = int(float(declared)) if declared is not None and str(declared) != "nan" else None
        except Exception:
            declared = None
        if declared is not None and declared != len(entries):
            quality["course_count_mismatch"].append({"student_id": sid, "declared": declared, "parsed": len(entries), "file": src})
        prog = norm_text(r.get(c_pg))
        intake = norm_text(r.get(c_bt))
        st = ds["students"].get(sid)
        if st is None:
            st = ds["students"][sid] = {
                "student_id": sid, "name": norm_text(r.get(c_nm)), "program": prog,
                "intake": intake, "batch": " ".join(x for x in (prog, intake) if x),
                "courses": [], "source": src}
        else:
            quality["duplicate_student_rows"].append({"student_id": sid, "file": src})
        for code_raw, title, cr in entries:
            code = norm_code(code_raw)
            if code_raw != code:
                quality["code_case_or_space"].append({"student_id": sid, "as_written": code_raw, "key": code})
            if code in st["courses"]:
                quality["duplicate_enrolment"].append({"student_id": sid, "code": code})
                continue
            st["courses"].append(code)
            c = ds["courses"].setdefault(code, {"code": code, "titles": Counter(), "credits": Counter(),
                                                "sections": [], "teachers": Counter(), "classwise_enrolled": None,
                                                "components": Counter()})
            c["titles"][title] += 1
            c["credits"][cr] += 1


def parse_course_wise(df, src, ds, quality):
    c_code = _col(df, "course code", "code")
    c_title = _col(df, "course title", "title", "name")
    c_cr = _col(df, "credit hours", "credit")
    c_en = _col(df, "enrolled students", "enrolled")
    c_meta = _col(df, "meta details", "meta")
    for _, r in df.iterrows():
        raw = norm_text(r.get(c_code))
        if not raw or raw.lower() in ("nan", "course code"):
            continue
        code = norm_code(raw)
        c = ds["courses"].setdefault(code, {"code": code, "titles": Counter(), "credits": Counter(),
                                            "sections": [], "teachers": Counter(), "classwise_enrolled": None,
                                            "components": Counter()})
        t = norm_text(r.get(c_title))
        if t:
            c["titles"][t] += 1000          # class-wise title is authoritative for display
        try:
            c["credits"][float(r.get(c_cr))] += 1000
        except Exception:
            pass
        try:
            n = int(float(r.get(c_en)))
            c["classwise_enrolled"] = (c["classwise_enrolled"] or 0) + n
        except Exception:
            pass
        for seg in re.split(r"[\r\n]+", str(r.get(c_meta) or "")):
            seg = seg.strip().rstrip(",").strip()
            if not seg:
                continue
            parts = [p.strip() for p in seg.split(" - ")]
            sec = re.sub(r"(?i)section\s*-?\s*", "", parts[0]).strip().upper() if parts else ""
            teacher = norm_text(" - ".join(parts[2:])) if len(parts) >= 3 else ""
            if teacher.lower() in ("no teacher", "tba", "nan", ""):
                teacher = ""
            c["sections"].append({"section": sec, "teacher": teacher})
            if teacher:
                c["teachers"][teacher] += 1


def _clean_teacher(t):
    s = norm_text(t)
    if not s or s.upper() in ("TBA", "NAN", "NONE", "-"):
        return ""
    if "@" in s or " - " in s:
        parts = [p.strip() for p in s.split(" - ") if p.strip()]
        for p in reversed(parts):
            if "@" in p or re.match(r"^[A-Za-z&]+-\d+$", p):
                continue
            if len(p) > 2:
                return p
    return s


def parse_timetable(df, src, ds, quality):
    c_code = _col(df, "code")
    c_name = _col(df, "name")
    c_comp = _col(df, "component")
    c_fac = _col(df, "primary faculty", "teacher", "faculty")
    c_pb = _col(df, "program batch", "batch")
    for _, r in df.iterrows():
        raw = norm_text(r.get(c_code))
        if not raw or raw.lower() == "nan":
            continue
        m = re.match(r"^([A-Za-z]{1,6}[-\s]?\d{2,4}(?:-[IVX]+)?)", raw)
        code = norm_code(m.group(1) if m else raw.split("-")[0])
        c = ds["courses"].setdefault(code, {"code": code, "titles": Counter(), "credits": Counter(),
                                            "sections": [], "teachers": Counter(), "classwise_enrolled": None,
                                            "components": Counter()})
        nm = norm_text(r.get(c_name))
        if nm:
            c["titles"][nm] += 10
        comp = norm_text(r.get(c_comp)) or "Lecture"
        c["components"][comp.title()] += 1
        t = _clean_teacher(r.get(c_fac))
        if t:
            c["teachers"][t] += 1
        if c_pb:
            c.setdefault("program_batches", set()).add(norm_text(r.get(c_pb)))


def parse_rooms(df, src, ds, quality):
    c_nm = _col(df, "room", "name", "venue")
    c_cap = _col(df, "exam capacity", "capacity")
    c_ccap = _col(df, "capacity")
    c_type = _col(df, "type", "kind")
    c_ev = _col(df, "exam venue", "examvenue")
    for _, r in df.iterrows():
        nm = norm_text(r.get(c_nm))
        if not nm or nm.lower() == "nan":
            continue
        try:
            cap = int(float(r.get(c_ccap)))
        except Exception:
            continue
        try:
            ecap = int(float(r.get(c_cap)))
        except Exception:
            ecap = cap
        kind = "lab" if "lab" in norm_text(r.get(c_type)).lower() else "room"
        ev = str(r.get(c_ev)).strip().lower() in ("1", "true", "yes", "y") if c_ev else True
        ds["rooms"][nm] = {"name": nm, "capacity": cap, "examCapacity": ecap, "examVenue": ev, "kind": kind}


PARSERS = {"student": parse_student_wise, "coursewise": parse_course_wise,
           "timetable": parse_timetable, "rooms": parse_rooms}


# ── public API ───────────────────────────────────────────────────────────────
def ingest(paths) -> dict:
    """Read every file in `paths`; return the canonical dataset (see module docstring)."""
    ds = {"students": {}, "courses": {}, "rooms": {}, "files": []}
    quality = defaultdict(list)
    for p in paths:
        p = Path(p)
        try:
            sheets = _read_raw(p)
        except Exception as e:
            ds["files"].append({"file": p.name, "error": f"unreadable: {e}"})
            continue
        for sheet_name, raw in sheets:
            if raw is None or raw.empty:
                continue
            df = _frame(raw)
            shape = detect_shape(df.columns)
            ds["files"].append({"file": p.name, "sheet": str(sheet_name), "shape": shape, "rows": int(len(df))})
            if shape in PARSERS:
                PARSERS[shape](df, p.name, ds, quality)
    _finalise(ds, quality)
    return ds


def _finalise(ds, quality):
    titles = {code: (c["titles"].most_common(1)[0][0] if c["titles"] else code)
              for code, c in ds["courses"].items()}
    enrolled = Counter(code for st in ds["students"].values() for code in st["courses"])
    for code, c in ds["courses"].items():
        c["title"] = titles[code]
        c["credit"] = c["credits"].most_common(1)[0][0] if c["credits"] else None
        c["component"] = c["components"].most_common(1)[0][0] if c["components"] else ""
        ok, why = classify_course(code, c["title"], titles, c["component"])
        c["examinable"], c["no_exam_reason"] = ok, why
        c["enrolled"] = enrolled.get(code, 0)
        c["teacher_list"] = [t for t, _ in c["teachers"].most_common()]
        progs = Counter(ds["students"][s]["program"] for s in ds["students"] if code in ds["students"][s]["courses"]) \
            if enrolled.get(code) else Counter()
        c["programs"] = dict(progs)
        if len({t for t in c["titles"] if c["titles"][t] < 1000}) > 1:
            quality["title_variants"].append({"code": code, "titles": sorted(c["titles"])})
        if c["classwise_enrolled"] is not None and ds["students"] and c["classwise_enrolled"] != enrolled.get(code, 0):
            quality["classwise_vs_studentwise"].append(
                {"code": code, "classwise": c["classwise_enrolled"], "studentwise": enrolled.get(code, 0)})
    for st in ds["students"].values():
        st["cohort"] = cohort_of(st["program"])
    ds["quality"] = {k: v for k, v in quality.items()}
    ds["summary"] = {
        "students": len(ds["students"]),
        "courses": len(ds["courses"]),
        "examinable_courses": sum(1 for c in ds["courses"].values() if c["examinable"] and c["enrolled"]),
        "rooms": len(ds["rooms"]),
        "cohorts": dict(Counter(st["cohort"] for st in ds["students"].values())),
        "quality_counts": {k: len(v) for k, v in quality.items()},
    }


def to_export(ds: dict, base_export: dict = None) -> dict:
    """Canonical dataset → the db_export JSON shape every Python engine reads.
    Rooms/labs come from the ingested rooms file, else from `base_export` (the live DB)."""
    base_export = base_export or {}
    if ds["rooms"]:
        rooms = [{k: v for k, v in r.items() if k != "kind"} for r in ds["rooms"].values() if r["kind"] == "room"]
        labs = [{**{k: v for k, v in r.items() if k != "kind"}, "departments": []}
                for r in ds["rooms"].values() if r["kind"] == "lab"]
    else:
        rooms, labs = base_export.get("rooms", []), base_export.get("labs", [])
    courses = []
    for code, c in sorted(ds["courses"].items()):
        secs = c["sections"] or [{"section": "A", "teacher": ""}]
        teachers = c["teacher_list"]
        prog = max(c["programs"], key=c["programs"].get) if c["programs"] else ""
        level = "PG" if (re.search(r"(\d{3})", code) and int(re.search(r"(\d{3})", code).group(1)) >= 500) else "UG"
        seen = set()
        for i, s in enumerate(secs):
            sec = s.get("section") or chr(65 + i)
            fc = f"{code}-{sec}-{'Lab' if not c['examinable'] and 'lab' in c['no_exam_reason'] else 'Lecture'}"
            if fc in seen:
                fc = f"{fc}-{i}"
            seen.add(fc)
            courses.append({
                "fullCode": fc, "code": code, "name": c["title"],
                "component": "Lab" if (c["component"].lower() == "lab" or "lab" in c["no_exam_reason"]) else "Lecture",
                "section": sec, "programBatch": prog, "program": prog, "level": level, "department": prog,
                "teacher": s.get("teacher") or (teachers[0] if teachers else "TBA"),
                "enrolled": c["enrolled"], "creditHours": c["credit"] if c["credit"] is not None else 3,
                "noExam": not c["examinable"],
            })
    regs = [{"student_id": st["student_id"], "name": st["name"], "program": st["program"],
             "batch": st["batch"], "courses": list(st["courses"])}
            for st in ds["students"].values()]
    return {"rooms": rooms, "labs": labs, "courses": courses, "student_registrations": regs}


def merge_into_export(ds: dict, base_export: dict) -> dict:
    """Overlay freshly ingested data on the live DB export WITHOUT deleting anything:
    uploaded students replace the same student's registration; others are kept;
    rooms/labs always come from the DB unless a rooms file was uploaded."""
    new = to_export(ds, base_export)
    if not base_export:
        return new
    regs = {r["student_id"]: r for r in base_export.get("student_registrations", [])}
    for r in new["student_registrations"]:
        regs[r["student_id"]] = r
    by_full = {c["fullCode"]: c for c in base_export.get("courses", [])}
    have_code = {c["code"] for c in base_export.get("courses", [])}
    for c in new["courses"]:
        if c["code"] not in have_code:
            by_full[c["fullCode"]] = c
    return {"rooms": new["rooms"], "labs": new["labs"], "courses": list(by_full.values()),
            "student_registrations": list(regs.values())}


def main():
    import argparse
    ap = argparse.ArgumentParser(description="Ingest exam-office files into the canonical dataset.")
    ap.add_argument("files", nargs="+")
    ap.add_argument("--out", required=True, help="canonical JSON output")
    ap.add_argument("--export-out", help="also write a db_export-shaped JSON")
    ap.add_argument("--base-export", help="live DB export to take rooms/labs from")
    a = ap.parse_args()
    ds = ingest(a.files)
    base = json.load(open(a.base_export, encoding="utf-8")) if a.base_export else None

    def _ser(o):
        if isinstance(o, (set,)):
            return sorted(o)
        if isinstance(o, Counter):
            return dict(o)
        raise TypeError(type(o))
    Path(a.out).write_text(json.dumps(ds, default=_ser, ensure_ascii=False), encoding="utf-8")
    if a.export_out:
        Path(a.export_out).write_text(json.dumps(to_export(ds, base), ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"status": "ok", "summary": ds["summary"], "files": ds["files"]}))


if __name__ == "__main__":
    main()
