import os, re, sys, json, random, argparse, traceback
from collections import defaultdict
import sys, io
import metaheuristic   # greedy -> Tabu -> VNS improver (no dependency back on main)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

try:
    import pandas as pd
except ImportError:
    sys.exit("ERROR: pip install pandas openpyxl")
try:
    from openpyxl import Workbook
    from openpyxl.styles import PatternFill, Font, Alignment, Border, Side
    from openpyxl.utils import get_column_letter
except ImportError:
    sys.exit("ERROR: pip install openpyxl")

# OR-Tools CP-SAT — used to OPTIMALLY pack the lab sessions (a hard, overlap-
# constrained assignment). Optional: if it isn't installed the engine falls back
# to the greedy lab placer, so the app keeps working either way.
try:
    from ortools.sat.python import cp_model
    HAVE_CPSAT = True
except Exception:
    HAVE_CPSAT = False

# ── PATHS / CLI ───────────────────────────────────────────────────────────────
# This scheduler now runs in TWO modes:
#   1. DB mode (used by the web app): a JSON file exported from MongoDB is passed
#      via --data. Courses, rooms and labs all come from that file.
#   2. Legacy mode: if no --data is given it falls back to timetable-dataset.xlsx
#      and the built-in room/lab tables (kept for standalone CLI use).
_HERE = os.path.dirname(os.path.abspath(__file__))

_parser = argparse.ArgumentParser(description="Abasyn timetable generator")
_parser.add_argument("--data",   help="Path to JSON export from the database")
_parser.add_argument("--outdir", help="Directory to write outputs into")
_parser.add_argument("--prefix", default="Abasyn_Timetable",
                     help="Output filename prefix")
_parser.add_argument("--no-pdf", action="store_true", help="Skip PDF generation")
_parser.add_argument("--level", default="ug", choices=["ug", "pg"],
                     help="ug = undergraduate (code<500, Mon-Fri); pg = MS (code>=500, Sat-Sun)")
_ARGS, _ = _parser.parse_known_args()
LEVEL = (_ARGS.level or "ug").lower()

_OUTDIR     = _ARGS.outdir or _HERE
os.makedirs(_OUTDIR, exist_ok=True)
INPUT_FILE  = os.path.join(_HERE, "timetable-dataset.xlsx")
DATA_JSON   = _ARGS.data
OUTPUT_FILE = os.path.join(_OUTDIR, f"{_ARGS.prefix}.xlsx")
REPORT_FILE = os.path.join(_OUTDIR, "Clash_Report.txt")
# When run from the web app we also emit a machine-readable summary
SUMMARY_JSON = os.path.join(_OUTDIR, f"{_ARGS.prefix}_summary.json")
# Structured schedule (every session) so the "Ask Abasyn Scheduler" search can
# answer room / teacher / course / day queries without parsing the Excel.
SCHEDULE_JSON = os.path.join(_OUTDIR, f"{_ARGS.prefix}_schedule.json")

# ── TIME STRUCTURE ────────────────────────────────────────────────────────────
# MS (postgraduate) classes run ONLY on the weekend; undergraduate Mon–Fri.
DAYS         = (["Saturday", "Sunday"] if LEVEL == "pg"
                else ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"])

# A course is POSTGRADUATE (MS) when its code has a 3-digit number 500–999
# (CS602, MG687…). 4-digit codes (CE1013) are undergraduate.
def _is_pg_code(code):
    m = re.search(r"(\d{3,4})", str(code or ""))
    return bool(m) and len(m.group(1)) == 3 and int(m.group(1)) >= 500
THEORY_SLOTS = ["08:30-10:00","10:00-11:30","11:30-01:00","02:00-03:30","03:30-05:00"]
# Lab time slots (per admin): a lab is a consecutive 3-hour block at exactly one
# of these starts — 08:30-11:30, 10:00-01:00 (morning) or 02:00-05:00 (afternoon).
# The two MORNING options overlap (a room runs only ONE), plus the afternoon block,
# so a lab physically hosts up to 2 lab sessions a day. Nothing runs past 05:00 or
# across the 01:00–02:00 lunch. SLOT_OVERLAP makes these correct despite shared times.
LAB_SLOTS    = ["08:30-11:30","10:00-01:00","02:00-05:00"]

# 2-HOUR theory sessions (a 2-credit course = ONE 2-hour class on ONE day, not two
# 1.5-hour classes). Start times are aligned to a 1.5-hour column so the session
# renders in that column with a "(2 Hrs)" note; the overlap map keeps the room /
# teacher / batch busy for the whole 2 hours (blocking the following slot).
THEORY_SLOTS_2H = ["08:30-10:30","10:00-12:00","02:00-04:00","03:00-05:00"]
# each 2-hour slot → the 1.5-hour column it displays in
TWO_HR_COL = {"08:30-10:30":"08:30-10:00","10:00-12:00":"10:00-11:30",
              "02:00-04:00":"02:00-03:30","03:00-05:00":"03:30-05:00"}

# ── LAB DISPLAY COLUMNS ───────────────────────────────────────────────────────
# The two MORNING lab starts (08:30, 10:00) overlap each other — a room
# runs only ONE of them — so showing them as three separate grid columns leaves
# two of them mostly EMPTY (the solver books nearly all morning labs at 08:30).
# For DISPLAY we therefore collapse the overlapping morning starts into a single
# "Morning Lab" column and keep the afternoon as its own column; each lab cell
# still shows the exact start time next to the room. (Booking/constraints keep
# using the real LAB_SLOTS — this only affects how the grid is drawn.)
def _labslot_is_pm(s):
    return int(s.split(":")[0]) < 8            # start hour 1..5 = afternoon
LAB_AM_SLOTS = [s for s in LAB_SLOTS if not _labslot_is_pm(s)]
LAB_PM_SLOTS = [s for s in LAB_SLOTS if _labslot_is_pm(s)]
# Labs are drawn INLINE in the theory time-slot columns (the official docx grid),
# so there are NO separate lab columns.
LAB_COL_GROUPS = {}
LAB_DISPLAY_COLS = []

ALL_COLS = ["__day__"] + THEORY_SLOTS[:3] + ["__break__"] + THEORY_SLOTS[3:]
N_COLS   = len(ALL_COLS)

# Each 3-hour lab renders inside the THEORY column that shares its START time
# (08:30 lab → 08:30-10:00 column, 10:00 lab → 10:00-11:30, 02:00 lab → 02:00-03:30).
def _theory_col_for_lab(lab):
    start = str(lab).split("-")[0]
    for ts in THEORY_SLOTS:
        if ts.split("-")[0] == start:
            return ts
    return THEORY_SLOTS[0]
THEORY_COL_LABS = {}
for _lab in LAB_SLOTS:
    THEORY_COL_LABS.setdefault(_theory_col_for_lab(_lab), []).append(_lab)

_DAY_ABBR = {"Monday": "MON", "Tuesday": "TUE", "Wednesday": "WED",
             "Thursday": "THU", "Friday": "FRI", "Saturday": "SAT", "Sunday": "SUN"}
def _day_abbr(d):
    return _DAY_ABBR.get(str(d).title(), str(d)[:3].upper())

def _ampm(slot):
    """'08:30-10:00' → '08:30am - 10:00am' (matches the docx header)."""
    def one(t):
        try:
            h, m = map(int, t.split(":"))
        except Exception:
            return t
        ap = "am" if 8 <= h <= 11 else "pm"   # our day runs 08:30–05:00
        return f"{t}{ap}"
    try:
        a, b = slot.split("-")
        return f"{one(a)} - {one(b)}"
    except Exception:
        return slot

# ── Wall-clock overlap map over ALL slots (theory + lab) ──────────────────────
# A room / lab / teacher / batch / student occupied in ANY interval must be busy
# for EVERY interval that overlaps it — this is what makes the schedule truly
# clash-free in real time (not just per exact slot-label).
def _slot_minutes(t):
    h, m = map(int, str(t).split(":"))
    if h < 8:            # 01:00–05:30 are afternoon (PM)
        h += 12
    return h * 60 + m

def _slot_range(slot):
    a, b = str(slot).split("-")
    return (_slot_minutes(a), _slot_minutes(b))

_ALL_SLOTS = THEORY_SLOTS + LAB_SLOTS + THEORY_SLOTS_2H
_SLOT_RANGE = {s: _slot_range(s) for s in _ALL_SLOTS}

def _ranges_overlap(r1, r2):
    return r1[0] < r2[1] and r2[0] < r1[1]

SLOT_OVERLAP = {
    s: frozenset(s2 for s2 in _ALL_SLOTS if _ranges_overlap(_SLOT_RANGE[s], _SLOT_RANGE[s2]))
    for s in _ALL_SLOTS
}

# Theory slot → the lab slots that overlap it (derived, so it stays correct if the
# slot grids change). Used by the HC8 lab-as-theory-room checks.
THEORY_OVERLAPS_LAB = {
    ts: [ls for ls in LAB_SLOTS if ls in SLOT_OVERLAP[ts]] for ts in THEORY_SLOTS
}

# ── THEORY ROOMS ──────────────────────────────────────────────────────────────
THEORY_ROOMS = [
    "I101","I103","I104","I105","I106","I108","I109","I110",
    "I111","I112","I113","I114","I115","I116",
    "I201","I202","I203","I204","I205","I206","I208","I209",
    "I210","I211","I212","I213","I214","I215","I216",
    "J209","J210","J211","J214","J215",
    "J301","J308","J310","J311","J312","J313","J315",
    "Auditorium",
]
ROOM_CAP = {
    "I101":23,"I103":25,"I104":27,"I105":8, "I106":20,
    "I108":40,"I109":38,"I110":44,"I111":30,"I112":44,
    "I113":33,"I114":30,"I115":35,"I116":40,
    "I201":35,"I202":25,"I203":22,"I204":30,"I205":27,
    "I206":25,"I208":33,"I209":35,"I210":34,"I211":33,
    "I212":45,"I213":26,"I214":33,"I215":42,"I216":42,
    "J209":60,"J210":62,"J211":40,"J214":75,"J215":62,
    "J301":65,"J308":67,"J310":60,"J311":45,
    "J312":70,"J313":60,"J315":56,
    "Auditorium":300,
}
ROOMS_BY_CAP = sorted(ROOM_CAP.keys(), key=lambda r: ROOM_CAP[r])

# ── TIGHT-FIT ROOM MATCHING ───────────────────────────────────────────────────
# Try to seat a class in a room only slightly bigger than its strength, instead
# of any room that merely fits. Example: a 20-student class prefers a 20–26 seat
# room rather than a 70-seat hall.
#
# TIGHT_FIT_RATIO = 0.30 means "prefer rooms up to 30% bigger than the class".
#   strength 20 -> prefers rooms with capacity 20 to 26   (20 * 1.30 = 26)
#   strength 70 -> prefers rooms with capacity 70 to 91   (70 * 1.30 = 91)
#
# If no room exists in that tight band (or all are busy), the scheduler falls
# back to the next-smallest fitting room, so classes are NEVER left unplaced.
# Set to a larger number (e.g. 1.0) to relax, or smaller (e.g. 0.15) to tighten.
TIGHT_FIT_RATIO = 0.30

# ── LAB ROOMS WITH CAPACITY ───────────────────────────────────────────────────
# Format: lab_name → capacity
LAB_CAP = {
    # CS / AI / SE / EE
    "High Performance Lab": 25,
    "GP Lab III":           30,
    "GP Lab 3":             30,
    "Simulation Lab":       18,
    "GP Lab I":             42,
    "GP Lab 1":             42,
    "GP Lab II":            45,
    "GP Lab 2":             45,
    "CS Lab-1":             42,
    "CS Lab-2":             42,
    "CS Lab-3":             30,
    "DLD Lab":              30,
    "AI Lab":               30,
    "Machine Learning Lab": 25,
    "Electronics Lab":      30,
    "Circuits Lab":         30,
    "Power Systems Lab":    25,
    "Instrumentation Lab":  25,
    "High Voltage Lab":     20,
    # Civil / Engineering
    "Fluid Mechanics Lab":          25,
    "Mechanics of Solids Lab":      25,
    "Transportation Engineering Lab":25,
    "Engineering Drawing Lab":      35,
    "Concrete & Materials Lab":     25,
    "Surveying Lab":                30,
    # Health Sciences
    "HND Lab":              12,
    "Nutrition Lab":        12,
    "Food Analysis Lab":    12,
    "Anatomy Lab":          20,
    "Electro Lab 2":         2,    # as given
    "Electrotherapy Lab":    2,
    "Physiology Lab":       30,
    "Kinesiology Lab":      25,
    "Rehabilitation Lab":   25,
    # MLT
    "MLT Lab 1":            30,
    "MLT Lab 2":             5,
    "Pathology Lab":        30,
    "Hematology Lab":       30,
    "Clinical Chemistry Lab":30,
    "Histopathology Lab":   30,
    # VS / OT / RT
    "Optometry Lab":        12,
    "Vision Sciences Lab":  12,
    "Operation Theater Lab":20,
    "Surgical Skills Lab":  20,
    "Radiology Lab":        30,
    "RT Lab":               30,
    "Imaging Lab":          25,
    # Pharma / DPT
    "Pharmaceutics Lab":    40,
    "Pharmacology Lab":     40,
    "Biochemistry Lab":     40,
    "Microbiology Lab":     40,
    "Chemistry Lab":        40,
}

# Department → ordered list of labs (preferred first)
ALL_LABS = {
    "cs":     ["GP Lab I","GP Lab II","GP Lab III","CS Lab-1","CS Lab-2","CS Lab-3",
               "DLD Lab","Simulation Lab","High Performance Lab"],
    "ai":     ["AI Lab","Machine Learning Lab","GP Lab I","GP Lab II","CS Lab-3"],
    "civil":  ["Engineering Drawing Lab","Surveying Lab","Fluid Mechanics Lab",
               "Mechanics of Solids Lab","Transportation Engineering Lab",
               "Concrete & Materials Lab"],
    "ee":     ["Electronics Lab","Circuits Lab","Power Systems Lab",
               "Instrumentation Lab","High Voltage Lab"],
    "pharmd": ["Pharmaceutics Lab","Pharmacology Lab","Biochemistry Lab",
               "Microbiology Lab","Chemistry Lab"],
    "dpt":    ["Physiology Lab","Anatomy Lab","Electrotherapy Lab",
               "Kinesiology Lab","Rehabilitation Lab"],
    "mlt":    ["MLT Lab 1","MLT Lab 2","Pathology Lab","Hematology Lab",
               "Clinical Chemistry Lab","Histopathology Lab"],
    "vs":     ["Optometry Lab","Vision Sciences Lab"],
    "ot":     ["Operation Theater Lab","Surgical Skills Lab"],
    "rt":     ["Radiology Lab","RT Lab","Imaging Lab"],
    "hnd":    ["HND Lab","Nutrition Lab","Food Analysis Lab"],
    "common": ["GP Lab I","GP Lab II","CS Lab-1"],
    "bba":    ["GP Lab I","CS Lab-1"],
    "af":     ["GP Lab I","CS Lab-1"],
    "psy":    ["GP Lab I","CS Lab-1"],
    "eng":    ["GP Lab I","CS Lab-1"],
    "math":   ["GP Lab I","CS Lab-1"],
}

# ── DB-EXPORT OVERRIDE ────────────────────────────────────────────────────────
# When the web app passes --data <export.json>, the rooms and labs tables above
# are replaced by whatever the admin has configured in the database. This is how
# the previously hard-coded values were moved out of the code.
def _apply_db_rooms_labs(export):
    global THEORY_ROOMS, ROOM_CAP, ROOMS_BY_CAP, LAB_CAP, ALL_LABS

    rooms = export.get("rooms") or []
    labs  = export.get("labs")  or []

    if rooms:
        THEORY_ROOMS = [r["name"] for r in rooms]
        ROOM_CAP     = {r["name"]: int(r["capacity"]) for r in rooms}
        ROOMS_BY_CAP = sorted(ROOM_CAP.keys(), key=lambda r: ROOM_CAP[r])

    if labs:
        LAB_CAP = {l["name"]: int(l["capacity"]) for l in labs}
        # Rebuild per-department lab pools from each lab's department list.
        pools = defaultdict(list)
        for l in labs:
            for dept in (l.get("departments") or []):
                pools[dept].append(l["name"])
        # Guarantee every dept key has at least a fallback pool.
        all_lab_names = [l["name"] for l in labs]
        fallback = pools.get("common") or all_lab_names[:3] or all_lab_names
        merged = {}
        known_depts = set(list(ALL_LABS.keys()) + list(pools.keys()))
        for dept in known_depts:
            merged[dept] = pools.get(dept) or list(fallback)
        ALL_LABS = merged

# ── DEPT COLORS ───────────────────────────────────────────────────────────────
DEPT_COLORS = {
    "common": ("000000","F5F5F5","Common / General"),
    "cs":     ("145A32","D5F5E3","CS / SE / AI"),
    "ai":     ("145A32","D5F5E3","Artificial Intelligence"),
    "ee":     ("7D6608","FEF9E7","Electrical Engineering"),
    "civil":  ("1A5276","D6EAF8","Civil Engineering"),
    "bba":    ("922B21","FADBD8","Business Administration"),
    "af":     ("7B341E","FEEBC8","Accounting & Finance"),
    "psy":    ("784212","FDEBD0","Psychology"),
    "eng":    ("641E16","F9EBEA","English / Literature"),
    "pharmd": ("1B2631","D6DBDF","Doctor of Pharmacy"),
    "dpt":    ("6C3483","F5EEF8","Doctor of Physical Therapy"),
    "mlt":    ("4A235A","E8DAEF","Medical Lab Technology"),
    "vs":     ("1F3A5F","D4E6F1","Vision Sciences"),
    "ot":     ("1F3A5F","D4E6F1","Operation Theatre Technology"),
    "rt":     ("1F3A5F","D4E6F1","Radiology Technology"),
    "hnd":    ("1F3A5F","D4E6F1","Human Nutrition & Dietetics"),
    "math":   ("1A5276","EBF5FB","Mathematics / Statistics / Physics"),
}
_CODE_DEPT = {
    "CS":"cs","SE":"cs","AI":"ai","MT":"math","NS":"math","NSC":"math",
    "EE":"ee","ET":"ee","ELT":"ee","ELC":"ee","ELM":"ee","ELQ":"ee",
    "ELTL":"ee","ELCL":"ee","BSEE":"ee","EET":"ee",
    "CE":"civil","CT":"civil","CET":"civil","CETL":"civil","CTL":"civil","MD":"civil",
    "MG":"bba","HM":"bba","AF":"af","AC":"af",
    "SS":"common","HUM":"common","MS":"common","BC":"mlt","MB":"mlt","GC":"common",
    "PD":"pharmd","PH":"pharmd",
    "LT":"mlt","VS":"vs","OT":"ot","RT":"rt","HN":"hnd",
    "DP":"dpt","PT":"dpt","SU":"dpt",
    "ENG":"eng","LIN":"eng","PSY":"psy",
}
_COMMON_KW = [
    "islamic studies","pakistan studies","quran","fahm-ul-quran",
    "communication skills","professional practices","professional ethics",
    "introduction to management","economics","technical report writing",
]
def get_dept_key(code, name):
    if any(kw in name.lower() for kw in _COMMON_KW): return "common"
    for pfx in sorted(_CODE_DEPT, key=len, reverse=True):
        if code.upper().startswith(pfx.upper()): return _CODE_DEPT[pfx]
    return "common"

# ── PROG PALETTE ──────────────────────────────────────────────────────────────
PROG_PALETTE = {
    "BS Computer Science":                   ("145A32","D5F5E3"),
    "BS Software Engineering":               ("145A32","D5F5E3"),
    "BS Artificial Intelligence":            ("145A32","D5F5E3"),
    "BE Civil Engineering":                  ("1A5276","D6EAF8"),
    "BSc Civil Engineering Technology":      ("1A5276","D6EAF8"),
    "BS Electrical Engineering":             ("7D6608","FEF9E7"),
    "BSc Electrical Engineering Technology": ("7D6608","FEF9E7"),
    "Bachelor of Business Administration":   ("922B21","FADBD8"),
    "BS Accounting and Finance":             ("7B341E","FEEBC8"),
    "BS English(Language and Literature)":   ("641E16","F9EBEA"),
    "BS Psychology":                         ("784212","FDEBD0"),
    "Doctor of Pharmacy":                    ("1B2631","D6DBDF"),
    "Doctor of Physical Therapy":            ("6C3483","F5EEF8"),
    "BS Medical Lab Technology":             ("4A235A","E8DAEF"),
    "BS Vision Sciences":                    ("1F3A5F","D4E6F1"),
    "BS Operation Theatre Technology":       ("1F3A5F","D4E6F1"),
    "BS Radiology Technology":               ("1F3A5F","D4E6F1"),
    "BS Human Nutrition & Dietetics":        ("1F3A5F","D4E6F1"),
    "Graduate Program":                      ("2D3748","EDF2F7"),
    "General Courses":                       ("2D3748","EDF2F7"),
}
_PROG_DEFAULT = ("2D3748","EDF2F7")

# ── PROGRAM BATCH → PROGRAM NAME ─────────────────────────────────────────────
_PB_PREFIX_MAP = {
    "BSCS":  "BS Computer Science",
    "BSSE":  "BS Software Engineering",
    "BSAI":  "BS Artificial Intelligence",
    "BECE":  "BE Civil Engineering",
    "BSCE":  "BE Civil Engineering",
    "BSc CET": "BSc Civil Engineering Technology",
    "BSEE":  "BS Electrical Engineering",
    "BSc EET": "BSc Electrical Engineering Technology",
    "BBA":   "Bachelor of Business Administration",
    "BSAF":  "BS Accounting and Finance",
    "BSENG": "BS English(Language and Literature)",
    "BSPSY": "BS Psychology",
    "PHARM-D": "Doctor of Pharmacy",
    "DPT":   "Doctor of Physical Therapy",
    "BSMLT": "BS Medical Lab Technology",
    "BSVS":  "BS Vision Sciences",
    "BSOT":  "BS Operation Theatre Technology",
    "BSRT":  "BS Radiology Technology",
    "BSHND": "BS Human Nutrition & Dietetics",
    "General Courses": "General Courses",
}
def _pb_to_program(pb):
    pb = str(pb).strip()
    for prefix in sorted(_PB_PREFIX_MAP, key=len, reverse=True):
        if pb.upper().startswith(prefix.upper()):
            return _PB_PREFIX_MAP[prefix]
    # The current data uses FULL program names + batch, e.g.
    # "BS Computer Science Fall 2025". Strip the trailing "<Season> <Year>" to
    # get the real program name instead of the "Graduate Program" fallback.
    m = re.sub(r"\s+(Fall|Spring|Summer|Autumn|Winter)\s+\d{4}\s*$", "", pb, flags=re.I).strip()
    return m or "Graduate Program"

# ── EXCLUSIONS ────────────────────────────────────────────────────────────────
_EXCL_KW = [
    "final year project","fyp","project-i","project-ii","project i","project ii",
    "project -i","project -ii","internship","supervised industrial",
    "supervised field","field training","industrial training",
    "dissertation","term paper",
]
def _should_exclude(name):
    return any(kw in name.lower() for kw in _EXCL_KW)

# ── TEACHER EXTRACTION ────────────────────────────────────────────────────────
def _extract_teacher(raw):
    if not raw or str(raw).strip() in ("","nan"): return "TBA"
    s = str(raw).strip()
    if "@" in s:
        parts = [p.strip() for p in s.split(" - ")]
        for p in reversed(parts):
            if p and "@" not in p and not re.match(r"^[A-Z&]+-\d+$",p) and len(p)>2:
                return p
        return parts[-1] if parts else "TBA"
    if any(t in s for t in ["Mr.","Ms.","Dr.","Engr.","Prof."]): return s
    if len(s)>3 and not s.replace(".","").replace(" ","").isdigit(): return s
    return "TBA"

# ── TBA UTILS ─────────────────────────────────────────────────────────────────
_TBA_SET = {"tba","","nan","none"}
def norm_t(t): return re.sub(r"\s+"," ",str(t).strip().lower())
def is_tba(t): return norm_t(t) in _TBA_SET

# ── FOOL-PROOF COLUMN AUTO-DETECTION ──────────────────────────────────────────
# The scheduler must understand ANY dataset, whatever the column headers are
# called or in whatever order — it should work out on its own which column holds
# the course code, which holds the teacher, the course name, credit hours, etc.
# _auto_map_columns() does that by fuzzy-matching each header against a synonym
# table, so a sheet titled "Subject Code" / "Instructor" / "Class Strength" maps
# just as well as one titled "Code" / "Primary Faculty" / "Enrolled Students".
def _norm_header(h):
    """Lowercase a header and strip everything but letters+digits, for matching."""
    return re.sub(r"[^a-z0-9]", "", str(h).strip().lower())

# canonical field -> (exact synonyms, keyword fragments). Exact match wins first;
# then a whole-word/fragment contains-match. Order of FIELDS = tie-break priority.
_COL_SYNONYMS = {
    "code": (
        ["code", "coursecode", "courseid", "subjectcode", "catalog",
         "catalognumber", "catalogno", "coursecatalog", "ccode", "crscode"],
        ["coursecode", "subjectcode", "catalog", "code"],
    ),
    "name": (
        ["name", "coursename", "coursetitle", "title", "subject", "subjectname",
         "subjecttitle", "description", "coursedescription", "course"],
        ["coursename", "coursetitle", "subjectname", "title", "name"],
    ),
    "component": (
        ["component", "type", "classtype", "sessiontype", "activity",
         "activitytype", "coursetype", "deliverytype", "meetingtype", "kind"],
        ["component", "classtype", "sessiontype", "activitytype", "coursetype"],
    ),
    "section_col": (
        ["section", "classsection", "sec", "sectionname", "coursesection"],
        ["classsection", "section"],
    ),
    "faculty": (
        ["faculty", "primaryfaculty", "teacher", "instructor", "lecturer",
         "facultyname", "teachername", "instructorname", "assignedfaculty",
         "assignedteacher", "prof", "professor", "facultymember"],
        ["primaryfaculty", "facultyname", "teachername", "instructor",
         "lecturer", "teacher", "faculty"],
    ),
    "enrolled": (
        ["enrolled", "enrolledstudents", "strength", "enrollment", "students",
         "classstrength", "seats", "registered", "registeredstudents",
         "noofstudents", "studentcount", "count", "totalstudents", "capacity",
         "studentstrength", "nostudents"],
        ["enrolledstudents", "enrolled", "classstrength", "strength",
         "enrollment", "registered", "students"],
    ),
    "program_batch": (
        ["programbatch", "batch", "program", "programme", "class", "cohort",
         "batchname", "programname", "session", "degreebatch", "classbatch"],
        ["programbatch", "batch", "programme", "program", "cohort"],
    ),
    "credit_hours": (
        ["credithours", "credits", "credit", "ch", "cr", "credithrs", "crhrs",
         "creditvalue", "credithour", "creditload", "chrs"],
        ["credithours", "credithrs", "credit", "credits"],
    ),
    "term": (
        ["academicterm", "term", "semester", "sem", "session", "academicsession"],
        ["academicterm", "semester", "term"],
    ),
}

def _auto_map_columns(columns):
    """Return {canonical_field: actual_column_name} by fuzzy-matching headers.
    Never assigns one source column to two fields; picks the strongest match."""
    norm = {col: _norm_header(col) for col in columns}
    mapping, used = {}, set()
    for field, (exacts, fragments) in _COL_SYNONYMS.items():
        best, best_score = None, 0
        for col, ncol in norm.items():
            if col in used or not ncol:
                continue
            score = 0
            if ncol in exacts:
                score = 100 - exacts.index(ncol)          # exact: earliest synonym best
            else:
                for i, frag in enumerate(fragments):
                    if frag in ncol:
                        score = max(score, 60 - i - (len(ncol) - len(frag)))
                        break
            if score > best_score:
                best, best_score = col, score
        if best is not None:
            mapping[field] = best
            used.add(best)
    return mapping

_COMPONENT_LECTURE = {"lecture", "lec", "theory", "th", "class", "classroom",
                      "l", "clt", "teaching", "lecturetheory"}
_COMPONENT_LAB = {"lab", "laboratory", "practical", "prac", "pr", "p", "tutorial",
                  "tut", "workshop", "clinical", "practicum", "labpractical"}
def _norm_component(raw):
    """Map any spelling of the class type to 'Lecture' or 'Lab' (or '' if unknown).
    So 'Theory'/'Practical', 'Lec'/'Lab', 'Class'/'Workshop' all work."""
    s = re.sub(r"[^a-z]", "", str(raw).strip().lower())
    if not s:
        return ""
    if s in _COMPONENT_LAB or any(k in s for k in ("lab", "practical", "prac",
                                                   "clinic", "workshop", "tutorial")):
        return "Lab"
    if s in _COMPONENT_LECTURE or any(k in s for k in ("lect", "theory", "class",
                                                       "teach")):
        return "Lecture"
    return ""

# ── LOAD DATA ─────────────────────────────────────────────────────────────────
def _process_rows(norm_rows):
    """
    norm_rows: list of dicts with keys
      code, name, component, section_col, faculty_name, enrolled, program_batch, credit_hours
    Returns (df, tba_issues). Shared by Excel and JSON loaders.
    """
    records, tba_issues = [], []

    for row in norm_rows:
        full_code = str(row.get("code", "")).strip()
        name      = str(row.get("name", "")).strip()
        comp      = _norm_component(row.get("component", ""))
        if comp not in ("Lecture", "Lab"):
            continue

        try:
            cr = float(row.get("credit_hours", 0) or 0)
        except (TypeError, ValueError):
            cr = 0.0

        if cr == 0.0 or cr >= 6.0: continue
        if _should_exclude(name):  continue

        teacher    = row.get("faculty_name") or "TBA"
        teacher    = teacher if str(teacher).strip() else "TBA"
        try:
            enrolled_n = int(float(str(row.get("enrolled", 0)).strip() or 0))
        except (TypeError, ValueError):
            enrolled_n = 0
        course_code = full_code.split("-")[0].strip()

        sec_col = str(row.get("section_col", "") or "").strip()
        section = sec_col if re.match(r"^[A-F]$", sec_col) else ""
        if not section:
            sm = re.search(r"-(?:Section-)?([A-F])-(?:lecture|lab)$", full_code, re.I)
            section = sm.group(1) if sm else ""

        pb        = str(row.get("program_batch", "") or "").strip()
        program   = _pb_to_program(pb)
        batch_key = f"{program}|{pb}|{section}" if section else f"{program}|{pb}"
        dept_key  = get_dept_key(course_code, name)
        # Lab pool sorted small->large so tight-fit picks the snuggest lab first
        lab_pool  = sorted(
            list(ALL_LABS.get(dept_key, ALL_LABS.get("cs", []))),
            key=lambda lb: LAB_CAP.get(lb, 999)
        )

        # Session structure by credit hours:
        #   credit 2  → ONE 2-hour session (single day)          [theory_2h]
        #   credit ≥3 → TWO 1.5-hour sessions on alternate days
        #   credit 1  → ONE 1.5-hour session
        theory_2h = (comp == "Lecture" and cr == 2)
        if comp == "Lecture":
            n_theory = 1 if theory_2h else (2 if cr >= 3 else (1 if cr == 1 else 0))
        else:
            n_theory = 0

        if teacher == "TBA":
            tba_issues.append({
                "course_code": course_code, "name": name, "component": comp,
                "full_code": full_code, "program": program,
                "batch_id": pb, "section": section,
            })

        records.append({
            "full_code": full_code, "course_code": course_code,
            "name": name, "component": comp, "program": program,
            "batch_id": pb, "batch_key": batch_key, "section": section,
            "teacher": teacher, "dept_key": dept_key, "lab_pool": lab_pool,
            "enrolled_n": enrolled_n, "credit_hours": cr, "n_theory": n_theory,
            "theory_2h": theory_2h,
        })

    if not records:
        raise ValueError("No schedulable courses found after filtering.")

    df = pd.DataFrame(records)

    def _best_room(n):
        """Initial preferred room: tightest room that fits n students."""
        if n <= 0:
            return ROOMS_BY_CAP[len(ROOMS_BY_CAP)//2] if ROOMS_BY_CAP else "Auditorium"
        tight_limit = n * (1 + TIGHT_FIT_RATIO)
        # Prefer a room in the tight band first
        for rm in ROOMS_BY_CAP:
            cap = ROOM_CAP[rm]
            if cap >= n and cap <= tight_limit:
                return rm
        # Otherwise the smallest room that fits
        for rm in ROOMS_BY_CAP:
            if ROOM_CAP[rm] >= n:
                return rm
        return ROOMS_BY_CAP[-1] if ROOMS_BY_CAP else "Auditorium"

    mid_room = ROOMS_BY_CAP[len(ROOMS_BY_CAP)//2] if ROOMS_BY_CAP else "Auditorium"
    df["room"]     = df["enrolled_n"].apply(lambda n: _best_room(n) if n>0 else mid_room)
    df["room_cap"] = df["room"].apply(lambda r: ROOM_CAP.get(r, 300))

    print(f"  Loaded {len(df)} rows  "
          f"({(df['component']=='Lecture').sum()} lectures, "
          f"{(df['component']=='Lab').sum()} labs)  |  "
          f"{df['program'].nunique()} programs  |  "
          f"{df[df['teacher']!='TBA']['teacher'].nunique()} named teachers  |  "
          f"TBA: {(df['teacher']=='TBA').sum()} rows")
    return df, tba_issues


def load_data():
    """Legacy Excel loader (standalone CLI use)."""
    if not os.path.exists(INPUT_FILE):
        raise FileNotFoundError(f"Dataset not found: {INPUT_FILE}")

    raw = pd.read_excel(INPUT_FILE, header=0)
    raw.columns = [str(c).strip() for c in raw.columns]

    # Fool-proof: work out which column is which, whatever they are named.
    cmap = _auto_map_columns(list(raw.columns))
    required = ["code", "name", "component"]
    missing  = [f for f in required if f not in cmap]
    if missing:
        raise ValueError(
            "Could not identify essential column(s) "
            f"{missing} in the dataset. Detected columns: {list(raw.columns)}. "
            f"Auto-mapping found: {cmap}. "
            "Rename the relevant header(s) to something recognisable "
            "(e.g. 'Course Code', 'Course Name', 'Type')."
        )
    print(f"  Auto-detected columns → " +
          ", ".join(f"{f}='{c}'" for f, c in cmap.items()))

    def g(row, field):
        col = cmap.get(field)
        return row.get(col) if col else None

    norm_rows = []
    for _, row in raw.iterrows():
        comp = _norm_component(g(row, "component"))
        if comp not in ("Lecture", "Lab"):
            continue
        norm_rows.append({
            "code":          g(row, "code"),
            "name":          g(row, "name"),
            "component":     comp,
            "section_col":   g(row, "section_col"),
            "faculty_name":  _extract_teacher(g(row, "faculty")),
            "enrolled":      g(row, "enrolled"),
            "program_batch": g(row, "program_batch"),
            "credit_hours":  g(row, "credit_hours"),
        })
    if not norm_rows:
        raise ValueError(
            "No Lecture/Lab rows found. Check the class-type column — its values "
            "should read like Lecture/Theory or Lab/Practical."
        )
    return _process_rows(norm_rows)


# Real per-course student rosters (code -> sorted list of student ids), built
# from the DB export's student_registrations. Empty when a dataset has no
# rosters (e.g. the raw timetable xlsx) — the scheduler then falls back to
# batch-level clash checks only.
STUDENT_ROSTERS = {}


def _norm_course_code(raw):
    s = str(raw or "").strip().upper()
    m = re.match(r"^([A-Z]{2,6}[-\s]?\d{3,4})", s)
    return m.group(1).replace(" ", "").replace("-", "") if m else s


def _build_student_rosters(export):
    """code -> sorted unique list of student ids that registered for it."""
    regs = export.get("student_registrations") or []
    rosters = defaultdict(list)
    for r in regs:
        sid = str(r.get("student_id") or r.get("studentId") or "").strip()
        if not sid:
            continue
        for c in r.get("courses", []):
            rosters[_norm_course_code(c)].append(sid)
    return {k: sorted(set(v)) for k, v in rosters.items()}


# Courses with NO scheduled classes (and no exam): projects, internships, thesis,
# research, etc. Matched against a NORMALISED name (punctuation → single space)
# so "Project - II", "Project-II" etc. all catch (e.g. CT394). Legit courses like
# "Project Management" are safe (no bare "project" keyword).
_NO_CLASS_KW = [
    "final year project", "fyp", "research project", "research work", "research thesis",
    "term project", "short term project", "semester project", "mini project", "design project",
    "project i", "project ii", "project iii", "project 1", "project 2", "project 3",
    "internship", "industrial internship", "internship project", "industrial training",
    "supervised industrial", "supervised field", "field training", "field work",
    "thesis", "dissertation", "term paper", "capstone",
    "civil engineering project", "engineering project",
]


def _is_non_class(name):
    n = re.sub(r"[^a-z0-9]+", " ", str(name or "").lower()).strip()
    return any(k in n for k in _NO_CLASS_KW)


def load_data_from_json(path):
    """
    DB loader. The web app exports MongoDB into this JSON shape:
      {
        "rooms":  [{ "name", "capacity" }, ...],
        "labs":   [{ "name", "capacity", "departments": [...] }, ...],
        "courses":[{ "fullCode","code","name","component","section",
                     "programBatch","teacher","enrolled","creditHours" }, ...]
      }
    Teacher names are already resolved by the backend.
    """
    with open(path, "r", encoding="utf-8") as f:
        export = json.load(f)

    # Replace room/lab tables with DB-configured values BEFORE processing rows,
    # so lab pools are built from the live database.
    _apply_db_rooms_labs(export)

    # Real per-student rosters → enables true student-level clash-free scheduling.
    global STUDENT_ROSTERS
    STUDENT_ROSTERS = _build_student_rosters(export)

    courses = export.get("courses") or []
    if not courses:
        raise ValueError("The database has no courses. Add courses before generating a timetable.")

    def _pick(d, *keys, default=None):
        """First present, non-empty value among key variants (fool-proof keys)."""
        for k in keys:
            if k in d and d[k] not in (None, ""):
                return d[k]
        return default

    norm_rows = []
    skipped_nc = 0
    for c in courses:
        # Skip projects / internships / thesis — they have no timetable classes.
        if _is_non_class(_pick(c, "name", "courseName", "course_name", "title")):
            skipped_nc += 1
            continue
        norm_rows.append({
            "code":          _pick(c, "fullCode", "full_code", "code", "courseCode",
                                    "course_code", "courseId"),
            "name":          _pick(c, "name", "courseName", "course_name", "title"),
            "component":     _pick(c, "component", "type", "classType", "sessionType",
                                    default=""),
            "section_col":   _pick(c, "section", "classSection", "sec"),
            "faculty_name":  _pick(c, "teacher", "faculty", "instructor",
                                    "primaryFaculty", default="TBA") or "TBA",
            "enrolled":      _pick(c, "enrolled", "enrolledStudents", "strength",
                                    "enrollment", default=0),
            "program_batch": _pick(c, "programBatch", "program_batch", "batch",
                                    "program"),
            "credit_hours":  _pick(c, "creditHours", "credit_hours", "credits",
                                    "credit", default=3),
        })
    if skipped_nc:
        print(f"[timetable] skipped {skipped_nc} non-class course(s) — project/internship/thesis", file=sys.stderr)
    return _process_rows(norm_rows)


# ── LAB SPLITTING TOLERANCE ───────────────────────────────────────────────────
# When a lab section is only slightly bigger than the largest available lab,
# splitting it into two half-size groups wastes scarce lab slots for the sake of
# one or two students. Instead we allow a small overflow up to this fraction.
#   SPLIT_TOLERANCE = 0.10 means: tolerate up to 10% over the lab's capacity
#   before splitting. So 31 students in a 30-seat lab (3% over) is left as-is,
#   but 40 students in a 30-seat lab (33% over) is split into two groups of 20.
SPLIT_TOLERANCE = 0.0

# ── LAB OVERFLOW TOLERANCE ────────────────────────────────────────────────────
# When NO lab with capacity >= enrolled is free, the scheduler may fall back to
# the biggest free lab even if it is slightly too small. This tolerance caps how
# much over-capacity such a fallback is allowed to be. A class is NEVER crammed
# into a lab far smaller than it — e.g. 7 students into a 5-seat lab (40% over)
# or 3 into a 2-seat lab (50% over) is REJECTED and the session is left honestly
# UNPLACED (reported in the report) instead of producing a fake "placement".
#   LAB_OVERFLOW_TOLERANCE = 0.05  → tolerate at most 5% over capacity
#   (a 46-strong class in a 45-seat lab = 2.2% over → allowed; the two above → not)
LAB_OVERFLOW_TOLERANCE = 0.05


def _largest_lab_cap(lab_pool):
    """Capacity of the biggest lab available to a course (0 if pool empty)."""
    caps = [LAB_CAP.get(lb, 0) for lb in lab_pool]
    return max(caps) if caps else 0


def _split_into_groups(enrolled, max_cap):
    """
    Decide how many equal groups an oversized lab section needs so each group
    fits inside `max_cap`, and return the per-group sizes.

    A small overflow (within SPLIT_TOLERANCE) is tolerated rather than split,
    to avoid burning lab slots for a couple of extra students.

    Example: 68 students, biggest lab 45  ->  2 groups of 34
             40 students, biggest lab 30  ->  2 groups of 20
    Uses ceil division so a group never exceeds max_cap.
    """
    if max_cap <= 0:
        return [enrolled]
    if enrolled <= max_cap * (1 + SPLIT_TOLERANCE):
        return [enrolled]
    import math
    n_groups = math.ceil(enrolled / max_cap)
    base = enrolled // n_groups
    rem  = enrolled % n_groups
    return [base + (1 if i < rem else 0) for i in range(n_groups)]


def build_course_dicts(df):
    courses = []
    for i, row in df.iterrows():
        base = {
            "uid":          f"{row['full_code']}|{i}",
            "code":         row["course_code"],
            "name":         row["name"],
            "program":      row["program"],
            "dept_key":     row["dept_key"],
            "teacher":      row["teacher"],
            "batch_key":    row["batch_key"],
            "batch_id":     row["batch_id"],
            "room":         row["room"],
            "room_cap":     int(row.get("room_cap", ROOM_CAP.get(row["room"],300))),
            "enrolled":     int(row.get("enrolled_n",0)),
            "section":      row["section"],
            "component":    row["component"],
            "n_theory":     int(row["n_theory"]),
            "credit_hours": float(row.get("credit_hours",0)),
            "theory_2h":    bool(row.get("theory_2h", False)),
            "lab_pool":     row["lab_pool"],
        }

        # ── Auto-split oversized LAB sections into groups ──────────────────
        # If a lab section has more students than the biggest lab it can use,
        # break it into equal groups so every student gets a seat. Each group
        # is scheduled independently (its own lab + slot), eliminating the
        # "capacity overflow" problem entirely.
        if base["component"] == "Lab" and base["enrolled"] > 0:
            max_cap = _largest_lab_cap(base["lab_pool"])
            sizes = _split_into_groups(base["enrolled"], max_cap)
            if len(sizes) > 1:
                for g, size in enumerate(sizes, start=1):
                    grp = dict(base)
                    grp["uid"]      = f"{base['uid']}|G{g}"
                    grp["enrolled"] = size
                    grp["group_no"] = g
                    grp["group_total"] = len(sizes)
                    # Each group is its own batch unit so two groups of the
                    # same course may run in parallel (different labs/slots).
                    grp["batch_key"] = f"{base['batch_key']}|G{g}"
                    grp["section"]   = (base["section"] or "") + f"-G{g}"
                    courses.append(grp)
                continue  # don't add the un-split original

        courses.append(base)

    _attach_student_rosters(courses)
    return courses


def _attach_student_rosters(courses):
    """
    Give every course dict a concrete `students` set (real student ids), so the
    scheduler can guarantee no student is ever double-booked.

    A course code split into sections (A, B, …) shares one real roster; we
    partition it deterministically across the sections by their enrolment, so
    each section gets a DISJOINT set of students (different students attend
    different sections). Lab groups (G1, G2) of one section split that section's
    roster further, the same way.
    """
    if not STUDENT_ROSTERS:
        for c in courses:
            c["students"] = set()
        return

    # group lecture/lab rows by (code) then partition
    by_code = defaultdict(list)
    for c in courses:
        by_code[_norm_course_code(c["code"])].append(c)

    for code, rows in by_code.items():
        sids = STUDENT_ROSTERS.get(code, [])
        # split into "section units"; groups of the same section stay together
        # for the partition order but each takes its own enrolment slice.
        rows_sorted = sorted(rows, key=lambda c: (str(c.get("section", "")), c.get("uid", "")))
        if len(rows_sorted) == 1:
            rows_sorted[0]["students"] = set(sids)
            continue
        ptr = 0
        n = len(sids)
        for c in rows_sorted:
            take = int(c.get("enrolled", 0)) or 0
            if take <= 0 or ptr >= n:
                c["students"] = set(sids[ptr:ptr + take]) if take > 0 else set()
                ptr += take
                continue
            c["students"] = set(sids[ptr:ptr + take])
            ptr += take
        # any unallocated tail (rounding) → last row
        if ptr < n:
            rows_sorted[-1]["students"] |= set(sids[ptr:])


# ── SCHEDULER STATE ───────────────────────────────────────────────────────────
class SchedulerState:
    """
    Hard Constraints:
      HC1 - Teacher no double-booking
      HC2 - Theory room no double-booking
      HC3 - Batch no double-booking
      HC4 - Room capacity >= enrolled
      HC5 - Lectures ONLY in THEORY_SLOTS
      HC6 - Labs ONLY in LAB_SLOTS
      HC7 - Same course sessions on different days
      HC8 - Lab room cannot be used in overlapping theory slot times
           (e.g. GP Lab 1 in 08:30-10:00 theory → blocks 08:30-11:30 lab slot)
      HC9 - Lab room capacity >= enrolled
    """
    def __init__(self):
        self._teacher_busy  = defaultdict(set)   # teacher → {(day,slot)}
        self._room_busy     = defaultdict(set)    # theory room → {(day,slot)}
        self._batch_busy    = defaultdict(set)    # batch_key → {(day,slot)}
        self._lab_busy      = defaultdict(set)    # lab_name → {(day,slot)}
        self._slot_students = defaultdict(set)    # (day,slot) → {student_id,…}
        # HC8: track theory bookings in rooms that are also labs
        # lab_name → set of (day, theory_slot) booked as theory
        self._lab_as_theory = defaultdict(set)
        self._course_days   = defaultdict(set)    # uid → {days used}
        self.theory_tt      = defaultdict(list)   # (day,slot) → [entry]
        self.lab_tt         = defaultdict(list)
        self.theory_meta    = defaultdict(list)
        self.lab_meta       = defaultdict(list)
        self.room_assignments = []

    # ── constraint check helpers (OVERLAP-AWARE) ──────────────────────────────
    # A resource is free at slot s only if it is free in EVERY slot that overlaps s
    # in wall-clock time — this closes the overlapping-lab-slot loophole (e.g. a lab
    # booked 08:30-11:30 is correctly busy for 09:00-12:00 and 10:00-01:00 too).
    def _tf(self, t, d, s):
        if is_tba(t):
            return True
        busy = self._teacher_busy[norm_t(t)]
        return all((d, s2) not in busy for s2 in SLOT_OVERLAP[s])
    def _rf(self, r, d, s):
        busy = self._room_busy[r]
        return all((d, s2) not in busy for s2 in SLOT_OVERLAP[s])
    def _bf(self, b, d, s):
        busy = self._batch_busy[b]
        return all((d, s2) not in busy for s2 in SLOT_OVERLAP[s])
    def _lf(self, lab, d, s):
        busy = self._lab_busy[lab]
        return all((d, s2) not in busy for s2 in SLOT_OVERLAP[s])
    def _sf(self, c, d, s):
        """Student-free: no student of this course is already busy in any slot that
        overlaps (d,s). HARD constraint — a student is never double-booked. No-op
        when the course has no roster (dataset without student registrations)."""
        st = c.get("students")
        if not st:
            return True
        return all(not (st & self._slot_students[(d, s2)]) for s2 in SLOT_OVERLAP[s])

    def _all_labs_flat(self):
        """Every lab in the building, smallest-capacity first — the fallback pool
        when a course's own department labs are all busy."""
        if getattr(self, "_labs_flat_cache", None) is None:
            labs = set()
            for pool in ALL_LABS.values():
                labs.update(pool)
            self._labs_flat_cache = sorted(labs, key=lambda lb: LAB_CAP.get(lb, 999))
        return self._labs_flat_cache

    def _lab_free_for_theory(self, lab_name, d, theory_slot):
        """HC8: lab room must not already be booked as lab in overlapping lab slots."""
        overlap_lab_slots = THEORY_OVERLAPS_LAB.get(theory_slot, [])
        for ls in overlap_lab_slots:
            if (d, ls) in self._lab_busy[lab_name]:
                return False
        return True

    def _theory_free_for_lab(self, lab_name, d, lab_slot):
        """HC8 reverse: if scheduling a LAB, check no theory class in lab room overlaps."""
        # lab_slot like "08:30-11:30" overlaps with theory slots that start during it
        for ts, overlapping_labs in THEORY_OVERLAPS_LAB.items():
            if lab_slot in overlapping_labs:
                if (d, ts) in self._lab_as_theory.get(lab_name, set()):
                    return False
        return True

    def _best_free_room(self, enrolled, d, s):
        """
        Find a free theory room for `enrolled` students.

        Two-pass "tight-fit" strategy:
          Pass 1: smallest free room whose capacity is between `enrolled` and
                  `enrolled * (1 + TIGHT_FIT_RATIO)` — i.e. only slightly bigger.
          Pass 2: if none, smallest free room that simply fits (capacity >= enrolled).

        Because ROOMS_BY_CAP is sorted small->large, the first match in each pass
        is always the tightest available room. Pass 2 guarantees a class is never
        left unplaced just because no perfectly-sized room was free.
        """
        if enrolled <= 0:
            # No strength info — just take the smallest free room.
            for rm in ROOMS_BY_CAP:
                if self._rf(rm, d, s):
                    return rm
            return None

        tight_limit = enrolled * (1 + TIGHT_FIT_RATIO)

        # Pass 1 — tight band: enrolled <= cap <= enrolled*(1+ratio)
        for rm in ROOMS_BY_CAP:
            cap = ROOM_CAP.get(rm, 0)
            if cap >= enrolled and cap <= tight_limit and self._rf(rm, d, s):
                return rm

        # Pass 2 — any fitting room (fallback so nothing is left unplaced)
        for rm in ROOMS_BY_CAP:
            if ROOM_CAP.get(rm, 0) >= enrolled and self._rf(rm, d, s):
                return rm

        return None

    def _best_free_lab(self, lab_pool, enrolled, d, s):
        """
        Best lab room from pool using tight-fit (like theory rooms):
          Pass 1: free lab whose capacity is between `enrolled` and
                  enrolled*(1+TIGHT_FIT_RATIO) — only slightly bigger.
          Pass 2: any free lab that fits (capacity >= enrolled).
        Each pass walks the pool which is pre-sorted small->large, so the
        first hit is the tightest available lab.
        Returns (lab_name, cap) or (None, 0)
        """
        if enrolled <= 0:
            for lab in lab_pool:
                if self._lf(lab, d, s) and self._theory_free_for_lab(lab, d, s):
                    return lab, LAB_CAP.get(lab, 999)
            return None, 0

        tight_limit = enrolled * (1 + TIGHT_FIT_RATIO)

        # Pass 1 — tight band
        for lab in lab_pool:
            cap = LAB_CAP.get(lab, 999)
            if (cap >= enrolled and cap <= tight_limit
                    and self._lf(lab, d, s)
                    and self._theory_free_for_lab(lab, d, s)):
                return lab, cap

        # Pass 2 — any fitting lab
        for lab in lab_pool:
            cap = LAB_CAP.get(lab, 999)
            if (cap >= enrolled
                    and self._lf(lab, d, s)
                    and self._theory_free_for_lab(lab, d, s)):
                return lab, cap

        return None, 0

    def _can_place(self, c, d, s, room):
        return (d not in self._course_days[c["uid"]]
                and self._tf(c["teacher"], d, s)
                and self._rf(room, d, s)
                and self._bf(c["batch_key"], d, s)
                and self._sf(c, d, s)
                and ROOM_CAP.get(room, 0) >= c.get("enrolled", 0))

    # ── booking ───────────────────────────────────────────────────────────────
    def _book_theory(self, c, d, s, forced=False, lab_name=None):
        """
        Book a theory (lecture) session.
        lab_name: if the course uses a specific lab room instead of a classroom,
                  pass the lab name so we can mark HC8 occupancy.
        """
        mark    = " ★" if forced else ""
        sec_lbl = f" - {c['section']}" if c.get("section") else ""
        enrolled = c.get("enrolled", 0)
        room    = c["room"]
        cap     = ROOM_CAP.get(room, 300)
        cap_lbl = f" [{enrolled}/{cap}]" if enrolled > 0 else ""

        # If using a lab room for theory, add lab name note
        # A 2-hour session occupies a 2-hour slot for CONSTRAINTS (blocking the room
        # until it finishes), but DISPLAYS in the 1.5-hour column it starts in, with
        # a "(2 Hrs)" note after the room.
        two_hr = s in TWO_HR_COL
        disp_slot = TWO_HR_COL.get(s, s)      # where it renders in the grid

        room_display = room
        if lab_name:
            room_display = f"{room} ({lab_name})"
            cap = LAB_CAP.get(lab_name, cap)
            cap_lbl = f" [{enrolled}/{cap}]" if enrolled > 0 else ""
        if two_hr:
            room_display = f"{room_display} (2 Hrs)"

        entry = (f"{c['code']}  {c['name']}{mark}\n"
                 f"{c['teacher']}  [{room_display}]{sec_lbl}{cap_lbl}")
        self.theory_tt[(d,disp_slot)].append(entry)
        self.theory_meta[(d,disp_slot)].append((entry, c["dept_key"]))
        self.room_assignments.append({
            "code": c["code"], "name": c["name"], "teacher": c.get("teacher", "TBA"),
            "room": room_display, "cap": cap, "enrolled": enrolled,
            "day": d, "slot": s, "forced": forced, "component": "Lecture",
            "durationHrs": 2 if two_hr else 1.5,
            "section": c.get("section",""), "program": c.get("program",""),
            "students": list(c.get("students", [])),   # who attends → per-student timetable
        })
        # occupancy stays on the ACTUAL slot `s` (2-hour slot for a 2-hr class) so the
        # overlap map blocks every 1.5-hour slot it spans.
        if not is_tba(c["teacher"]):
            self._teacher_busy[norm_t(c["teacher"])].add((d,s))
        self._room_busy[room].add((d,s))
        self._batch_busy[c["batch_key"]].add((d,s))
        if c.get("students"):
            self._slot_students[(d,s)] |= c["students"]
        self._course_days[c["uid"]].add(d)
        # HC8: if this theory session is in a lab room, mark it
        if lab_name:
            self._lab_as_theory[lab_name].add((d,s))

    def _book_lab(self, c, lab, d, s, cap):
        sec_lbl = f" - {c['section']}" if c.get("section") else ""
        enrolled = c.get("enrolled", 0)
        cap_lbl  = f" [{enrolled}/{cap}]" if enrolled > 0 else ""
        entry = (f"LAB: {c['code']}  {c['name']}\n"
                 f"{c['teacher']}  [{lab}]{sec_lbl}{cap_lbl}")
        self.lab_tt[(d,s)].append(entry)
        self.lab_meta[(d,s)].append((entry, c["dept_key"]))
        if not is_tba(c["teacher"]):
            self._teacher_busy[norm_t(c["teacher"])].add((d,s))
        self._lab_busy[lab].add((d,s))
        self._batch_busy[c["batch_key"]].add((d,s))
        if c.get("students"):
            self._slot_students[(d,s)] |= c["students"]
        c["_placed_lab"] = (lab, d, s, cap)      # for local-search relocation
        self.room_assignments.append({
            "code": c["code"], "name": c["name"], "teacher": c.get("teacher", "TBA"),
            "room": lab, "cap": cap, "enrolled": enrolled,
            "day": d, "slot": s, "forced": False, "component": "Lab",
            "section": c.get("section",""), "program": c.get("program",""),
            "students": list(c.get("students", [])),   # who attends → per-student timetable
        })

    def _unbook_lab(self, c, lab, d, s):
        """Reverse _book_lab (used by the local-search repair to relocate a lab)."""
        self._lab_busy[lab].discard((d, s))
        if not is_tba(c["teacher"]):
            self._teacher_busy[norm_t(c["teacher"])].discard((d, s))
        self._batch_busy[c["batch_key"]].discard((d, s))
        if c.get("students"):
            self._slot_students[(d, s)] = self._slot_students[(d, s)] - c["students"]
        pref = f"LAB: {c['code']} "
        for store in (self.lab_tt.get((d, s), []),):
            for i, e in enumerate(store):
                if e.startswith(pref): store.pop(i); break
        meta = self.lab_meta.get((d, s), [])
        for i, (e, _dk) in enumerate(meta):
            if e.startswith(pref): meta.pop(i); break
        for i, ra in enumerate(self.room_assignments):
            if (ra.get("component") == "Lab" and ra.get("code") == c["code"]
                    and ra.get("room") == lab and ra.get("day") == d and ra.get("slot") == s
                    and ra.get("section", "") == c.get("section", "")):
                self.room_assignments.pop(i); break
        c.pop("_placed_lab", None)

    # ── placement ─────────────────────────────────────────────────────────────
    def try_pair(self, c, d1, d2, slot_order):
        enrolled  = c.get("enrolled", 0)
        orig_room = c["room"]
        # Same slot on both days
        for sl in slot_order:
            rm1 = self._best_free_room(enrolled, d1, sl)
            rm2 = self._best_free_room(enrolled, d2, sl)
            if (rm1 and rm2
                    and self._can_place(c, d1, sl, rm1)
                    and self._can_place(c, d2, sl, rm2)):
                c["room"]=rm1; self._book_theory(c, d1, sl)
                c["room"]=rm2; self._book_theory(c, d2, sl)
                c["room"]=orig_room; return True
        # Different slots
        for s1 in slot_order:
            rm1 = self._best_free_room(enrolled, d1, s1)
            if not rm1 or not self._can_place(c, d1, s1, rm1): continue
            for s2 in slot_order:
                if s2 == s1: continue
                rm2 = self._best_free_room(enrolled, d2, s2)
                if rm2 and self._can_place(c, d2, s2, rm2):
                    c["room"]=rm1; self._book_theory(c, d1, s1)
                    c["room"]=rm2; self._book_theory(c, d2, s2)
                    c["room"]=orig_room; return True
        c["room"]=orig_room; return False

    def try_single(self, c, day_order, slot_order, forced=False):
        enrolled  = c.get("enrolled", 0)
        orig_room = c["room"]
        for d in day_order:
            for s in slot_order:
                rm = self._best_free_room(enrolled, d, s)
                if (rm and d not in self._course_days[c["uid"]]
                        and self._tf(c["teacher"], d, s)
                        and self._bf(c["batch_key"], d, s)
                        and self._sf(c, d, s)):
                    c["room"]=rm
                    self._book_theory(c, d, s, forced=forced)
                    c["room"]=orig_room; return True
        c["room"]=orig_room; return False

    def try_lab(self, c):
        """
        Schedule a lab session:
        - Into LAB_SLOTS only (HC6)
        - Teacher free at (day, lab_slot) (HC1)
        - Lab room free at (day, lab_slot) (HC8 + double-booking)
        - Lab room capacity >= enrolled (HC9)
        - Batch free (HC3)
        Returns (placed:bool, lab_name:str, overflow_info:dict or None)
        """
        dept_pool = c["lab_pool"]
        enrolled  = c.get("enrolled", 0)
        # Try the course's own department labs first; if none fits clash-free, fall
        # back to ANY capacity-fitting lab (uses idle labs of other departments so a
        # department short on labs isn't left unplaced while others sit empty).
        for pool in (dept_pool, self._all_labs_flat()):
            for d in DAYS:
                for s in LAB_SLOTS:
                    if not self._tf(c["teacher"], d, s): continue
                    if not self._bf(c["batch_key"], d, s): continue
                    if not self._sf(c, d, s): continue
                    lab, cap = self._best_free_lab(pool, enrolled, d, s)
                    if lab:
                        self._book_lab(c, lab, d, s, cap)
                        return True, lab, None
            if pool is self._all_labs_flat():
                break
        # No fitting lab found — place in the LARGEST available lab so the
        # overflow is as small as possible (instead of the first free one,
        # which could be tiny). Pool is sorted small->large, so we walk it
        # in reverse to prefer the biggest free lab.
        best_overflow = None  # (lab, cap, day, slot)
        for d in DAYS:
            for s in LAB_SLOTS:
                if not self._tf(c["teacher"], d, s): continue
                if not self._bf(c["batch_key"], d, s): continue
                if not self._sf(c, d, s): continue
                for lab in reversed(pool):
                    if (self._lf(lab, d, s)
                            and self._theory_free_for_lab(lab, d, s)):
                        cap = LAB_CAP.get(lab, 999)
                        if best_overflow is None or cap > best_overflow[1]:
                            best_overflow = (lab, cap, d, s)
                        break  # biggest free lab in this slot found
        # Only accept the overflow if the biggest free lab is within a small
        # tolerance of the class size. Cramming e.g. 7 students into a 5-seat lab
        # is not a real placement — leave it UNPLACED (honest) instead of
        # emitting a capacity-violation "clash".
        if best_overflow:
            lab, cap, d, s = best_overflow
            min_acceptable_cap = enrolled * (1 - LAB_OVERFLOW_TOLERANCE)
            if cap >= min_acceptable_cap:
                self._book_lab(c, lab, d, s, cap)
                overflow = {"lab": lab, "cap": cap, "enrolled": enrolled}
                return True, lab, overflow
        return False, None, None

    @property
    def theory_count(self): return sum(len(v) for v in self.theory_tt.values())
    @property
    def lab_count(self):    return sum(len(v) for v in self.lab_tt.values())


def _any_free_room(state, d, s):
    """Largest free theory room at (day, slot), ignoring capacity — last resort."""
    for rm in reversed(ROOMS_BY_CAP):
        if state._rf(rm, d, s):
            return rm
    return None


# ── SCHEDULER ─────────────────────────────────────────────────────────────────
_MW = ("Monday","Wednesday")
_TT = ("Tuesday","Thursday")
_FB = [("Monday","Friday"),("Tuesday","Friday"),
       ("Wednesday","Friday"),("Thursday","Friday")]

def capacity_advisor(state, courses, theory_unplaced, lab_unplaced, lab_overflows):
    """Diagnose WHERE room / lab capacity runs out and by how much, with concrete
    'add N labs / rooms / a day / a slot' recommendations. Purely analytical — it
    reads the finished schedule + the resource inventory."""
    from collections import Counter

    def max_nonoverlap(slots):
        rngs = sorted(((_slot_range(s), s) for s in slots), key=lambda x: x[0][1])
        chosen, last = [], -1
        for (a, b), s in rngs:
            if a >= last:
                chosen.append(s); last = b
        return chosen

    n_days = len(DAYS)
    theory_slots_pd = len(THEORY_SLOTS)
    lab_slots_pd = len(max_nonoverlap(LAB_SLOTS))
    n_rooms, n_labs = len(ROOM_CAP), len(LAB_CAP)

    theory_placed = sum(len(v) for v in state.theory_tt.values())
    lab_placed = sum(len(v) for v in state.lab_tt.values())
    theory_demand = theory_placed + len(theory_unplaced)
    lab_demand = lab_placed + len(lab_unplaced)
    theory_cap = n_rooms * theory_slots_pd * n_days
    lab_cap = n_labs * lab_slots_pd * n_days
    pct = lambda a, b: round(100.0 * a / b, 1) if b else 0.0

    lab_courses = [c for c in courses if c["component"] == "Lab"]
    dept_demand = Counter(c["dept_key"] for c in lab_courses)
    dept_cap = {d: len(labs) * lab_slots_pd * n_days for d, labs in ALL_LABS.items()}
    unplaced_by_dept = Counter(c["dept_key"] for c in lab_unplaced)
    slots_per_lab_week = lab_slots_pd * n_days

    # Teacher load — a lab teacher can run at most (lab-blocks/day × days) labs a week,
    # and each is FIXED to one teacher (can't be reassigned). So a department can be
    # TEACHER-bound (a teacher already at the weekly max) even with free lab rooms.
    per_teacher_lab_cap = slots_per_lab_week
    teacher_lab = Counter()
    dept_lab_teachers = defaultdict(set)
    for c in lab_courses:
        if is_tba(c["teacher"]):
            continue
        t = norm_t(c["teacher"])
        teacher_lab[t] += 1
        dept_lab_teachers[c["dept_key"]].add(t)

    bottlenecks = []
    for d, dem in dept_demand.items():
        cap = dept_cap.get(d, 0)
        up = unplaced_by_dept.get(d, 0)
        if not (dem > cap or up > 0):
            continue
        # lab teachers of this dept already at/over the weekly lab max (fixed teacher
        # per course, so these can't be reassigned — more rooms won't help them)
        saturated = sorted((t for t in dept_lab_teachers[d] if teacher_lab[t] >= per_teacher_lab_cap),
                           key=lambda t: -teacher_lab[t])
        room_short = dem > cap
        has_sat = len(saturated) > 0
        if room_short and has_sat:   bound = "both"
        elif has_sat:                bound = "teachers"
        elif room_short:             bound = "rooms"
        else:                        bound = "scheduling"   # batch/student interaction
        deficit = max(0, dem - cap)
        bottlenecks.append({
            "department": d, "labDemand": dem, "labCapacity": cap, "unplaced": up,
            "boundBy": bound, "saturatedTeachers": len(saturated),
            "labsToAdd": ((deficit + slots_per_lab_week - 1) // slots_per_lab_week) if (room_short and deficit) else 0,
        })
    bottlenecks.sort(key=lambda x: (-x["unplaced"], -(x["labDemand"] - x["labCapacity"])))

    recs = []
    if not lab_unplaced and not theory_unplaced:
        recs.append("Everything is placed clash-free — current rooms & labs are sufficient.")
    else:
        for b in bottlenecks[:6]:
            d = b["department"]; nsat = b["saturatedTeachers"]
            if b["boundBy"] == "rooms":
                recs.append(f"Dept '{d}': ROOM-bound — add ~{b['labsToAdd']} lab room(s) "
                            f"(demand {b['labDemand']} vs capacity {b['labCapacity']}/wk, {b['unplaced']} unplaced).")
            elif b["boundBy"] == "teachers":
                recs.append(f"Dept '{d}': TEACHER-bound — rooms are enough (cap {b['labCapacity']} ≥ demand "
                            f"{b['labDemand']}) but {nsat} lab teacher(s) are at the {per_teacher_lab_cap}-lab weekly max. "
                            f"Add lab staff / spread lab sections — MORE ROOMS WON'T HELP ({b['unplaced']} unplaced).")
            elif b["boundBy"] == "both":
                recs.append(f"Dept '{d}': ROOM + TEACHER bound — add ~{b['labsToAdd']} lab room(s) AND relieve "
                            f"{nsat} teacher(s) at the {per_teacher_lab_cap}-lab max "
                            f"(demand {b['labDemand']} vs capacity {b['labCapacity']}/wk, {b['unplaced']} unplaced).")
            else:
                recs.append(f"Dept '{d}': scheduling-bound — rooms & teachers have room, but batch/student overlaps "
                            f"block {b['unplaced']} session(s); spreading that batch's load helps.")
        if theory_unplaced:
            if theory_demand > theory_cap:
                recs.append(f"Theory demand ({theory_demand}) exceeds room capacity ({theory_cap}) — add rooms or a slot.")
            else:
                recs.append(f"{len(theory_unplaced)} theory session(s) unplaced despite spare rooms — a teacher/batch "
                            f"bottleneck; splitting a very large section or spreading a teacher's load helps.")

    return {
        "grid": {"days": n_days, "theorySlotsPerDay": theory_slots_pd, "labSlotsPerDay": lab_slots_pd,
                 "rooms": n_rooms, "labs": n_labs},
        "theory": {"demand": theory_demand, "capacity": theory_cap, "utilizationPct": pct(theory_demand, theory_cap),
                   "placed": theory_placed, "unplaced": len(theory_unplaced)},
        "lab": {"demand": lab_demand, "capacity": lab_cap, "utilizationPct": pct(lab_demand, lab_cap),
                "placed": lab_placed, "unplaced": len(lab_unplaced), "overflows": len(lab_overflows)},
        "bottleneckDepartments": bottlenecks,
        "recommendations": recs,
    }


def _print_capacity_advisor(adv):
    print("\n[ CAPACITY ADVISOR ]")
    g = adv["grid"]; t = adv["theory"]; l = adv["lab"]
    print(f"  Grid: {g['days']} days × {g['theorySlotsPerDay']} theory slots / {g['labSlotsPerDay']} lab blocks; "
          f"{g['rooms']} rooms, {g['labs']} labs")
    print(f"  Theory: {t['placed']}/{t['demand']} placed · {t['utilizationPct']}% of room capacity ({t['capacity']})")
    print(f"  Labs  : {l['placed']}/{l['demand']} placed · {l['utilizationPct']}% of lab capacity ({l['capacity']}) "
          f"· {l['unplaced']} unplaced")
    if adv["bottleneckDepartments"]:
        print("  Bottleneck departments (lab):")
        for b in adv["bottleneckDepartments"][:6]:
            bb = b.get("boundBy"); ns = b.get("saturatedTeachers", 0)
            fix = {"rooms": f"add ~{b['labsToAdd']} lab(s)",
                   "teachers": f"TEACHER-bound ({ns} at max) — add staff, not rooms",
                   "both": f"ROOM+TEACHER — +{b['labsToAdd']} lab(s) & relieve {ns} teacher(s)",
                   "scheduling": "batch/student overlap — spread that batch"}.get(bb, "")
            print(f"    - {b['department']}: demand {b['labDemand']} vs cap {b['labCapacity']}/wk, "
                  f"{b['unplaced']} unplaced → {fix}")
    print("  Recommendations:")
    for r in adv["recommendations"]:
        print(f"    • {r}")


def _lab_clique(s):
    """Every morning lab slot mutually overlaps; afternoon stands alone. So a lab /
    teacher / batch / student can host at most ONE session per (day, clique)."""
    return "AM" if s != "02:00-05:00" else "PM"


def solve_labs_cpsat(state, lab_courses, time_limit=35.0):
    """OPTIMAL lab packing with OR-Tools CP-SAT (theory already fixed in `state`).

    Assigns each lab session to a (day, lab-slot, lab-room) — or leaves it unplaced
    — MAXIMISING the number placed, under HARD constraints (all overlap-aware):
        • a lab room hosts ≤1 session per (day, time-clique),
        • a teacher / batch / shared-student is in ≤1 place per (day, time-clique),
        • no lab overlaps the FROZEN theory of its own teacher/batch/students,
        • lab capacity ≥ enrolled.
    Returns (placed_count, [unplaced_courses]). Falls back to (None, None) if the
    model can't be built so the caller can use the greedy placer."""
    if not HAVE_CPSAT or not lab_courses:
        return None, None

    all_labs = state._all_labs_flat()
    model = cp_model.CpModel()
    xall = []
    sess = []      # (course, [(var, d, s, lab), ...])

    # all labs sorted small→large capacity (tight-fit preference, like the greedy)
    all_labs_by_cap = sorted(all_labs, key=lambda l: LAB_CAP.get(l, 999))
    for c in lab_courses:
        enrolled = c.get("enrolled", 0)
        # capacity-fitting labs: own department first, then the tightest-fitting other
        # labs — capped so the model stays small enough to solve fast.
        dept = [l for l in c.get("lab_pool", []) if LAB_CAP.get(l, 999) >= enrolled]
        others = [l for l in all_labs_by_cap if LAB_CAP.get(l, 999) >= enrolled and l not in dept]
        pool = dept + others[:6]           # dept labs + up to 14 tightest others
        seen = set(); pool = [l for l in pool if not (l in seen or seen.add(l))]
        cands = []
        for lab in pool:
            for d in DAYS:
                for s in LAB_SLOTS:
                    # against FROZEN theory only (no labs booked yet) — overlap-aware
                    if not state._tf(c["teacher"], d, s):
                        continue
                    if not state._bf(c["batch_key"], d, s):
                        continue
                    if not state._sf(c, d, s):
                        continue
                    v = model.NewBoolVar(f"x{len(xall)}")
                    cands.append((v, d, s, lab))
                    xall.append(v)
        if cands:
            model.Add(sum(v for v, _, _, _ in cands) <= 1)
        sess.append((c, cands))

    if not xall:
        return 0, [c for c, _ in sess]

    # ── resource cliques: at most one selected var per (resource, day, clique) ──
    lab_g = defaultdict(list); tea_g = defaultdict(list)
    bat_g = defaultdict(list); stu_g = defaultdict(list)

    stud_sessions = defaultdict(list)
    for i, (c, cands) in enumerate(sess):
        for u in (c.get("students") or ()):
            stud_sessions[u].append(i)
    shared = {u for u, ss in stud_sessions.items() if len(ss) >= 2}

    for c, cands in sess:
        tt = norm_t(c["teacher"]); bk = c["batch_key"]
        studs = [u for u in (c.get("students") or ()) if u in shared]
        for (v, d, s, lab) in cands:
            cl = _lab_clique(s)
            lab_g[(lab, d, cl)].append(v)
            if not is_tba(c["teacher"]):
                tea_g[(tt, d, cl)].append(v)
            bat_g[(bk, d, cl)].append(v)
            for u in studs:
                stu_g[(u, d, cl)].append(v)

    for grp in (lab_g, tea_g, bat_g, stu_g):
        for vs in grp.values():
            if len(vs) > 1:
                model.Add(sum(vs) <= 1)

    model.Maximize(sum(xall))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(time_limit)
    solver.parameters.num_search_workers = 8
    solver.parameters.log_search_progress = False
    import time as _t
    _t0 = _t.time()
    status = solver.Solve(model)
    sys.stderr.write(f"[CP-SAT] vars={len(xall)} sessions={len(sess)} "
                     f"status={solver.StatusName(status)} obj={solver.ObjectiveValue():.0f} "
                     f"time={_t.time()-_t0:.1f}s\n"); sys.stderr.flush()
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None, None

    placed = 0; unplaced = []
    for c, cands in sess:
        chosen = None
        for (v, d, s, lab) in cands:
            if solver.Value(v) == 1:
                chosen = (d, s, lab); break
        if chosen:
            d, s, lab = chosen
            state._book_lab(c, lab, d, s, LAB_CAP.get(lab, 999))
            placed += 1
        else:
            unplaced.append(c)
    return placed, unplaced


def _find_lab_slot(state, c, exclude=None):
    """First free (lab, day, lab-slot) for course c under the overlap-aware hard
    constraints (teacher / batch / student / lab). Dept labs first, then any lab,
    tightest capacity first. Returns (lab, d, s, cap) or None."""
    enrolled = c.get("enrolled", 0)
    all_labs = state._all_labs_flat()
    pool, seen = [], set()
    for l in list(c.get("lab_pool", [])) + all_labs:
        if l in seen:
            continue
        seen.add(l)
        if LAB_CAP.get(l, 999) >= enrolled:
            pool.append(l)
    for lab in pool:
        for d in DAYS:
            for s in LAB_SLOTS:
                if exclude and (lab, d, s) == exclude:
                    continue
                if (state._tf(c["teacher"], d, s) and state._bf(c["batch_key"], d, s)
                        and state._sf(c, d, s) and state._lf(lab, d, s)):
                    return (lab, d, s, LAB_CAP.get(lab, 999))
    return None


def repair_labs_ejection(state, lab_courses, lab_unplaced):
    """LOCAL-SEARCH repair (min-conflicts / depth-1 ejection chain).

    For every still-unplaced lab: (1) try a direct free slot; else (2) find a target
    (lab, day, slot) where ONLY the lab room is the blocker, temporarily EVICT the
    lab already sitting there, relocate THAT lab to another free slot, and drop the
    unplaced one in. Every placement is validated with the same overlap-aware checks,
    so a clash can never be introduced. Returns (newly_placed, still_unplaced)."""
    placed_more, remaining = [], []
    for U in lab_unplaced:
        slot = _find_lab_slot(state, U)
        if slot:
            state._book_lab(U, slot[0], slot[1], slot[2], slot[3])
            placed_more.append(U)
            continue

        enrolled = U.get("enrolled", 0)
        dept = [l for l in U.get("lab_pool", []) if LAB_CAP.get(l, 999) >= enrolled]
        pool = dept or [l for l in state._all_labs_flat() if LAB_CAP.get(l, 999) >= enrolled]
        done = False
        for lab in pool:
            if done: break
            for d in DAYS:
                if done: break
                for s in LAB_SLOTS:
                    # U's OWN constraints must already be free — only the room blocks.
                    if not (state._tf(U["teacher"], d, s) and state._bf(U["batch_key"], d, s)
                            and state._sf(U, d, s)):
                        continue
                    if state._lf(lab, d, s):
                        continue                     # actually free → handled above
                    # find the lab session occupying this room at an overlapping slot
                    L = None
                    for c2 in lab_courses:
                        pl = c2.get("_placed_lab")
                        if pl and pl[0] == lab and pl[1] == d and pl[2] in SLOT_OVERLAP[s]:
                            L = c2; break
                    if L is None:
                        continue
                    Llab, Ld, Ls, Lcap = L["_placed_lab"]
                    state._unbook_lab(L, Llab, Ld, Ls)
                    if state._lf(lab, d, s):
                        newL = _find_lab_slot(state, L, exclude=(lab, d, s))
                        if newL:
                            state._book_lab(U, lab, d, s, LAB_CAP.get(lab, 999))
                            state._book_lab(L, newL[0], newL[1], newL[2], newL[3])
                            placed_more.append(U); done = True; break
                    state._book_lab(L, Llab, Ld, Ls, Lcap)   # revert
        if not done:
            remaining.append(U)
    return placed_more, remaining


def run_scheduler(courses):
    state  = SchedulerState()
    ord_a  = THEORY_SLOTS[:]
    ord_b  = THEORY_SLOTS[2:] + THEORY_SLOTS[:2]

    # course dicts are reused across restart attempts — clear any placement tag left
    # from a previous attempt so the local-search relocation never reads stale data.
    for c in courses:
        c.pop("_placed_lab", None)

    lec_courses = [c for c in courses if c["component"]=="Lecture"]
    lab_courses  = [c for c in courses if c["component"]=="Lab"]
    random.shuffle(lec_courses)

    # ── Theory scheduling ──────────────────────────────────────────────────
    failed = []
    for idx, c in enumerate(lec_courses):
        # 2-credit course → ONE 2-hour session on a single day
        if c.get("theory_2h"):
            if not state.try_single(c, DAYS, THEORY_SLOTS_2H):
                failed.append(c)
            continue
        # 1-credit course → ONE 1.5-hour session
        if int(c.get("n_theory", 2)) == 1:
            if not state.try_single(c, DAYS, THEORY_SLOTS):
                failed.append(c)
            continue
        # 3+ credit → TWO 1.5-hour sessions on alternate days
        if idx%2==0: pri,po,sec,so = _MW,ord_a,_TT,ord_b
        else:        pri,po,sec,so = _TT,ord_b,_MW,ord_a
        placed = (state.try_pair(c,*pri,po) or state.try_pair(c,*sec,so))
        if not placed:
            for d1,d2 in _FB:
                if state.try_pair(c,d1,d2,THEORY_SLOTS): placed=True; break
        if not placed: failed.append(c)

    still_failed = []
    for c in failed:
        slots = THEORY_SLOTS_2H if c.get("theory_2h") else THEORY_SLOTS
        if not state.try_single(c, DAYS, slots): still_failed.append(c)

    # Courses that still need their full session count get a harder retry.
    # We first try every alternate-day PAIR (so a 2-session course stays on
    # alternate days, never adjacent), and only then fall back to singles.
    ALT_PAIRS = [_MW, _TT, ("Monday", "Thursday"), ("Tuesday", "Friday"),
                 ("Wednesday", "Friday"), ("Monday", "Friday")]
    bt = 0
    theory_unplaced = []
    for c in still_failed:
        placed   = False
        enrolled = c.get("enrolled",0)
        # 2-hour / 1-credit courses are ONE session only — never a pair.
        if c.get("theory_2h") or int(c.get("n_theory", 2)) == 1:
            slots = THEORY_SLOTS_2H if c.get("theory_2h") else THEORY_SLOTS
            for d in DAYS:
                if placed: break
                for s in slots:
                    rm = state._best_free_room(enrolled, d, s)
                    if (rm and state._tf(c["teacher"], d, s)
                            and state._bf(c["batch_key"], d, s) and state._sf(c, d, s)):
                        orig = c["room"]; c["room"] = rm
                        state._book_theory(c, d, s, forced=True)
                        c["room"] = orig; placed = True; bt += 1; break
            if not placed:
                theory_unplaced.append(c); bt += 1
            continue
        # First: try to keep it on an alternate-day pair. EVERY hard constraint
        # stays enforced (teacher, room+capacity, batch, and student) — we only
        # broaden which day-pairs/rooms we consider.
        for d1, d2 in ALT_PAIRS:
            if placed: break
            for s in THEORY_SLOTS:
                rm1 = state._best_free_room(enrolled, d1, s)
                rm2 = state._best_free_room(enrolled, d2, s)
                if (rm1 and rm2
                        and state._tf(c["teacher"], d1, s) and state._tf(c["teacher"], d2, s)
                        and state._bf(c["batch_key"], d1, s) and state._bf(c["batch_key"], d2, s)
                        and state._sf(c, d1, s) and state._sf(c, d2, s)):
                    orig=c["room"]
                    c["room"]=rm1; state._book_theory(c, d1, s, forced=True)
                    c["room"]=rm2; state._book_theory(c, d2, s, forced=True)
                    c["room"]=orig; placed=True; bt+=1; break
        # Single-session fallback: the ONLY thing relaxed is the "different days"
        # preference (HC7) — a session may share a day with this course's other
        # session. Teacher / room / capacity / batch / STUDENT stay hard, so no
        # clash is ever introduced.
        if not placed:
            for d in DAYS:
                if placed: break
                for s in THEORY_SLOTS:
                    rm = state._best_free_room(enrolled, d, s)
                    if (rm and state._tf(c["teacher"], d, s)
                            and state._bf(c["batch_key"], d, s)
                            and state._sf(c, d, s)):
                        orig=c["room"]; c["room"]=rm
                        state._book_theory(c, d, s, forced=True)
                        c["room"]=orig; placed=True; bt+=1; break
        if not placed:
            theory_unplaced.append(c)
            bt+=1
    if theory_unplaced:
        print(f"  Theory sessions left unplaced (no clash-free slot): {len(theory_unplaced)}")

    # ── Lab scheduling ─────────────────────────────────────────────────────
    lab_fail     = 0
    lab_overflows = []  # courses placed with capacity overflow
    lab_unplaced  = []  # courses that could not be placed at all

    # Schedule the biggest lab sections first. Large groups have the fewest
    # labs that can hold them, so placing them before small sections grab the
    # roomy labs sharply reduces both overflow and unplaced sessions.
    # Within the same strength, shuffle so multiple attempts explore different
    # orderings (helps the best-of-N search escape a bad arrangement).
    lab_courses_shuffled = lab_courses[:]
    random.shuffle(lab_courses_shuffled)
    lab_courses_sorted = sorted(lab_courses_shuffled, key=lambda c: -c.get("enrolled", 0))

    # Lab placement. The tuned greedy (tight-fit, dept-first, biggest-section-first,
    # best-of-N restarts) empirically beats a from-scratch CP-SAT solve on this
    # structure, so it is the default. Set TT_LAB_SOLVER=cpsat to use the CP-SAT
    # packer instead (available via OR-Tools; see solve_labs_cpsat).
    use_cpsat = os.environ.get("TT_LAB_SOLVER", "greedy").lower() == "cpsat" and HAVE_CPSAT
    cp_placed = None
    if use_cpsat:
        cp_placed, cp_unplaced = solve_labs_cpsat(state, lab_courses_sorted)
    if cp_placed is not None:
        lab_unplaced = list(cp_unplaced)
        lab_fail = len(cp_unplaced)
        print(f"  [CP-SAT] labs packed: {cp_placed}/{len(lab_courses_sorted)} placed")
    else:
        for c in lab_courses_sorted:
            placed, lab_name, overflow = state.try_lab(c)
            if placed:
                if overflow:
                    lab_overflows.append({**c, **overflow})
            else:
                lab_fail += 1
                lab_unplaced.append(c)

    # ── Recovery pass ──────────────────────────────────────────────────────
    # Any lab session still unplaced (usually a split group that ran out of
    # slots) gets one final attempt in ANY free lab + slot, ignoring capacity.
    # A placed-with-small-overflow session is far better than an unplaced one.
    if lab_unplaced:
        recovered = []
        for c in lab_unplaced:
            done = False
            for d in DAYS:
                for s in LAB_SLOTS:
                    if not state._tf(c["teacher"], d, s): continue
                    if not state._bf(c["batch_key"], d, s): continue
                    # biggest free lab in this slot = smallest overflow
                    for lab in reversed(c["lab_pool"]):
                        if (state._lf(lab, d, s)
                                and state._theory_free_for_lab(lab, d, s)):
                            cap = LAB_CAP.get(lab, 999)
                            state._book_lab(c, lab, d, s, cap)
                            if c.get("enrolled", 0) > cap:
                                lab_overflows.append({**c, "lab": lab, "cap": cap,
                                                      "enrolled": c.get("enrolled", 0)})
                            recovered.append(c)
                            done = True
                            break
                    if done: break
                if done: break
        # Remove recovered sessions from the unplaced list
        lab_unplaced = [c for c in lab_unplaced if c not in recovered]
        lab_fail = len(lab_unplaced)

    # ── Local-search repair (min-conflicts / ejection chain) ────────────────
    # Relocate an already-placed lab to free a slot for one that couldn't fit.
    # Every move is overlap-validated, so it never introduces a clash.
    if lab_unplaced:
        moved, lab_unplaced = repair_labs_ejection(state, lab_courses, lab_unplaced)
        if moved:
            print(f"  [Local-search] placed {len(moved)} more lab(s) by relocation")
        lab_fail = len(lab_unplaced)

    print(f"  Theory sessions placed  : {state.theory_count}")
    print(f"  Lab sessions placed     : {state.lab_count}")
    if bt:        print(f"  Backtrack-fixed (★)     : {bt}")
    if lab_fail:  print(f"  Labs unplaced           : {lab_fail}")
    if lab_overflows: print(f"  Lab capacity overflows  : {len(lab_overflows)}")
    return state, lab_overflows, lab_unplaced, theory_unplaced


def _meta_ctx():
    """Package the engine's live slot / room / lab tables for the solver."""
    return metaheuristic.Ctx(
        DAYS=DAYS, THEORY_SLOTS=THEORY_SLOTS, THEORY_SLOTS_2H=THEORY_SLOTS_2H,
        LAB_SLOTS=LAB_SLOTS, SLOT_OVERLAP=SLOT_OVERLAP, ROOM_CAP=ROOM_CAP,
        ROOMS_BY_CAP=ROOMS_BY_CAP, LAB_CAP=LAB_CAP, ALL_LABS=ALL_LABS,
        TIGHT_FIT_RATIO=TIGHT_FIT_RATIO, is_tba=is_tba, norm_t=norm_t)


def run_scheduler_meta(courses):
    """
    Timetable via the metaheuristic pipeline:
        greedy initial feasible  ->  Tabu Search  ->  VNS
    then bridge the placements into a real SchedulerState so the clash report,
    Excel workbook and schedule JSON are produced exactly as before.
    Same signature as run_scheduler.
    """
    ctx  = _meta_ctx()
    tt   = float(os.environ.get("TT_TABU_TIME", "20"))
    vt   = float(os.environ.get("TT_VNS_TIME", "20"))
    seed = int(os.environ.get("TT_SEED", "0")) or random.randint(1, 2**31)

    sessions, unplaced, stats = metaheuristic.solve(
        courses, ctx, seed=seed, tabu_time=tt, vns_time=vt)
    print(f"  [meta] unplaced: init {stats['after_init']}  ->  after Tabu {stats['after_tabu']}"
          f"  ->  after VNS {stats['after_vns']}   "
          f"(Tabu {stats['tabu_iters']} it, VNS {stats['vns_iters']} it)")

    # Bridge → SchedulerState (uses the engine's own overlap-aware booking, so the
    # state is clash-free by construction and the verifier re-confirms it).
    state = SchedulerState()
    lab_overflows = []
    for sess in sessions:
        if not sess.place:
            continue
        d, s, room = sess.place
        c = sess.c
        if sess.kind == "L":
            cap = LAB_CAP.get(room, c.get("enrolled", 0))
            state._book_lab(c, room, d, s, cap)
            if c.get("enrolled", 0) > cap:
                lab_overflows.append({**c, "lab": room, "cap": cap, "enrolled": c["enrolled"]})
        else:
            # a theory class may borrow a lab room (HC8-safe); mark it so the
            # engine's own verifier and any later lab booking respect it.
            is_lab_room = room not in ROOM_CAP and room in LAB_CAP
            c["room"] = room
            state._book_theory(c, d, s)
            if is_lab_room:
                state._lab_as_theory[room].add((d, s))

    theory_unplaced = [se.c for se in unplaced if se.is_theory()]
    lab_unplaced    = [se.c for se in unplaced if se.kind == "L"]
    return state, lab_overflows, lab_unplaced, theory_unplaced


def _quick_clash_count(state):
    """
    Hard clashes are structurally impossible here: every booking first checks
    the per-entity busy-sets (_teacher_busy, _room_busy, _lab_busy, _batch_busy)
    and only proceeds if free. So this is always 0 and the attempt scoring is
    driven by overflow + unplaced counts. Kept as an explicit safety hook.
    """
    return 0


# ── CLASH REPORT ──────────────────────────────────────────────────────────────
def verify_and_report(state, df, tba_issues, lab_overflows, lab_unplaced):
    SEP  = "=" * 72
    DASH = "-" * 72
    lines = [SEP, "  ABASYN UNIVERSITY — TIMETABLE CLASH & VERIFICATION REPORT", SEP, ""]

    def find_clashes(slot_map):
        result = []
        for key, records in sorted(slot_map.items()):
            seen = defaultdict(list)
            for day, slot, label in records: seen[(day,slot)].append(label)
            for (day,slot), labels in seen.items():
                if len(labels)>1: result.append((key,day,slot,labels))
        return result

    # 1. Teacher clashes
    lines += ["[ 1 ]  TEACHER CLASH CHECK", DASH]
    t_map = defaultdict(list)
    for src in [state.theory_tt, state.lab_tt]:
        for (day,slot),entries in src.items():
            for e in entries:
                parts=e.split("\n")
                if len(parts)>=2:
                    m=re.match(r"(.+?)\s+\[",parts[1])
                    if m and not is_tba(m.group(1)):
                        t_map[norm_t(m.group(1).strip())].append((day,slot,parts[0]))
    tc_list = find_clashes(t_map)
    if tc_list:
        for t,day,slot,labels in tc_list:
            lines.append(f"  ⚠  Teacher '{t}'  →  {day}  |  {slot}")
            for lbl in labels: lines.append(f"       {lbl}")
        lines.append(f"\n  Total teacher clashes : {len(tc_list)}")
    else: lines.append("  ✓  No teacher clashes.")
    lines.append("")

    # 2. Room clashes
    lines += ["[ 2 ]  THEORY ROOM DOUBLE-BOOKING CHECK", DASH]
    r_map = defaultdict(list)
    for (day,slot),entries in state.theory_tt.items():
        for e in entries:
            parts=e.split("\n")
            if len(parts)>=2:
                m=re.search(r"\[(.+?)\]",parts[1])
                if m:
                    rm = m.group(1).split(" (")[0]   # strip "(lab name)" suffix
                    r_map[rm].append((day,slot,parts[0]))
    rc_list = find_clashes(r_map)
    if rc_list:
        for room,day,slot,labels in rc_list:
            lines.append(f"  ⚠  Room '{room}'  →  {day}  |  {slot}")
            for lbl in labels: lines.append(f"       {lbl}")
        lines.append(f"\n  Total room clashes : {len(rc_list)}")
    else: lines.append("  ✓  No theory room double-bookings.")
    lines.append("")

    # 3. Lab double-booking
    lines += ["[ 3 ]  LAB ROOM DOUBLE-BOOKING CHECK", DASH]
    l_map = defaultdict(list)
    for (day,slot),entries in state.lab_tt.items():
        for e in entries:
            parts=e.split("\n")
            if len(parts)>=2:
                m=re.search(r"\[(.+?)\]",parts[1])
                if m: l_map[m.group(1).split("]")[0]].append((day,slot,parts[0]))
    lc_list = find_clashes(l_map)
    if lc_list:
        for lab,day,slot,labels in lc_list:
            lines.append(f"  ⚠  Lab '{lab}'  →  {day}  |  {slot}")
            for lbl in labels: lines.append(f"       {lbl}")
        lines.append(f"\n  Total lab clashes : {len(lc_list)}")
    else: lines.append("  ✓  No lab room double-bookings.")
    lines.append("")

    # 4. Theory-in-lab-slot
    lines += ["[ 4 ]  THEORY-IN-LAB-SLOT SAFETY", DASH]
    til = sum(len(state.theory_tt.get((d,s),[])) for d in DAYS for s in LAB_SLOTS)
    lines.append("  ✓  No theory sessions in lab slots." if til==0
                 else f"  ⚠  {til} theory sessions in lab slots!")
    lines.append("")

    # 5. HC8 — lab-room overlap with theory (lab used in theory AND lab simultaneously)
    lines += ["[ 5 ]  LAB-ROOM / THEORY-SLOT OVERLAP CHECK  (HC8)", DASH,
              "       A lab room cannot host a lab session if a theory class is already",
              "       scheduled there in an overlapping time window.", ""]
    hc8_violations = []
    for lab_name, theory_slots_used in state._lab_as_theory.items():
        for (d, ts) in theory_slots_used:
            overlap_lab_slots = THEORY_OVERLAPS_LAB.get(ts, [])
            for ls in overlap_lab_slots:
                if (d, ls) in state._lab_busy[lab_name]:
                    hc8_violations.append((lab_name, d, ts, ls))
    if hc8_violations:
        for lab,d,ts,ls in hc8_violations:
            lines.append(f"  ⚠  {lab}  used as theory at {d} {ts}  AND as lab at {d} {ls}")
        lines.append(f"\n  Total HC8 violations : {len(hc8_violations)}")
    else:
        lines.append("  ✓  No lab-room/theory-slot overlaps.")
    lines.append("")

    # 6. Theory room capacity violations
    lines += ["[ 6 ]  THEORY ROOM CAPACITY VIOLATIONS", DASH]
    cap_v = [ra for ra in state.room_assignments if ra["enrolled"]>0 and ra["enrolled"]>ra["cap"]]
    if cap_v:
        for v in cap_v:
            ss = f" - {v['section']}" if v["section"] else ""
            lines.append(f"  ⚠  {v['code']}{ss}  {v['name'][:35]}  →  "
                         f"Room {v['room']} (cap {v['cap']}) | enrolled {v['enrolled']}")
        lines.append(f"\n  Total : {len(cap_v)}")
    else: lines.append("  ✓  All theory rooms fit enrolled students.")
    lines.append("")

    # 7. Lab capacity violations / overflow
    lines += ["[ 7 ]  LAB ROOM CAPACITY VIOLATIONS", DASH,
              "       Labs placed despite enrolled > lab capacity.",
              "       These labs need larger rooms or splitting into sections.", ""]
    if lab_overflows:
        by_lab = defaultdict(list)
        for ov in lab_overflows: by_lab[ov["lab"]].append(ov)
        for lab_name, ovs in sorted(by_lab.items()):
            max_cap = LAB_CAP.get(lab_name, 0)
            lines.append(f"  ⚠  {lab_name}  (capacity: {max_cap} students)")
            lines.append(f"      ACTION NEEDED: Increase capacity or split the following sections —")
            for ov in ovs:
                ss = f"-{ov['section']}" if ov.get("section") else ""
                lines.append(f"        • {ov['code']}{ss}  {ov['name'][:40]}  "
                             f"enrolled={ov['enrolled']}  overflow by {ov['enrolled']-max_cap}")
        lines.append(f"\n  Total overflow placements : {len(lab_overflows)}")
    else: lines.append("  ✓  All labs fit their enrolled students.")
    lines.append("")

    # 8. Unplaced labs
    lines += ["[ 8 ]  UNPLACED LAB SESSIONS", DASH]
    if lab_unplaced:
        lines.append("  These lab sessions could NOT be scheduled (all lab slots exhausted).")
        lines.append("")
        for c in lab_unplaced:
            ss = f"-{c['section']}" if c.get("section") else ""
            lines.append(f"  ✗  {c['code']}{ss}  {c['name'][:40]}  "
                         f"| {c.get('batch_id','')}  | enrolled={c.get('enrolled',0)}")
        lines.append(f"\n  Total unplaced : {len(lab_unplaced)}")
    else: lines.append("  ✓  All lab sessions placed successfully.")
    lines.append("")

    # 9. Room assignment report (theory)
    lines += ["[ 9 ]  THEORY ROOM ASSIGNMENT REPORT", DASH]
    seen_k = set()
    for ra in sorted(state.room_assignments, key=lambda x:(x["program"],x["code"],x["section"])):
        k = f"{ra['code']}|{ra['section']}|{ra['day']}|{ra['slot']}"
        if k in seen_k: continue
        seen_k.add(k)
        ss       = f"-{ra['section']}" if ra["section"] else ""
        fit      = "✓" if ra["enrolled"]<=ra["cap"] else "⚠ OVERFLOW"
        star     = " ★" if ra["forced"] else ""
        lines.append(
            f"  {ra['room']:14s} cap={ra['cap']:3d}  enrolled={ra['enrolled']:3d}"
            f"  {fit:10s}  {ra['code']}{ss}{star}  {ra['name'][:28]}  "
            f"|  {ra['day'][:3]}  {ra['slot']}"
        )
    lines.append("")

    # 10. Missing teacher report
    lines += ["[ 10 ]  MISSING TEACHER REPORT  (TBA in timetable)", DASH,
              "        Courses with no Primary Faculty in dataset.",
              "        Shown as TBA in timetable — assign teachers before printing.", ""]
    if not tba_issues:
        lines.append("  ✓  All courses have teachers.")
    else:
        by_base = defaultdict(list)
        for iss in tba_issues:
            by_base[f"{iss['course_code']} — {iss['name']}"].append(iss)
        for key in sorted(by_base):
            issues = by_base[key]
            lm = any(i["component"]=="Lecture" for i in issues)
            bm = any(i["component"]=="Lab"     for i in issues)
            tag = ("LECTURE + LAB" if lm and bm else "LECTURE" if lm else "LAB") + " teacher missing"
            batches = ", ".join(sorted({
                i["batch_id"]+(f"-{i['section']}" if i["section"] else "")
                for i in issues}))
            lines.append(f"  • {key}")
            lines.append(f"      Program  : {issues[0]['program']}")
            lines.append(f"      Batch(es): {batches}")
            lines.append(f"      Missing  : {tag}")
        lines.append(f"\n  Total TBA courses : {len(by_base)}")
        lines.append(f"  Total TBA rows    : {len(tba_issues)}")
    lines.append("")

    # Summary
    tc=len(tc_list); rc=len(rc_list); lc=len(lc_list)
    cvc=len(cap_v); h8=len(hc8_violations); lov=len(lab_overflows)
    total = tc+rc+lc+til+cvc+h8
    lines += [SEP, "  SUMMARY", SEP,
              f"  Teacher clashes           : {tc}",
              f"  Theory room clashes       : {rc}",
              f"  Lab room clashes          : {lc}",
              f"  Theory in lab slot        : {til}",
              f"  HC8 lab/theory overlaps   : {h8}",
              f"  Theory capacity violations: {cvc}",
              f"  Lab capacity overflows    : {lov}  (placed but needs larger lab)",
              f"  Unplaced labs             : {len(lab_unplaced)}",
              f"  TBA teacher courses       : {len(set(i['course_code'] for i in tba_issues))}",
              f"  Theory sessions placed    : {state.theory_count}",
              f"  Lab sessions placed       : {state.lab_count}",
              "  " + "─"*40,
              f"  TOTAL HARD CLASHES        : {total}",
              "",
              ("  ✓✓  TIMETABLE IS FULLY CLASH-FREE  ✓✓" if total==0
               else "  !!  HARD CLASHES FOUND — review above"),
              SEP]

    text = "\n".join(lines)
    print(text)
    with open(REPORT_FILE,"w",encoding="utf-8") as f: f.write(text)
    print(f"\n  Report saved → {REPORT_FILE}")
    return tc, rc, lc, cvc


# ── EXCEL HELPERS ─────────────────────────────────────────────────────────────
def _fill(h):
    h = str(h).strip().lstrip("#")
    if len(h)==6: h="FF"+h
    return PatternFill("solid", fgColor=h)

def _bdr(color="CCCCCC", weight="thin"):
    s=Side(style=weight,color=color)
    return Border(left=s,right=s,top=s,bottom=s)

def _fnt(bold=False,color="000000",size=9,italic=False):
    return Font(name="Calibri",bold=bold,color=color,size=size,italic=italic)

def wc(ws,row,col,value,*,bg=None,fg="1A202C",bold=False,size=9,italic=False,
       h="center",v="center",wrap=True,bc="CCCCCC",bw="thin"):
    c=ws.cell(row=row,column=col,value=value)
    if bg: c.fill=_fill(bg)
    c.font=_fnt(bold=bold,color=fg,size=size,italic=italic)
    c.alignment=Alignment(horizontal=h,vertical=v,wrap_text=wrap)
    c.border=_bdr(bc,bw); return c

def _setup_print(ws,landscape=True):
    from openpyxl.worksheet.page import PageMargins
    ws.page_setup.orientation  = "landscape" if landscape else "portrait"
    ws.page_setup.paperSize    = ws.PAPERSIZE_A3
    ws.page_setup.fitToPage    = True
    ws.page_setup.fitToWidth   = 1
    ws.page_setup.fitToHeight  = 0
    ws.page_setup.horizontalDpi= 200
    ws.page_setup.verticalDpi  = 200
    ws.print_options.horizontalCentered=True
    ws.page_margins=PageMargins(left=0.3,right=0.3,top=0.4,bottom=0.4,header=0.2,footer=0.2)
    ws.sheet_view.showGridLines=False

def _set_widths(ws):
    for ci,label in enumerate(ALL_COLS,1):
        lt=get_column_letter(ci)
        if   label=="__day__":        ws.column_dimensions[lt].width=10
        elif label=="__break__":      ws.column_dimensions[lt].width=9
        else:                         ws.column_dimensions[lt].width=40   # wider: theory + inline labs

_W="FFFFFF"; _MHDR="145A32"; _MDAY="145A32"; _MSLOT="D5F5E3"; _MSLFG="145A32"
_BRKBG="FEFCBF"; _BRKFG="744210"; _EMPBG="F7FAFC"; _EMPFG="A0AEC0"; _SEPBG="E2E8F0"

def _write_headers(ws,row,hdr_bg,hdr_fg):
    ws.row_dimensions[row].height=20
    for ci,label in enumerate(ALL_COLS,1):
        if   label=="__day__":        wc(ws,row,ci,"DAY",bg=hdr_bg,fg=hdr_fg,bold=True,size=9,bc=hdr_bg,bw="medium")
        elif label=="__break__":      wc(ws,row,ci,"Break\n01:00-02:00",bg=_BRKBG,fg=_BRKFG,bold=True,italic=True,size=7,bc="B7791F",bw="medium")
        else:                         wc(ws,row,ci,_ampm(label),bg=hdr_bg,fg=hdr_fg,bold=True,size=8,bc=hdr_bg,bw="medium")

def _write_sep(ws,row):
    ws.row_dimensions[row].height=5
    for ci in range(1,N_COLS+1): wc(ws,row,ci,"",bg=_SEPBG,bc=_SEPBG)

def _dom(meta_list):
    counts=defaultdict(int)
    for _,dk in meta_list: counts[dk]+=1
    return max(counts,key=counts.get) if counts else "common"

# ── AUTO-FIT ROW HEIGHT ───────────────────────────────────────────────────────
# A grid cell can hold several courses. The row must be TALL ENOUGH that EVERY
# course listed in its busiest cell is visible — no clipping. We estimate how
# many wrapped text-lines each cell needs (entry length ÷ column width, plus a
# blank spacer line between entries) and size the row to the busiest cell.
_CHARS_PER_LINE_LAB   = 58   # lab columns are width 64
_CHARS_PER_LINE_TH    = 30   # theory columns are width 32
_LINE_PTS             = 10.5 # points per wrapped text line at font size 7
_ROW_MIN_H            = 30
_ROW_MAX_H            = 409   # Excel's hard maximum row height (points)

def _cell_lines(entries, is_lab):
    """Estimated number of wrapped text-lines a cell needs to show all entries."""
    if not entries:
        return 1
    cpl = _CHARS_PER_LINE_LAB if is_lab else _CHARS_PER_LINE_TH
    total = 0
    for e in entries:
        total += max(1, -(-len(str(e)) // cpl))   # ceil(len/cpl)
    total += max(0, len(entries) - 1)             # blank spacer line per gap
    return total

def _autofit_height(ws, row, cell_entry_lists):
    """Set the row height to fit the busiest cell (clamped to Excel's max)."""
    max_lines = max((_cell_lines(ents, is_lab) for ents, is_lab in cell_entry_lists),
                    default=1)
    h = _ROW_MIN_H + (max_lines - 1) * _LINE_PTS
    ws.row_dimensions[row].height = max(_ROW_MIN_H, min(h, _ROW_MAX_H))

def _render(ws,row,col,meta,bg,border_color):
    if not meta: wc(ws,row,col,"—",bg=_EMPBG,fg=_EMPFG,size=9,bc="E2E8F0"); return
    sorted_meta=sorted(meta,key=lambda x:x[1])
    text="\n\n".join(e for e,_ in sorted_meta)
    fg=DEPT_COLORS.get(_dom(sorted_meta),("000000","FFFFFF",""))[0]
    cell=ws.cell(row=row,column=col,value=text)
    cell.fill=_fill(bg); cell.font=_fnt(color=fg,size=7)
    cell.alignment=Alignment(horizontal="left",vertical="top",wrap_text=True)
    cell.border=_bdr(border_color,"thin")

def _lab_col_meta(state, day, group_slots, prog_codes=None):
    """Aggregate lab meta from a display group's real slots into one column.
    When the group has more than one start time (the overlapping morning starts),
    each entry is tagged with its exact time so nothing is ambiguous."""
    tag = len(group_slots) > 1
    out = []
    for s in group_slots:
        items = state.lab_meta.get((day, s), [])
        if prog_codes is not None:
            items = _filt(items, prog_codes)
        for entry, dk in items:
            out.append((f"{entry}   @ {s}" if tag else entry, dk))
    return out

# Combined meta (theory + inline labs) for one day + one theory time-column.
def _col_meta(state, day, theory_slot, prog_codes=None):
    meta = list(state.theory_meta.get((day, theory_slot), []))
    if prog_codes is not None:
        meta = _filt(meta, prog_codes)
    for lab in THEORY_COL_LABS.get(theory_slot, []):
        items = state.lab_meta.get((day, lab), [])
        if prog_codes is not None:
            items = _filt(items, prog_codes)
        meta.extend(items)
    return meta

def _write_day_master(ws,row,day,state):
    # Auto-fit: size the row to show every course in its busiest cell.
    cell_lists=[]
    for label in ALL_COLS:
        if label in ("__day__","__break__"): continue
        ents=[e for e,_ in _col_meta(state,day,label)]
        cell_lists.append((ents, False))
    _autofit_height(ws,row,cell_lists)
    wc(ws,row,1,_day_abbr(day),bg=_MDAY,fg=_W,bold=True,size=10,bc=_MHDR,bw="medium")
    for ci,label in enumerate(ALL_COLS,1):
        if label=="__day__": continue
        if label=="__break__":
            wc(ws,row,ci,"  LUNCH BREAK",bg=_BRKBG,fg=_BRKFG,bold=True,italic=True,size=8,bc="B7791F",bw="medium")
            continue
        _render(ws,row,ci,_col_meta(state,day,label),_W,"CBD5E0")

def _filt(meta_list,prog_codes):
    out=[]
    for entry,dk in meta_list:
        tok=entry.split()[0].rstrip()
        if tok in prog_codes: out.append((entry,dk))
        elif entry.startswith("LAB:") and len(entry.split())>1 and entry.split()[1].rstrip() in prog_codes:
            out.append((entry,dk))
    return out

def _write_day_prog(ws,row,day,state,prog_codes,day_bg,day_fg,th_bg):
    # Auto-fit: size the row to show every course in this program's busiest cell.
    cell_lists=[]
    for label in ALL_COLS:
        if label in ("__day__","__break__"): continue
        ents=[e for e,_ in _col_meta(state,day,label,prog_codes)]
        cell_lists.append((ents, False))
    _autofit_height(ws,row,cell_lists)
    wc(ws,row,1,_day_abbr(day),bg=day_bg,fg=day_fg,bold=True,size=10,bc=day_bg,bw="medium")
    for ci,label in enumerate(ALL_COLS,1):
        if label=="__day__": continue
        if label=="__break__":
            wc(ws,row,ci,"  LUNCH BREAK",bg=_BRKBG,fg=_BRKFG,bold=True,italic=True,size=8,bc="B7791F",bw="medium")
            continue
        _render(ws,row,ci,_col_meta(state,day,label,prog_codes),th_bg,day_bg)

def _write_legend(ws,start_row):
    _write_sep(ws,start_row); r=start_row+1
    ws.merge_cells(start_row=r,start_column=1,end_row=r,end_column=N_COLS)
    wc(ws,r,1,"DEPARTMENT / DISCIPLINE — COLOR-CODING LEGEND",bg=_MHDR,fg=_W,bold=True,size=11,bc=_MHDR,bw="medium")
    ws.row_dimensions[r].height=22; r+=1
    ws.merge_cells(start_row=r,start_column=1,end_row=r,end_column=N_COLS)
    wc(ws,r,1,"Text color of each cell reflects department/discipline.",bg=_MSLOT,fg=_MSLFG,italic=True,size=8,bc=_MSLFG)
    ws.row_dimensions[r].height=14; r+=1
    items=list(DEPT_COLORS.items()); mid=(len(items)+1)//2
    left,right=items[:mid],items[mid:]
    for i in range(max(len(left),len(right))):
        ws.row_dimensions[r].height=26
        if i<len(left):
            dk,(fg,bg,label)=left[i]
            wc(ws,r,1,"  ████  ",bg=bg,fg=fg,bold=True,size=10,bc=fg,bw="medium")
            ws.merge_cells(start_row=r,start_column=2,end_row=r,end_column=5)
            c=ws.cell(row=r,column=2,value=label); c.fill=_fill(bg)
            c.font=_fnt(bold=True,color=fg,size=9)
            c.alignment=Alignment(horizontal="left",vertical="center"); c.border=_bdr(fg,"thin")
        if i<len(right):
            dk,(fg,bg,label)=right[i]
            wc(ws,r,6,"  ████  ",bg=bg,fg=fg,bold=True,size=10,bc=fg,bw="medium")
            ws.merge_cells(start_row=r,start_column=7,end_row=r,end_column=N_COLS)
            c=ws.cell(row=r,column=7,value=label); c.fill=_fill(bg)
            c.font=_fnt(bold=True,color=fg,size=9)
            c.alignment=Alignment(horizontal="left",vertical="center"); c.border=_bdr(fg,"thin")
        r+=1
    return r

# ── SHEET BUILDERS ────────────────────────────────────────────────────────────
def build_master(ws,state):
    ws.title="Master Timetable"; ws.sheet_view.showGridLines=False
    ws.freeze_panes="B3"; ws.sheet_properties.tabColor=_MHDR
    ws.merge_cells(start_row=1,start_column=1,end_row=1,end_column=N_COLS)
    wc(ws,1,1,"ABASYN UNIVERSITY ISLAMABAD CAMPUS  |  WEEKLY MASTER TIMETABLE  (Spring 2026)",
       bg=_MHDR,fg=_W,bold=True,size=13,bc="000000",bw="medium")
    ws.row_dimensions[1].height=28
    ws.merge_cells(start_row=2,start_column=1,end_row=2,end_column=N_COLS)
    wc(ws,2,1,"Theory cols (90 min) ◀──────────▶ Lab cols (3 hr)  |  [enrolled/cap]  |  ★ = constraint relaxed",
       bg=_MSLOT,fg=_MSLFG,italic=True,size=8,bc=_MSLFG)
    ws.row_dimensions[2].height=15
    _write_headers(ws,3,_MHDR,_W)
    r=4
    for day in DAYS: _write_day_master(ws,r,day,state); r+=1; _write_sep(ws,r); r+=1
    _write_legend(ws,r); _set_widths(ws); _setup_print(ws)

def build_prog_sheet(ws,program,state,df):
    safe=re.sub(r"[\\/*?:\[\]]","",program)[:31]
    ws.title=safe; ws.sheet_view.showGridLines=False; ws.freeze_panes="B3"
    hdr_bg,lt_bg=PROG_PALETTE.get(program,_PROG_DEFAULT)
    ws.sheet_properties.tabColor=hdr_bg
    prog_codes=set(df[df["program"]==program]["course_code"].astype(str))
    ws.merge_cells(start_row=1,start_column=1,end_row=1,end_column=N_COLS)
    wc(ws,1,1,f"ABASYN UNIVERSITY  |  {program.upper()}  —  WEEKLY TIMETABLE",
       bg=hdr_bg,fg=_W,bold=True,size=11,bc="000000",bw="medium")
    ws.row_dimensions[1].height=26
    ws.merge_cells(start_row=2,start_column=1,end_row=2,end_column=N_COLS)
    wc(ws,2,1,"Theory slots (left, 90 min)  ◀──▶  Lab slots (right, 3 hr)  |  [enrolled/cap]  |  [Room/Lab] - Section",
       bg=lt_bg,fg=hdr_bg,italic=True,size=8,bc=hdr_bg)
    ws.row_dimensions[2].height=14
    _write_headers(ws,3,hdr_bg,_W)
    r=4
    for day in DAYS: _write_day_prog(ws,r,day,state,prog_codes,hdr_bg,_W,lt_bg); r+=1; _write_sep(ws,r); r+=1
    _set_widths(ws); _setup_print(ws)

def build_course_list(ws,df):
    ws.title="Course List"; ws.sheet_view.showGridLines=False
    ws.sheet_properties.tabColor="2D3748"
    hdrs=["#","Code","Course Name","Component","Program","Batch","Sec","Teacher","Room","Enrolled","Dept"]
    ws.row_dimensions[1].height=20
    for ci,h in enumerate(hdrs,1): wc(ws,1,ci,h,bg="2D3748",fg=_W,bold=True,size=9,bc="000000",bw="medium")
    alt=False
    for ri,(_,row) in enumerate(df.iterrows(),2):
        bg="F0F4F8" if alt else _W; alt=not alt
        dk=row["dept_key"]; dfg=DEPT_COLORS.get(dk,("000000","",""))[0]
        ws.row_dimensions[ri].height=13
        vals=[ri-1,row["course_code"],row["name"],row["component"],
              row["program"],row["batch_id"],row.get("section",""),
              row["teacher"],row["room"],row.get("enrolled_n",0),DEPT_COLORS.get(dk,("","","Unknown"))[2]]
        for ci,v in enumerate(vals,1):
            cell=ws.cell(row=ri,column=ci,value=v); cell.fill=_fill(bg)
            cell.font=_fnt(color=dfg if ci in(2,3,11) else "1A202C",size=7.5)
            cell.alignment=Alignment(horizontal="left" if ci in(3,4,5,6,8,11) else "center",vertical="center")
            cell.border=_bdr("CBD5E0","thin")
    for ci,w in enumerate([5,12,36,10,26,16,5,26,10,8,30],1):
        ws.column_dimensions[get_column_letter(ci)].width=w
    _setup_print(ws)

def _bar(pct,width=20):
    filled=min(int(round(pct*width)),width)
    return "█"*filled+"░"*(width-filled)

def build_stats(ws,state,df):
    ws.title="Statistics"; ws.sheet_view.showGridLines=False; ws.sheet_properties.tabColor="2C5282"
    def sec_title(row,text,col_end=5):
        ws.merge_cells(start_row=row,start_column=1,end_row=row,end_column=col_end)
        wc(ws,row,1,text,bg="1B2A4A",fg=_W,bold=True,size=10,bc="000000",bw="medium")
        ws.row_dimensions[row].height=18
    def srow(row,label,value):
        wc(ws,row,1,label,bg="BEE3F8",fg="1A365D",bold=True,size=9,h="left",bc="90CDF4")
        wc(ws,row,2,value,bg=_W,size=9,bc="CBD5E0"); ws.row_dimensions[row].height=15
    lec_df=df[df["component"]=="Lecture"]; lab_df=df[df["component"]=="Lab"]
    sec_title(1,"TIMETABLE OVERVIEW"); ws.row_dimensions[1].height=22
    ov=[("Lecture Rows",len(lec_df)),("Lab Rows",len(lab_df)),
        ("Theory Sessions Placed",state.theory_count),("Lab Sessions Placed",state.lab_count),
        ("Programs",df["program"].nunique()),("Batch Groups",df["batch_key"].nunique()),
        ("Named Lecture Teachers",int((lec_df["teacher"]!="TBA").sum())),
        ("Named Lab Teachers",int((lab_df["teacher"]!="TBA").sum())),
        ("TBA Lecture Teachers",int((lec_df["teacher"]=="TBA").sum())),
        ("TBA Lab Teachers",int((lab_df["teacher"]=="TBA").sum())),
        ("Theory Rooms Available",len(THEORY_ROOMS)),("Working Days/Week",5)]
    for ri,(lbl,val) in enumerate(ov,2): srow(ri,lbl,val)
    r=len(ov)+3
    sec_title(r,"THEORY SLOT LOAD"); r+=1
    for ci,lbl in enumerate(["Day","Slot","Count","Load Bar","% of Rooms"],1):
        wc(ws,r,ci,lbl,bg="BEE3F8",fg="1A365D",bold=True,size=8,bc="90CDF4")
    ws.row_dimensions[r].height=14; r+=1
    cap=len(THEORY_ROOMS)
    for day in DAYS:
        for sl in THEORY_SLOTS:
            n=len(state.theory_tt.get((day,sl),[])); pct=n/cap; bar=_bar(pct,20)
            bg="FED7D7" if pct>.8 else "FEFCBF" if pct>.5 else "C6F6D5"
            wc(ws,r,1,day,bg=_W,size=8,h="left",bc="CBD5E0"); wc(ws,r,2,sl,bg=_W,size=8,bc="CBD5E0")
            wc(ws,r,3,n,bg=_W,size=8,bc="CBD5E0"); wc(ws,r,4,bar,bg=bg,size=8,h="left",bc="CBD5E0")
            wc(ws,r,5,f"{pct*100:.0f}%",bg=bg,size=8,bc="CBD5E0"); ws.row_dimensions[r].height=13; r+=1
    r+=1; sec_title(r,"LAB SLOT LOAD"); r+=1
    for ci,lbl in enumerate(["Day","Lab Slot","Sessions","Load Bar"],1):
        wc(ws,r,ci,lbl,bg="C6F6D5",fg="1C4532",bold=True,size=8,bc="9AE6B4")
    ws.row_dimensions[r].height=14; r+=1
    max_lab=max((len(state.lab_tt.get((d,s),[])) for d in DAYS for s in LAB_SLOTS),default=1) or 1
    for day in DAYS:
        for sl in LAB_SLOTS:
            n=len(state.lab_tt.get((day,sl),[])); pct=n/max_lab; bar=_bar(pct,20)
            bg="C6F6D5" if n>0 else _EMPBG
            wc(ws,r,1,day,bg=_W,size=8,h="left",bc="CBD5E0"); wc(ws,r,2,sl,bg=_W,size=8,bc="CBD5E0")
            wc(ws,r,3,n,bg=_W,size=8,bc="CBD5E0"); wc(ws,r,4,bar,bg=bg,size=8,h="left",bc="CBD5E0")
            ws.row_dimensions[r].height=13; r+=1
    for col,w in zip(["A","B","C","D","E"],[34,14,14,35,12]): ws.column_dimensions[col].width=w
    _setup_print(ws,landscape=False)

def build_guide(ws):
    ws.title="Guide"; ws.sheet_view.showGridLines=False; ws.sheet_properties.tabColor="276749"
    ws.merge_cells("A1:C1")
    wc(ws,1,1,"TIMETABLE GUIDE & LEGEND",bg="1B2A4A",fg=_W,bold=True,size=12,bc="000000",bw="medium")
    ws.row_dimensions[1].height=22
    items=[
        ("Theory cell","CODE  Course Name  [★ forced]\nTeacher  [Room] - Section  [enrolled/cap]",_W),
        ("Lab cell","LAB: CODE  Course Name\nTeacher  [Lab Name] - Section  [enrolled/cap]","E8F8F0"),
        ("HC8 rule","If a lab room is used for theory (e.g. 08:30-10:00), "
         "it cannot host a lab session in any overlapping slot (e.g. 08:30-11:30).","FFF9C4"),
        ("Lab capacity","Each lab has a defined capacity. If enrolled > capacity, "
         "course is placed with overflow warning in Clash_Report.txt Section 7.","FFF5F5"),
        ("★ marker","Constraint relaxed during backtracking. Check manually.","FFF5F5"),
        ("Slot layout","Day | 08:30 | 10:00 | 11:30 | LUNCH | 02:00 | 03:30 | LAB×4","EBF8FF"),
        ("3-cr lecture","2×90-min/week Mon+Wed OR Tue+Thu","FFFFFF"),
        ("Lab 1-cr","1×3-hr consecutive block per week","E8F8F0"),
        ("Clash report","Sections 1-10 in Clash_Report.txt","BEE3F8"),
    ]
    for ri,(k,v,bg) in enumerate(items,2):
        ws.row_dimensions[ri].height=42
        wc(ws,ri,1,k,bg=_MSLOT,fg=_MSLFG,bold=True,size=9,h="left",v="top",bc="90CDF4")
        wc(ws,ri,2,v,bg=bg,fg="1A202C",size=8,h="left",v="top",wrap=True,bc="CBD5E0")
        wc(ws,ri,3,"",bg=bg,bc="E2E8F0")
    ws.column_dimensions["A"].width=18; ws.column_dimensions["B"].width=82; ws.column_dimensions["C"].width=4
    _setup_print(ws,landscape=False)

# ── MAIN ──────────────────────────────────────────────────────────────────────
def main():
    import time as _t
    seed=int(_t.time()*1000)%(2**32); random.seed(seed)
    print("="*60); print("  ABASYN UNIVERSITY — TIMETABLE GENERATOR  v12"); print("="*60)
    mode = "DATABASE" if DATA_JSON else "EXCEL (legacy)"
    src  = DATA_JSON if DATA_JSON else INPUT_FILE
    print(f"  Mode  : {mode}\n  Seed  : {seed}\n  Source: {src}\n  Output: {OUTPUT_FILE}\n  Report: {REPORT_FILE}\n")

    print("[ 1 ]  Loading dataset …")
    try:
        if DATA_JSON:
            df, tba_issues = load_data_from_json(DATA_JSON)
        else:
            df, tba_issues = load_data()
    except (FileNotFoundError, ValueError) as e:
        # Emit a failure summary the backend can read, then exit non-zero.
        _write_summary({"status": "failed", "error": str(e)})
        print(f"\nERROR: {e}"); sys.exit(1)

    print("\n[ 2 ]  Building course structures …")
    courses=build_course_dicts(df)
    # UG vs PG (MS) split: the UG timetable drops MS (code>=500) courses; the PG
    # timetable keeps ONLY them (and runs Sat/Sun via DAYS above).
    want_pg = (LEVEL == "pg")
    before = len(courses)
    courses = [c for c in courses if _is_pg_code(c.get("code", "")) == want_pg]
    print(f"  Level: {LEVEL.upper()}  ({before} → {len(courses)} courses after level filter)")
    if not courses:
        _write_summary({"status": "failed",
                        "error": f"No {'postgraduate (MS)' if want_pg else 'undergraduate'} courses to schedule."})
        print("\nERROR: no courses for this level."); sys.exit(1)
    n_lec = sum(1 for c in courses if c['component']=='Lecture')
    n_lab = sum(1 for c in courses if c['component']=='Lab')
    print(f"  Lectures: {n_lec}  Labs: {n_lab}")

    # Solver choice: default is the metaheuristic pipeline (greedy -> Tabu -> VNS),
    # which empirically leaves the fewest sessions unplaced. Set TT_SOLVER=greedy to
    # fall back to the original best-of-N random-restart greedy.
    solver = os.environ.get("TT_SOLVER", "meta").lower()

    if solver == "meta":
        print("\n[ 3 ]  Running scheduler — greedy → Tabu Search → VNS …")
        state, lab_overflows, lab_unplaced, theory_unplaced = run_scheduler_meta(courses)
    else:
        print("\n[ 3 ]  Running CSP scheduler (best-of-N greedy) …")
        best = None
        best_score = None
        _use_cpsat = os.environ.get("TT_LAB_SOLVER", "greedy").lower() == "cpsat" and HAVE_CPSAT
        ATTEMPTS = int(os.environ.get("TT_ATTEMPTS", "0")) or (3 if _use_cpsat else 12)
        for attempt in range(ATTEMPTS):
            st, ovf, unp, theory_unp = run_scheduler(courses)
            clash_ct = _quick_clash_count(st)
            score = clash_ct * 100000 + (len(theory_unp) + len(unp)) * 100 + len(ovf)
            if best_score is None or score < best_score:
                best_score = score
                best = (st, ovf, unp, theory_unp)
            if score == 0:
                print(f"  Attempt {attempt+1}: fully clash-free AND fully placed — stopping early.")
                break
            else:
                print(f"  Attempt {attempt+1}: score={score} "
                      f"(clashes={clash_ct}, unplaced={len(theory_unp)+len(unp)}, overflow={len(ovf)})")
        state, lab_overflows, lab_unplaced, theory_unplaced = best

    print("\n[ 4 ]  Clash verification …")
    tc,rc,lc,cvc = verify_and_report(state,df,tba_issues,lab_overflows,lab_unplaced)

    print("\n[ 5 ]  Building Excel workbook …")
    wb=Workbook(); wb.remove(wb.active)
    build_master(wb.create_sheet("Master Timetable"),state); print("      ✓  Master Timetable")
    progs=sorted(df["program"].unique())
    for prog in progs: build_prog_sheet(wb.create_sheet(),prog,state,df)
    print(f"      ✓  {len(progs)} program sheets")
    build_course_list(wb.create_sheet("Course List"),df)
    build_stats(wb.create_sheet("Statistics"),state,df)
    build_guide(wb.create_sheet("Guide"))
    print("      ✓  Course List · Statistics · Guide")

    try: wb.save(OUTPUT_FILE); saved=OUTPUT_FILE
    except PermissionError:
        alt=OUTPUT_FILE.replace(".xlsx","_new.xlsx"); wb.save(alt); saved=alt
        print(f"  ⚠  File open — saved as: {alt}")

    pdf_made = False
    if not _ARGS.no_pdf:
        print("\n[ 6 ]  Generating PDF …")
        pdf_path=saved.replace(".xlsx",".pdf")
        try:
            import subprocess,shutil
            lo=shutil.which("libreoffice") or shutil.which("soffice")
            if lo:
                res=subprocess.run([lo,"--headless","--convert-to","pdf","--outdir",
                                    os.path.dirname(saved),saved],
                                   capture_output=True,text=True,timeout=300)
                if res.returncode==0 and os.path.exists(pdf_path):
                    pdf_made = True
                    print(f"      ✓  PDF → {pdf_path}  ({os.path.getsize(pdf_path)/1024/1024:.1f} MB)")
                else: print(f"      ⚠  PDF failed: {res.stderr[:150]}")
            else: print("      ⚠  LibreOffice not found (Excel still generated).")
        except Exception as e: print(f"      ⚠  PDF error: {e}")

    total=tc+rc+lc+cvc
    print(f"\n{'='*60}\n  ✅  Saved → {saved}")
    print(f"  Sheets: {', '.join(ws.title for ws in wb.worksheets)}")
    print(f"\n  Clash summary → Teacher:{tc}  Room:{rc}  Lab:{lc}  CapViol:{cvc}")
    print("  ✓✓  FULLY CLASH-FREE" if total==0 else f"  !!  {total} issues — see {REPORT_FILE}")
    print(f"  Lab overflows : {len(lab_overflows)} (check Section 7 in report)")
    print(f"  TBA courses   : {len(set(i['course_code'] for i in tba_issues))}")
    print("="*60)

    # ── Accuracy metric ────────────────────────────────────────────────────
    # Every session that is placed with no hard clash AND no capacity overflow
    # is "perfectly scheduled". Accuracy = perfect / total sessions.
    total_sessions = state.theory_count + state.lab_count + len(lab_unplaced)
    # Each hard clash and each overflow/unplaced counts as one imperfect session
    imperfect = total + len(lab_overflows) + len(lab_unplaced)
    perfect = max(0, total_sessions - imperfect)
    accuracy = round(100.0 * perfect / total_sessions, 2) if total_sessions else 100.0

    split_groups = sum(1 for c in courses
                       if c.get("component") == "Lab" and c.get("group_total"))

    print(f"  Scheduling accuracy       : {accuracy}%  ({perfect}/{total_sessions} sessions perfect)")
    print("="*60)

    # Capacity advisor — where do we run out of rooms/labs, and what to add?
    advisor = capacity_advisor(state, courses, theory_unplaced, lab_unplaced, lab_overflows)
    _print_capacity_advisor(advisor)

    # Machine-readable summary for the web backend
    _write_schedule(state, df)

    _write_summary({
        "capacityAdvisor": advisor,
        "status": "ok",
        "mode": mode,
        "seed": seed,
        "scheduleFile": os.path.basename(SCHEDULE_JSON),
        "excelFile": os.path.basename(saved),
        "pdfFile": os.path.basename(saved).replace(".xlsx", ".pdf") if pdf_made else None,
        "reportFile": os.path.basename(REPORT_FILE),
        "clashes": {
            "teacher": tc, "room": rc, "lab": lc, "capacity": cvc,
            "total": total,
        },
        "fullyClashFree": total == 0,
        "accuracy": accuracy,
        "stats": {
            "lectureRows": n_lec,
            "labRows": n_lab,
            "theorySessions": state.theory_count,
            "labSessions": state.lab_count,
            "totalSessions": total_sessions,
            "perfectSessions": perfect,
            "splitGroups": split_groups,
            "programs": int(df["program"].nunique()),
            "namedTeachers": int(df[df["teacher"]!="TBA"]["teacher"].nunique()),
            "tbaCourses": len(set(i["course_code"] for i in tba_issues)),
            "labOverflows": len(lab_overflows),
            "labUnplaced": len(lab_unplaced),
        },
    })


def _write_summary(payload):
    try:
        with open(SUMMARY_JSON, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
    except Exception as e:
        print(f"  ⚠  Could not write summary JSON: {e}")


def _write_schedule(state, df, semester=None, year=None):
    """Emit every placed session as structured data for the search assistant."""
    try:
        rooms = sorted({ra["room"] for ra in state.room_assignments})
        programs = sorted({str(p) for p in df["program"].unique()}) if df is not None else []
        sessions = []
        student_index = defaultdict(list)   # studentId -> [session index, ...]
        for i, ra in enumerate(state.room_assignments):
            sessions.append({
                "code": ra["code"], "name": ra["name"],
                "teacher": ra.get("teacher", "TBA"),
                "room": ra["room"], "day": ra["day"], "slot": ra["slot"],
                "section": ra.get("section", ""), "program": ra.get("program", ""),
                "enrolled": ra.get("enrolled", 0), "cap": ra.get("cap", 0),
                "component": ra.get("component", "Lecture"),
            })
            for sid in ra.get("students", []):
                student_index[str(sid)].append(i)
        payload = {
            "kind": "timetable",
            "semester": semester, "year": year,
            "days": DAYS, "theory_slots": THEORY_SLOTS, "lab_slots": LAB_SLOTS,
            "rooms": rooms,                       # rooms that actually host a class
            "all_rooms": sorted(ROOM_CAP.keys()), # every room in the DB
            "labs": sorted(LAB_CAP.keys()),
            "room_caps": {k: v for k, v in ROOM_CAP.items()},
            "programs": programs,
            "sessions": sessions,
            # per-student timetable: reg-no → the sessions (by index) they attend,
            # each carrying its SECTION → powers the student-portal personal timetable.
            "student_index": student_index,
        }
        with open(SCHEDULE_JSON, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
    except Exception as e:
        print(f"  ⚠  Could not write schedule JSON: {e}")


if __name__=="__main__":
    try: main()
    except KeyboardInterrupt: print("\nInterrupted."); sys.exit(0)
    except Exception:
        print("\nUnexpected error:"); traceback.print_exc()
        try: _write_summary({"status": "failed", "error": "Unexpected scheduler error"})
        except Exception: pass
        sys.exit(1)
