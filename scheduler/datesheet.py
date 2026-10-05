"""
Datesheet Generator — Abasyn University Islamabad Campus
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Generates clash-free Mid / Final exam datesheets in the exact official layout.

Highlights
  • Mids  → 3 columns (09:00-10:30, 11:00-12:30, 01:00-02:30)
  • Finals→ 2 columns (09:00-12:00, 01:00-03:00)
  • Days as rows, time-slots as columns (matches the official PDF)
  • Two exam-window modes:
        - by_papers : caller gives papers-per-slot, days auto-computed
        - by_days   : caller gives number of days, all papers fit within them
  • Batch clash-free: a student's two papers never share a slot; same-day is
    allowed only as a last resort (next day preferred).
  • Hard rules:  CE & PD papers → first slot;  English 1/2/3 → same slot.
  • Merge groups: different course codes with the same paper sit in one slot.
  • Works with EITHER dataset shape:
        - timetable format (Code, Name, Component, Program Batch, …)
        - student-wise format (Student ID, Academic Program, Batch Intake,
          "Courses with Names", …)  ← enables true per-student clash checks.

Usage (frontend calls this):
    python datesheet.py --config config.json
  where config.json holds every user input (see _run docstring).

Legacy CLI still works:
    python datesheet.py <mids|finals> <YYYY-MM-DD> [--data export.json] [--out file.pdf]
"""

import sys
import os
import json
import re
import math
import random
import argparse
from datetime import datetime, timedelta
from pathlib import Path
from collections import defaultdict

import pandas as pd
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib import colors
from reportlab.lib.units import cm, mm
from reportlab.platypus import (
    SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, Image as RLImage,
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CONFIG
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DATASET_PATH = Path(__file__).parent / "timetable-dataset.xlsx"

# Column time-slots for each exam type (order = left→right in the PDF)
MIDS_SLOTS = ["09:00-10:30", "11:00-12:30", "01:00-02:30"]
FINALS_SLOTS = ["09:00-12:00", "01:00-03:00"]

# Courses excluded from any datesheet / admit card (no written paper). Keywords
# are matched against a NORMALISED name (punctuation → single space) so
# "Project - II", "Project-II", "Project  II" all match (e.g. CT394 "Project - II").
FYP_KEYWORDS = [
    "final year project", "fyp",
    "research project", "research work", "research thesis",
    "term project", "short term project", "semester project", "mini project", "design project",
    "project i", "project ii", "project iii", "project 1", "project 2", "project 3",
    "internship", "industrial internship", "internship project", "industrial training",
    "supervised industrial", "supervised field", "field training", "field work",
    "thesis", "dissertation", "term paper", "capstone",
    "civil engineering project", "engineering project",
]

# Palette (matches the official green datesheet)
_DARK_GREEN = colors.HexColor("#0f5132")
_MID_GREEN  = colors.HexColor("#198754")
_HEAD_GREEN = colors.HexColor("#14663f")
_MINT       = colors.HexColor("#d1e7dd")
_MINT_DEEP  = colors.HexColor("#a3cfbb")
_BORDER     = colors.HexColor("#94c7ac")
_GREY_TEXT  = colors.HexColor("#6c757d")
_INK        = colors.HexColor("#1c1c1c")
_ROW_ALT    = colors.HexColor("#f2f8f5")

DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

# Per-day slot times (BTech): weekdays use `slots`, weekends use WEEKEND_SLOTS.
# INCLUDE_SUNDAYS lets the exam window run on Sundays too (BTech is 7-day).
WEEKEND_SLOTS = None
INCLUDE_SUNDAYS = False

# Per-day COLUMN mask (BTech). When set to {"weekday": {idx...}, "weekend": {idx...}}
# the datesheet has one FIXED column per slot (like the main sheet), but a day may
# only carry papers in the slots allowed for its kind — every other column stays
# blank. e.g. weekdays → {2} (03:00-04:30), Sat/Sun → {0,1} (09:00, 01:00).
SLOT_MASK = None

# Blocked windows — (weekday, start_min, end_min) time ranges no exam slot may
# overlap, e.g. Friday Jumma 12:30-14:30. weekday: Mon=0 … Sun=6 (Python weekday()).
# Populated in run() from config["blocked_windows"]; a slot whose time overlaps a
# blocked window on that day is not a valid cell for ANY program.
BLOCKED_WINDOWS = []

def _slot_time_span(label):
    """Parse 'HH:MM-HH:MM' → (start_min, end_min); exam clock hours 1-7 = afternoon."""
    mm = re.findall(r'(\d{1,2}):(\d{2})', str(label or ''))
    if len(mm) < 2:
        return None
    def tm(h, m):
        h, m = int(h), int(m)
        if h < 8:
            h += 12
        return h * 60 + m
    return (tm(*mm[0]), tm(*mm[1]))

def _is_blocked(date, label):
    """True if this slot's time overlaps a configured blocked window on this day."""
    if not BLOCKED_WINDOWS:
        return False
    sp = _slot_time_span(label)
    if not sp:
        return False
    wd = date.weekday()
    for (bwd, bstart, bend) in BLOCKED_WINDOWS:
        if wd == bwd and sp[0] < bend and bstart < sp[1]:
            return True
    return False

def _slot_ok(date, s_i, slots=None):
    """Is slot index s_i allowed to carry a paper on this date? Respects the per-day
    SLOT_MASK AND blocked windows (Friday Jumma)."""
    if SLOT_MASK:
        allowed = SLOT_MASK["weekend"] if date.weekday() >= 5 else SLOT_MASK["weekday"]
        if s_i not in allowed:
            return False
    if BLOCKED_WINDOWS and slots is not None:
        if _is_blocked(date, _slot_label(date, s_i, slots)):
            return False
    return True

def _day_slots(dates, d_i, n_slots, slots=None):
    """Valid slot indices for a given day (respects SLOT_MASK + blocked windows)."""
    return [s for s in range(n_slots) if _slot_ok(dates[d_i], s, slots)]

def _slot_label(date, s_i, slots):
    """The time shown for a slot on a given date — weekend override when set."""
    if WEEKEND_SLOTS and date.weekday() >= 5:   # 5=Sat, 6=Sun
        return WEEKEND_SLOTS[s_i] if s_i < len(WEEKEND_SLOTS) else (WEEKEND_SLOTS[0] if WEEKEND_SLOTS else slots[s_i])
    return slots[s_i]


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# HELPERS: text / code parsing
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def _norm(s) -> str:
    return re.sub(r"\s+", " ", str(s or "").strip())


def _extract_course_code(raw: str) -> str:
    """Pull a course code like 'CS101', 'ENG-201', 'PD323-II' from a string."""
    s = _norm(raw)
    m = re.match(r"^([A-Za-z]{2,6}[-\s]?\d{3,4}(?:-II|-I)?)", s)
    if m:
        return re.sub(r"\s", "", m.group(1)).upper()
    # fallback: first token
    return s.split()[0].upper() if s else s


def _split_code_and_name(raw: str):
    """
    From 'CS313 - Operating Systems Concepts - 3.0' return
    ('CS313', 'Operating Systems Concepts') — strips a trailing credit value.
    Also handles 'CS101 - Introduction', 'CS101 Introduction', and names with
    an embedded credit like 'Digital Logic Design (3.00)'.
    """
    s = _norm(raw)
    # strip a trailing credit like "- 3.0" or "- 3"
    cm = re.search(r"-\s*\d+(?:\.\d+)?\s*$", s)
    if cm:
        s = s[:cm.start()].strip()
    # strip a trailing bracketed credit like "(3.00)" or "(3)"
    s = re.sub(r"\s*\(\d+(?:\.\d+)?\)\s*$", "", s).strip()
    code = _extract_course_code(s)
    name = s
    m = re.match(r"^[A-Za-z]{2,6}[-\s]?\d{3,4}(?:\[\d+\])?(?:-II|-I)?\s*[-–:]?\s*(.*)$", s)
    if m and m.group(1):
        name = m.group(1).strip()
    # clean any leftover trailing bracketed credit in the name too
    name = re.sub(r"\s*\(\d+(?:\.\d+)?\)\s*$", "", name).strip()
    return code, _norm(name)


_FYP_RES = [re.compile(r"(?<![a-z0-9])" + re.escape(k) + r"s?(?![a-z0-9])") for k in FYP_KEYWORDS]
# A course literally named "Project" / "Project - II" (RT499 "Project") has no paper.
_BARE_PROJECT_RE = re.compile(r"^(?:research\s+)?project(?:\s+(?:i{1,3}|[1-3]))?$")


def _is_excluded(name: str) -> bool:
    """No-written-exam courses (FYP / thesis / internship / project-I/II …).
    Keywords match as WHOLE words on a punctuation-normalised name, so
      "Project - II"            → excluded  ("project ii")
      "Software Project Management", "Project Scope, Time and Cost Management",
      "Project Integration …"   → NOT excluded (real theory papers; the old
                                   substring test dropped them: "project i" ⊂
                                   "project integration")."""
    n = re.sub(r"[^a-z0-9]+", " ", str(name or "").lower()).strip()
    if _BARE_PROJECT_RE.match(n):
        return True
    return any(rx.search(n) for rx in _FYP_RES)


def _looks_like_lab(name: str) -> bool:
    """A LAB course by its name — 'Applied Mechanics lab', 'Foundation Eng (Lab)'.
    Matches 'lab' as a WHOLE word (so 'Laboratory Mathematics' is NOT a lab)."""
    return re.search(r"\blab\b", str(name or ""), re.IGNORECASE) is not None


def _is_lab_code(code: str, all_codes_upper) -> bool:
    """DEPRECATED — no longer used to exclude papers. A code-only guess ("code ends
    in 'L' and a sibling without the L exists") wrongly flags real LECTURES whose
    department prefix simply ends in L: e.g. CETL312 'Reinforced and Pre Stress
    Concrete' (a Civil-Engineering-Technology THEORY paper, component=Lecture) has
    the sibling CET312, so this heuristic dropped its exam for ~17 students. Labs
    are already caught reliably by component=='Lab' (in load_courses_from_json) and
    by `_looks_like_lab` (name contains 'lab'), so this guess is both redundant and
    unsafe. Kept only so any external caller does not break."""
    c = str(code or "").upper()
    m = re.match(r"^([A-Z]+)(\d.*)$", c)
    if not m:
        return False
    alpha, num = m.group(1), m.group(2)
    return len(alpha) >= 2 and alpha.endswith("L") and (alpha[:-1] + num) in all_codes_upper


def _is_no_exam(code: str, name: str, all_codes_upper=frozenset()) -> bool:
    """No WRITTEN EXAM: labs (anywhere — BS/MS/BTech) and FYP/thesis/project/
    internship etc. Used by BOTH the datesheet and admit-card generators.
    Labs are identified by component=='Lab' (handled by the caller) OR by the name
    containing the word 'lab'. The old code-pattern lab guess is intentionally NOT
    used here — it mis-flagged real lectures like CETL312 (see `_is_lab_code`)."""
    return _is_excluded(name) or _looks_like_lab(name)


def _clean_batch(raw: str) -> str:
    """Normalise a batch/intake label, e.g. 'BSCS Fall 2023' or 'Fall-23'."""
    return _norm(raw)


# English course detection (the three that must share a slot)
_ENGLISH_PATTERNS = [
    "functional english", "communication skill", "writing skill",
    "english-i", "english-ii", "english-iii", "english i", "english ii", "english iii",
    "english 1", "english 2", "english 3",
]


def _is_english_trio(name: str) -> bool:
    n = str(name or "").lower()
    return any(p in n for p in _ENGLISH_PATTERNS)


# Department code-prefixes whose papers are forced into the FIRST slot.
# Set by main() from the admin's choice (config "first_slot_departments").
# None  → backward-compatible default (CE + PD);
# []    → no department is forced (fully free, balanced placement);
# [...] → exactly the admin-selected prefixes.
FIRST_SLOT_PREFIXES = None

def _is_first_slot_dept(code: str) -> bool:
    """True if this course's department is one the admin pinned to the first slot."""
    c = str(code or "").upper()
    prefixes = FIRST_SLOT_PREFIXES
    if prefixes is None:
        prefixes = ("CE", "PD")            # default when the admin made no choice
    return any(c.startswith(str(p).upper()) for p in prefixes if str(p).strip())


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# DATA LOADING  (supports BOTH dataset shapes)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def _course_key(code: str, name: str) -> str:
    return f"{code}||{name.lower()}"


def load_courses_generic(df: pd.DataFrame) -> list:
    """
    Detect the dataset shape and return a list of unique course dicts:
        { code, name, batches:set(), students:set(), label }
    - "batches"  : set of batch labels that take this paper
    - "students" : set of student IDs that take this paper (may be empty)
    """
    cols = {c.lower().strip(): c for c in df.columns}

    def has(*names):
        return all(n in cols for n in names)

    courses = {}   # course_key -> dict

    # ---- Shape A: student-wise ("Courses with Names") ----------------------
    if "courses with names" in cols:
        col_courses = cols["courses with names"]
        col_prog    = cols.get("academic program")
        col_batch   = cols.get("batch intake")
        col_sid     = cols.get("student id")

        for _, row in df.iterrows():
            sid   = _norm(row[col_sid]) if col_sid else ""
            batch = _clean_batch(row[col_batch]) if col_batch else ""
            prog  = _norm(row[col_prog]) if col_prog else ""
            batch_label = " ".join(x for x in [prog, batch] if x) or (batch or prog)

            raw = str(row[col_courses] or "")
            # Courses separated by commas; names themselves contain " - ".
            # Split on a comma followed by a course-code pattern (or end).
            parts = re.split(r",\s*(?=[A-Za-z]{2,6}[-\s]?\d{3,4}|$)", raw)
            # also handle ; | newline separators if present
            if len(parts) <= 1:
                parts = re.split(r"[;\n|]+", raw)

            for part in parts:
                part = _norm(part).rstrip(",")
                if not part:
                    continue
                code, name = _split_code_and_name(part)
                if not code or _is_excluded(name) or _looks_like_lab(name):
                    continue
                key = _course_key(code, name)
                c = courses.setdefault(key, {
                    "code": code, "name": name, "batches": set(), "students": set(),
                })
                if batch_label:
                    c["batches"].add(batch_label)
                if sid:
                    c["students"].add(sid)

    # ---- Shape B: timetable format (Code / Name / Component / Program Batch)-
    elif has("code", "name") or "component" in cols:
        col_code = cols.get("code")
        col_name = cols.get("name")
        col_comp = cols.get("component")
        col_batch = cols.get("program batch") or cols.get("batch") or cols.get("batch intake")

        for _, row in df.iterrows():
            comp = _norm(row[col_comp]) if col_comp else "Lecture"
            if comp and comp.lower() == "lab":
                continue  # labs have no written paper in the datesheet
            raw_code = _norm(row[col_code]) if col_code else ""
            name = _norm(row[col_name]) if col_name else ""
            if not raw_code and not name:
                continue
            code = _extract_course_code(raw_code) if raw_code else _extract_course_code(name)
            if _is_excluded(name) or _looks_like_lab(name):
                continue
            batch = _clean_batch(row[col_batch]) if col_batch else ""
            key = _course_key(code, name)
            c = courses.setdefault(key, {
                "code": code, "name": name, "batches": set(), "students": set(),
            })
            if batch:
                c["batches"].add(batch)

    else:
        raise ValueError(
            "Unrecognised dataset columns. Expected either a 'Courses with Names' "
            "column (student-wise) or 'Code'/'Name'/'Component' (timetable format)."
        )

    # finalise
    out = []
    for c in courses.values():
        label = f"{c['code']}  {c['name']}".strip()
        out.append({
            "code": c["code"],
            "name": c["name"],
            "batches": c["batches"],
            "students": c["students"],
            "label": label,
        })
    return out


def load_courses(path: Path) -> list:
    df = pd.read_excel(path)
    return load_courses_generic(df)


def load_courses_from_json(path: Path) -> list:
    """
    Load courses from a DB export. If the export also carries
    `student_registrations` (per-student course lists), attach the real student
    rosters to each course — this is what makes clash-free scheduling possible.
    """
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    rows = data.get("courses", data) if isinstance(data, dict) else data
    regs = data.get("student_registrations", []) if isinstance(data, dict) else []

    # all course codes (for the lab-sibling check: CETL312 is a lab of CET312)
    all_codes = set()
    for r in rows:
        cc = _extract_course_code(r.get("code") or r.get("fullCode") or "")
        if cc:
            all_codes.add(cc.upper())

    courses = {}
    # code -> course dict (so we can attach students by code afterwards)
    by_code = {}
    for r in rows:
        comp = _norm(r.get("component", "Lecture"))
        if comp.lower() == "lab":
            continue
        code = _extract_course_code(r.get("code") or r.get("fullCode") or "")
        name = _norm(r.get("name"))
        # No written exam: labs (even if wrongly tagged 'Lecture') + FYP/thesis/etc.
        if not code or _is_no_exam(code, name, all_codes):
            continue
        batch = _clean_batch(r.get("programBatch") or r.get("batch") or "")
        # ONE paper per course CODE within a datesheet: duplicate Course rows and
        # name variants of the same code (e.g. SS118 "Pakistan Studies" and
        # "Pakistan Studies (3+0)") merge into a single exam — otherwise the same
        # code lands in two slots. (Across programs the datesheets are separate, so
        # this never merges another cohort's paper.)
        key = code.upper()
        c = courses.get(key)
        if c is None:
            c = {"code": code, "name": name, "batches": set(), "students": set()}
            courses[key] = c
            by_code[code] = [c]
        elif name and (not c["name"] or len(name) < len(c["name"])):
            c["name"] = name          # prefer the shorter/canonical name variant
        if batch:
            c["batches"].add(batch)

    # Attach real student rosters. For every student, add their ID to each of
    # their registered courses AND record the batch on those courses.
    for reg in regs:
        sid = str(reg.get("student_id") or reg.get("studentId") or "").strip()
        if not sid:
            continue
        batch = _clean_batch(reg.get("batch") or "")
        for code in reg.get("courses", []):
            code_u = _extract_course_code(code)
            for c in by_code.get(code_u, []):
                c["students"].add(sid)
                if batch:
                    c["batches"].add(batch)

    # When real rosters are present, a course NO student sits gets NO paper — this
    # drops ghost / zero-enrolment offerings so the datesheet never carries an empty
    # exam (P3 validation). Without rosters (batch-only data) we keep every course.
    has_regs = bool(regs)
    out = []
    for c in courses.values():
        if has_regs and not c["students"]:
            continue
        out.append({
            "code": c["code"], "name": c["name"],
            "batches": c["batches"], "students": c["students"],
            "label": f"{c['code']}  {c['name']}".strip(),
        })
    return out


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# EXAM DATES
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def get_exam_dates(start_date: datetime, n_days: int, exclude=None) -> list:
    """
    Return n_days consecutive exam dates from start_date, skipping Sundays and
    any explicitly excluded dates (public holidays). For every excluded working
    day, the window simply extends by one more working day at the end.

    `exclude` is a set/list of 'YYYY-MM-DD' strings.
    """
    excl = set(exclude or [])
    cur = start_date.replace(hour=0, minute=0, second=0, microsecond=0)
    dates = []
    while len(dates) < n_days:
        iso = cur.strftime("%Y-%m-%d")
        skip_sun = (cur.weekday() == 6) and not INCLUDE_SUNDAYS   # 6 = Sunday
        if not skip_sun and iso not in excl:
            dates.append(cur)
        cur += timedelta(days=1)
    return dates


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# MERGE GROUPS  &  UNITS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def _group_codes(group):
    """Every course code in a merge group, robust to codes typed together in one
    entry ("VS401 /SS401", "SU106/DP112/DP113") — previously only the first code of
    such an entry was kept, so the merge silently did not happen."""
    out = []
    for g in group or []:
        for m in re.findall(r"[A-Za-z]{2,6}[-\s]?\d{3,4}(?:-II|-I)?", str(g or "")):
            c = re.sub(r"[\s]", "", m).upper()
            if c not in out:
                out.append(c)
    return out


def detect_merge_conflicts(courses: list, merge_groups: list):
    """
    Check merge groups WITHOUT changing anything. Returns a list of conflicting
    groups — those where a single student is registered in more than one of the
    codes (so merging them into one slot would double-book that student).
    Used to warn the user and offer a choice before generating.
    """
    by_code = {}
    for c in courses:
        by_code.setdefault(c["code"], []).append(c)

    conflicts = []
    for group in merge_groups or []:
        group_codes = _group_codes(group)
        members = []
        for code in group_codes:
            members.extend(by_code.get(code, []))
        if len(members) < 2:
            continue
        seen = {}
        clashing_students = 0
        bad = False
        for m in members:
            for s in m["students"]:
                if s in seen and seen[s] != m["code"]:
                    clashing_students += 1
                    bad = True
                seen[s] = m["code"]
        if bad:
            conflicts.append({
                "group": [m["code"] for m in members],
                "students_affected": clashing_students,
                "reason": "some students take more than one of these courses",
            })
    return conflicts


def apply_merges(courses: list, merge_groups: list, force_merges: bool = False):
    """
    Combine courses that the user marked as "same paper, different codes".
    merge_groups: list of lists of course codes, e.g. [["CS101","IT101"], ...].

    Returns a list of "units" where each unit is a group of courses that must
    share one slot:
        { codes:[...], names:[...], batches:set(), students:set(),
          labels:[...], first_slot:bool, english:bool }
    Unmerged courses each become a unit of size 1.

    A merge only makes sense when the codes are alternate labels for the SAME
    paper — i.e. no single student is registered in more than one of them.

    • force_merges=False (default): if a student IS in two codes of a group,
      those codes are NOT merged (kept separate) so the datesheet stays
      clash-free. The conflict is recorded in `apply_merges.last_warnings`.
    • force_merges=True: merge exactly as the user asked, even where that
      double-books some students. The clash is then unavoidable and reported.
    """
    by_code = {}
    for c in courses:
        by_code.setdefault(c["code"], []).append(c)

    used = set()
    units = []
    warnings = []

    # explicit merges first
    for group in merge_groups or []:
        group_codes = _group_codes(group)
        members = []
        for code in group_codes:
            for c in by_code.get(code, []):
                if id(c) not in used:
                    members.append(c)
                    used.add(id(c))
        if not members:
            continue

        # Smart auto-resolve: merge as many of these codes as possible into one
        # slot WITHOUT double-booking any student. We add codes to the merged
        # unit one by one; if a code shares a student with the group so far, it
        # can't join (that student would sit two papers at once), so it stays a
        # separate unit. This always merges what is safely mergeable and never
        # leaves a student clash — no user prompt needed.
        merged_students = set()
        merged_members = []
        split_members = []
        for m in members:
            if m["students"] & merged_students:
                split_members.append(m)          # would clash — keep separate
            else:
                merged_members.append(m)
                merged_students |= m["students"]

        if merged_members:
            units.append(_make_unit(merged_members))
        for m in split_members:
            units.append(_make_unit([m]))

        if split_members:
            # Record what happened so the UI can show an informational note
            # (not a question — the system already resolved it).
            warnings.append({
                "group": [m["code"] for m in members],
                "merged": [m["code"] for m in merged_members],
                "kept_separate": [m["code"] for m in split_members],
                "reason": "auto-resolved: some students take more than one of these, "
                          "so those were kept in separate slots to stay clash-free",
                "auto_resolved": True,
            })

    # NOTE: English handling = English-I (SS104) + English-III (SS211) share ONE slot
    # (merged above, clash-free since no student takes both), and English-II (SS203)
    # sits in a DIFFERENT slot on the SAME day. The same-day pairing is enforced by the
    # CP-SAT `same_day_groups` constraint (SS104/SS203/SS211 → one day): after the
    # I+III merge that group is just 2 units, which fits a 2-slot FINALS day cleanly.

    # everything else = singleton units
    for c in courses:
        if id(c) not in used:
            units.append(_make_unit([c]))
            used.add(id(c))

    apply_merges.last_warnings = warnings
    return units


apply_merges.last_warnings = []


def _make_unit(members: list, english: bool = False):
    codes = [m["code"] for m in members]
    names = [m["name"] for m in members]
    batches = set()
    students = set()
    labels = []
    first_slot = False
    is_eng = english
    for m in members:
        batches |= m["batches"]
        students |= m["students"]
        labels.append(m["label"])
        if _is_first_slot_dept(m["code"]):
            first_slot = True
        if _is_english_trio(m["name"]):
            is_eng = True
    return {
        "codes": codes, "names": names, "batches": batches, "students": students,
        "labels": labels, "first_slot": first_slot, "english": is_eng,
    }


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SCHEDULING  (batch / student clash-free)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def _units_conflict(u1, u2) -> bool:
    """True if two units share any student (preferred) or any batch (fallback)."""
    if u1["students"] and u2["students"]:
        if u1["students"] & u2["students"]:
            return True
    # always also guard on batch overlap
    return bool(u1["batches"] & u2["batches"])


def compute_days_needed(units, slots, papers_per_slot=None):
    """How many exam days are required."""
    n_slots = len(slots)
    if papers_per_slot:
        cap_per_day = papers_per_slot * n_slots
        return max(1, math.ceil(len(units) / cap_per_day))
    # default: aim for a comfortable spread (≈ enough days so a batch's papers
    # never pile up). Start from a rough estimate and let the scheduler expand.
    return max(1, math.ceil(len(units) / n_slots))


def _schedule_once(units, dates, slots, papers_per_slot=None, seed=42, force_fit=False):
    """
    One placement attempt with a given random seed (greedy + local search).
    schedule_units() calls this several times and keeps the best result.

    Ordering of priority:
      1. Units pinned to the FIRST slot (CE/PD) placed first, in slot 0.
      2. Remaining units placed to avoid batch/student clashes in the same slot.
      3. Same-day placement for a clashing batch is avoided; next day preferred.
      4. If papers_per_slot is set, never exceed it in a slot (unless force_fit).

    Returns schedule: {(date, slot_index): [unit, ...]}
    """
    random.seed(seed)
    cells = [(d_i, s_i) for d_i in range(len(dates)) for s_i in range(len(slots))]
    schedule = {cell: [] for cell in cells}

    # helpers ---------------------------------------------------------------
    def slot_load(cell):
        return sum(len(u["labels"]) for u in schedule[cell])

    # ── Graph-colouring placement ──────────────────────────────────────────
    # Treat each unit as a graph vertex; two units are adjacent if a student
    # (or, absent rosters, a batch) is common to both. Colouring the graph so
    # adjacent units get different cells == a clash-free datesheet. We use a
    # DSATUR-style order (most-constrained unit first) and, among the legal
    # cells, pick the least-loaded one so slots stay balanced. This finds a
    # zero-clash arrangement whenever one mathematically exists.
    n_cells = len(cells)
    cap = math.ceil(len(units) / n_cells) if n_cells else len(units)
    cap_limit = (papers_per_slot or cap) + 2  # small buffer to stay balanced

    first_cells = [c for c in cells if c[1] == 0]

    # precompute each unit's "people" set (students preferred, else batches)
    def people(u):
        return u["students"] if u["students"] else u["batches"]

    cell_people = {c: set() for c in cells}

    def legal_cells(unit):
        return first_cells if unit["first_slot"] else cells

    # DSATUR-ish: order by (first-slot first, then degree ~ #people, size)
    def order_key(u):
        return (0 if u["first_slot"] else 1, -len(people(u)), -len(u["labels"]))
    ordered = sorted(units, key=order_key)

    unplaced = []
    for unit in ordered:
        pset = people(unit)
        # candidate legal cells with no conflict and within capacity
        candidates = []
        for c in legal_cells(unit):
            if cell_people[c] & pset:
                continue  # would clash
            if papers_per_slot and slot_load(c) + len(unit["labels"]) > cap_limit:
                continue  # keep balanced
            candidates.append(c)
        if candidates:
            # Least-loaded legal cell (balance). Tie-break by the least-loaded
            # SLOT COLUMN so papers spread evenly across the three daily slots
            # instead of piling into the first slot; then by day, then slot.
            def _col_load(s_i):
                return sum(slot_load((d_i, s_i)) for d_i in range(len(dates)))
            target = min(candidates, key=lambda c: (slot_load(c), _col_load(c[1]), c[0], c[1]))
            schedule[target].append(unit)
            cell_people[target] |= pset
        else:
            unplaced.append(unit)

    # Second attempt for any unplaced: relax the capacity buffer but keep the
    # no-clash rule (a clash-free spot is more important than perfect balance).
    if unplaced:
        still = []
        for unit in unplaced:
            pset = people(unit)
            spot = None
            for c in legal_cells(unit):
                if cell_people[c] & pset:
                    continue
                if spot is None or slot_load(c) < slot_load(spot):
                    spot = c
            if spot is not None:
                schedule[spot].append(unit)
                cell_people[spot] |= pset
            else:
                still.append(unit)
        unplaced = still

    # Final fallback (force_fit): place remaining units in the lightest legal
    # cell even if it introduces a clash — keeps the user's window hard. The
    # local-search pass below then tries to repair these.
    if unplaced and force_fit:
        rest = []
        for unit in unplaced:
            legal = legal_cells(unit)
            target = min(legal, key=lambda c: slot_load(c)) if legal else cells[0]
            schedule[target].append(unit)
            cell_people[target] |= people(unit)
        unplaced = rest

    # ── Local-search optimisation (polish) ──────────────────────────────────
    # A light hill-climbing pass to clear any residual clashes the colouring
    # could not place cleanly and to trim soft batch overlaps.
    _optimise_clashes(schedule, cells, slots, papers_per_slot, force_fit)

    return schedule, unplaced


def _enforce_max_per_day(schedule, dates, slots, max_per_day):
    """
    HARD cap: no student sits more than `max_per_day` papers on any one day.
    Moves offending papers to another day that has room and no same-slot clash.
    With max_per_day=2 the two papers are pushed to the FIRST and LAST slots
    (morning + afternoon) so the middle slot stays free — a real gap between them.
    Best-effort: fully guaranteed only when the window has enough days.
    """
    if max_per_day < 1:
        return
    n_days, n_slots = len(dates), len(slots)

    def day_map():
        m = defaultdict(lambda: defaultdict(dict))   # day -> sid -> {id(u): (cell,u)}
        for cell, units in schedule.items():
            d = cell[0]
            for u in units:
                for sid in u["students"]:
                    m[d][sid][id(u)] = (cell, u)
        return m

    for _ in range(4000):
        m = day_map()
        target = None
        for d in range(n_days):
            for sid, uniq in m[d].items():
                if len(uniq) > max_per_day:
                    target = (d, list(uniq.values())); break
            if target:
                break
        if not target:
            break
        d, unit_cells = target
        unit_cells.sort(key=lambda cu: len(cu[1]["students"]))   # move the smallest
        moved = False
        for (cell, u) in unit_cells[max_per_day:]:
            for d2 in range(n_days):
                if d2 == d:
                    continue
                # every student of u must have room on d2
                if any(len(m[d2].get(sid, {})) >= max_per_day for sid in u["students"]):
                    continue
                # prefer first/last slot so a 2-per-day pair straddles the gap
                order = [0, n_slots - 1] + list(range(1, n_slots - 1))
                for s2 in order:
                    c2 = (d2, s2)
                    dst = set()
                    for uu in schedule[c2]:
                        dst |= uu["students"]
                    if u["students"] & dst:
                        continue
                    if u.get("first_slot") and s2 != 0:
                        continue
                    schedule[cell].remove(u)
                    schedule[c2].append(u)
                    moved = True
                    break
                if moved:
                    break
            if moved:
                break
        if not moved:
            break   # window too tight — leave the rest as-is (best effort)


def _gap_violation_count(schedule, slots):
    """
    Weighted count of student-days that break the "gap" rule the exam office wants:
      • THREE or more papers in one day — forbidden outright, weighted heavily so
        the solver never trades a 3-paper day for a couple of adjacent pairs, AND
      • exactly 2 papers that are NOT in the first + last slot (adjacent / using a
        middle slot → no free gap between them) — weighted 1.
    A student with 0–1 papers a day, or 2 papers in slot-0 + slot-last, is fine.
    """
    n_slots = len(slots)
    if n_slots < 2:
        return 0
    first, last = 0, n_slots - 1
    THREE_PLUS_PENALTY = 1000   # a 3-paper day is far worse than any adjacency
    day_stu = defaultdict(lambda: defaultdict(set))   # day -> sid -> {slot_index}
    for (d, s), units in schedule.items():
        for u in units:
            for sid in u["students"]:
                day_stu[d][sid].add(s)
    bad = 0
    for _d, stus in day_stu.items():
        for _sid, sl in stus.items():
            if len(sl) <= 1:
                continue
            if len(sl) >= 3:
                bad += THREE_PLUS_PENALTY
            elif sl != {first, last}:
                bad += 1
    return bad


def _enforce_gap(schedule, dates, slots, max_iter=8):
    """
    Re-seat papers so a student who sits TWO papers on one day has them in the
    FIRST and LAST slot (morning + afternoon, middle slot free = a real gap), and
    nobody sits three papers in a day. Keeps 0 same-slot student clashes.

    Per day the courses form a conflict graph (edge = shared student). Conflicting
    courses are 2-coloured into {first, last}; courses with no same-day conflict
    are spread across the slots (any slot is gap-safe for a 1-paper student).
    Components that cannot be 2-coloured under the gap rule (e.g. a student with 3
    papers → a triangle) have the offending course moved to another day.
    Best-effort: fully guaranteed only when the window has room.
    """
    n_days, n_slots = len(dates), len(slots)
    if n_slots < 2:
        return
    first, last = 0, n_slots - 1
    middles = list(range(1, n_slots - 1))

    def other_day_spot(u, avoid_day):
        """A clash-free (day, slot) on another day; prefer one where u's students
        get no adjacency. Returns None if nothing clash-free exists."""
        fallback = None
        order = [first, last] + middles
        for d2 in range(n_days):
            if d2 == avoid_day:
                continue
            occ = defaultdict(set)   # sid -> slots that student already sits on d2
            for s in range(n_slots):
                for uu in schedule[(d2, s)]:
                    for sid in (u["students"] & uu["students"]):
                        occ[sid].add(s)
            if any(len(v) >= 2 for v in occ.values()):
                continue   # some student would hit 3 papers that day
            for s2 in order:
                if u["first_slot"] and s2 != first:
                    continue
                if any(u["students"] & uu["students"] for uu in schedule[(d2, s2)]):
                    continue   # same-slot clash
                clean = True
                for _sid, os in occ.items():
                    ns = os | {s2}
                    if len(ns) >= 2 and ns != {first, last}:
                        clean = False
                        break
                if clean:
                    return (d2, s2)
                if fallback is None:
                    fallback = (d2, s2)
        return fallback

    def snapshot():
        return {c: list(us) for c, us in schedule.items()}

    def restore(snap):
        for c, us in snap.items():
            schedule[c] = list(us)

    # Track the best (fewest violations) arrangement across rounds and restore it
    # at the end — cross-day eviction can bounce, so this makes the pass monotonic:
    # it never ends worse than it began.
    best_snap = snapshot()
    best_v = _gap_violation_count(schedule, slots)

    for _ in range(max_iter):
        changed = False
        # Phase 1: break up any 3+/day pileups first (move excess papers to a
        # lighter day) so the per-day slotting below only has to gap ≤2 papers.
        _enforce_max_per_day(schedule, dates, slots, 2)
        for d in range(n_days):
            day_units = [u for s in range(n_slots) for u in schedule[(d, s)]]
            if not day_units:
                continue
            # Index-based conflict graph. Keying adjacency by unit INDEX (small
            # ints) rather than id() makes set iteration order deterministic, so
            # the pass gives the same result every run.
            stu2idx = defaultdict(list)
            for i, u in enumerate(day_units):
                for sid in u["students"]:
                    stu2idx[sid].append(i)
            adj = defaultdict(set)
            for _sid, idxs in stu2idx.items():
                for a in range(len(idxs)):
                    for b in range(a + 1, len(idxs)):
                        adj[idxs[a]].add(idxs[b])
                        adj[idxs[b]].add(idxs[a])

            comp_target = {}   # idx -> slot (conflicting courses)
            isolated = []      # idx with no same-day conflict
            evict_idx = []
            visited = set()
            for i in range(len(day_units)):
                if i in visited:
                    continue
                if not adj[i]:
                    visited.add(i)
                    isolated.append(i)
                    continue
                # BFS 2-colour this component
                color = {i: 0}
                visited.add(i)
                queue = [i]
                comp = [i]
                bip = True
                while queue:
                    x = queue.pop()
                    for y in sorted(adj[x]):
                        if y not in color:
                            color[y] = color[x] ^ 1
                            visited.add(y)
                            queue.append(y)
                            comp.append(y)
                        elif color[y] == color[x]:
                            bip = False
                # orient so any first-slot-pinned unit lands on colour 0 (= first)
                if any(day_units[x]["first_slot"] and color[x] == 1 for x in comp) and \
                   not any(day_units[x]["first_slot"] and color[x] == 0 for x in comp):
                    for x in comp:
                        color[x] ^= 1
                pin_conflict = any(day_units[x]["first_slot"] and color[x] == 1 for x in comp)
                if bip and not pin_conflict:
                    for x in comp:
                        comp_target[x] = first if color[x] == 0 else last
                else:
                    # can't satisfy the gap rule for this component in 2 slots →
                    # seat greedily into first/last, evict whatever won't fit.
                    assigned = {}
                    for x in sorted(comp):
                        want = [first] if day_units[x]["first_slot"] else [first, last]
                        placed = False
                        for sl in want:
                            if all(assigned.get(y) != sl for y in adj[x] if y in assigned):
                                assigned[x] = sl
                                placed = True
                                break
                        if not placed:
                            evict_idx.append(x)
                    comp_target.update(assigned)

            # place conflicting units, then spread isolated ones to balance load
            evict_set = set(evict_idx)
            newcells = {s: [] for s in range(n_slots)}
            for idx, sl in comp_target.items():
                if idx in evict_set:
                    continue
                newcells[sl].append(day_units[idx])
            for idx in isolated:
                if day_units[idx]["first_slot"]:
                    newcells[first].append(day_units[idx])
                    continue
                s = min(range(n_slots), key=lambda s: len(newcells[s]))
                newcells[s].append(day_units[idx])
            evict = [day_units[i] for i in evict_idx]

            # safety net: never leave a same-slot student clash
            for s in range(n_slots):
                seen = set()
                keep = []
                for u in newcells[s]:
                    if u["students"] & seen:
                        evict.append(u)
                    else:
                        seen |= u["students"]
                        keep.append(u)
                newcells[s] = keep
            for s in range(n_slots):
                schedule[(d, s)] = newcells[s]

            for u in evict:
                spot = other_day_spot(u, d)
                if spot is None:
                    # nowhere clash-free elsewhere → least-full clash-free slot today
                    cand = [s for s in range(n_slots)
                            if not any(u["students"] & uu["students"] for uu in schedule[(d, s)])
                            and not (u["first_slot"] and s != first)]
                    spot = (d, min(cand, key=lambda s: len(schedule[(d, s)]))) if cand else (d, first)
                schedule[spot].append(u)
                changed = True
        v = _gap_violation_count(schedule, slots)
        if v < best_v:
            best_v = v
            best_snap = snapshot()
        if not changed:
            break

    restore(best_snap)


def _schedule_masked(units, dates, slots, seed=None):
    """
    Validity-aware placement for the per-day COLUMN mask (BTech): each unit is
    put in a valid (day, slot) cell — weekdays may only use their allowed slot(s),
    weekends theirs — with no same-slot student/batch clash, spread across days so
    a student's papers don't pile on one day. Every column exists (empty ones stay
    blank in the render). Simple and deterministic; the masked set is small.
    """
    n_slots = len(slots)
    valid = [(d, s) for d in range(len(dates)) for s in _day_slots(dates, d, n_slots)]
    schedule = {(d, s): [] for d in range(len(dates)) for s in range(n_slots)}
    cell_people = {c: set() for c in schedule}

    def people(u):
        return u["students"] if u["students"] else u["batches"]

    if seed is None:
        ordered = sorted(units, key=lambda u: (0 if u["first_slot"] else 1, -len(people(u)), -len(u["labels"])))
    else:
        # randomised order (first-slot units still first) so restarts explore
        # different day placements — helps escape a bad greedy layout.
        rnd = random.Random(seed)
        shuffled = units[:]
        rnd.shuffle(shuffled)
        ordered = sorted(shuffled, key=lambda u: 0 if u["first_slot"] else 1)
    day_load = defaultdict(lambda: defaultdict(int))   # day -> sid -> papers that day
    for u in ordered:
        pset = people(u)
        # NOTE: the "first slot" (CE/PD morning) preference is NOT applied under the
        # per-day mask — BTech's columns are already fixed by the mask and weekdays
        # have a single slot, so pinning to the earliest slot only starves the grid
        # and forces clashes. Every valid cell is fair game here.
        legal = valid
        best, best_key = None, None
        for (d, s) in legal:
            if cell_people[(d, s)] & pset:
                continue                                # same-slot clash → skip
            sameday = max((day_load[d][sid] for sid in u["students"]), default=0)
            key = (sameday, len(schedule[(d, s)]), d, s)   # spread days, then balance
            if best is None or key < best_key:
                best, best_key = (d, s), key
        if best is None:                                # no clash-free cell (rare) → least-loaded
            best = min(legal or valid, key=lambda c: len(schedule[c]))
        schedule[best].append(u)
        cell_people[best] |= pset
        for sid in u["students"]:
            day_load[best[0]][sid] += 1
    return schedule, []


def _valid_cells(dates, slots):
    """Every (day, slot) a paper may occupy: respects the per-day SLOT_MASK (BTech)
    and blocked windows (Friday Jumma). This is the ground truth used by the CP-SAT
    optimiser and by blocked-cell cleanup."""
    n = len(slots)
    return [(d, s) for d in range(len(dates)) for s in _day_slots(dates, d, n, slots)]


def schedule_units_cpsat(units, dates, slots, cap_per_cell=None, max_per_day=2,
                         time_limit_s=180, hint_schedule=None, cohort="bs",
                         same_day_groups=None, soft_capacity=False, soft_max_per_day=False):
    """
    OPTIMAL slot assignment via OR-Tools CP-SAT. Returns a schedule dict
    {(d_i, s_i): [units]} that:
      HARD: every unit in exactly one valid cell; no student two papers in one cell;
            no student > max_per_day papers per day; per-cell seat capacity honoured;
            no cell inside a blocked window / disallowed by SLOT_MASK.
      OBJECTIVE (weighted, most-important first): (1) fewest student-days with 2
            papers, (2) fewest back-to-back (<=30 min gap) pairs, (3) balanced
            per-slot load. Students with an identical course set are grouped and
            weighted by count so the model stays small.
    Raises if OR-Tools is unavailable or no feasible/So-far solution is found; the
    caller then falls back to the greedy scheduler.
    """
    from ortools.sat.python import cp_model

    cells = _valid_cells(dates, slots)
    if not cells:
        raise RuntimeError("no valid cells (all blocked/masked)")
    n_units = len(units)

    # student -> unit indices; then group students by identical unit-set.
    stu_units = defaultdict(set)
    for ui, u in enumerate(units):
        for sid in u["students"]:
            stu_units[sid].add(ui)
    groups = defaultdict(int)                     # frozenset(unit idx) -> #students
    for uis in stu_units.values():
        if uis:
            groups[frozenset(uis)] += 1
    # conflict pairs: units that share ≥1 student (can't be in the same cell)
    conflict = set()
    for gset in groups:
        gl = sorted(gset)
        for i in range(len(gl)):
            for j in range(i + 1, len(gl)):
                conflict.add((gl[i], gl[j]))

    model = cp_model.CpModel()
    x = {(ui, c): model.NewBoolVar(f"x_{ui}_{c[0]}_{c[1]}") for ui in range(n_units) for c in cells}
    for ui in range(n_units):
        model.Add(sum(x[(ui, c)] for c in cells) == 1)
    # HARD — SACRED: conflicting units (share a student) never share a cell. This is
    # the one constraint we never relax: no student ever sits two papers in the same
    # slot. Everything below (seat capacity, ≤max/day, same-day grouping) yields to it
    # via the caller's relaxation cascade, so a feasible 0-same-slot-clash datesheet
    # is always produced for a feasible window.
    for (a, b) in conflict:
        for c in cells:
            model.Add(x[(a, c)] + x[(b, c)] <= 1)

    total_students = sum(len(u["students"]) for u in units)
    # Per-cell seat capacity. HARD by default; when soft_capacity (a relaxation step),
    # overflow above capacity is allowed but penalised heavily in the objective.
    cap_pen = []
    if cap_per_cell and cap_per_cell > 0:
        for c in cells:
            load_c = sum(len(units[ui]["students"]) * x[(ui, c)] for ui in range(n_units))
            if soft_capacity:
                ov = model.NewIntVar(0, total_students or 1, f"capov_{c[0]}_{c[1]}")
                model.Add(load_c - cap_per_cell <= ov)
                cap_pen.append(ov)
            else:
                model.Add(load_c <= cap_per_cell)

    days = sorted({c[0] for c in cells})
    cells_by_day = {d: [c for c in cells if c[0] == d] for d in days}
    # slots available on the busiest day — a same-day group with MORE members than
    # this can never fit in one day's distinct slots (e.g. the 3 English papers vs
    # only 2 FINALS slots/day), so forcing it same-day would make the model infeasible.
    slots_per_day = max((len(cells_by_day[d]) for d in days), default=0)

    # SAME-DAY GROUPS (hard): e.g. English-I/II/III must sit on ONE day (in different
    # slots). For each group, its member papers present here are forced onto a single
    # shared day. Members not in this datesheet are simply skipped.
    def _unit_codes(u):
        cs = u.get("codes") or ([u.get("code")] if u.get("code") else [])
        return {str(c).upper() for c in cs}
    for gi, grp in enumerate(same_day_groups or []):
        want = {str(c).upper() for c in grp}
        mem = [ui for ui in range(n_units) if _unit_codes(units[ui]) & want]
        if len(mem) < 2:
            continue
        if len(mem) > slots_per_day:
            # More members than a day has slots (e.g. 3 English papers, 2 FINALS
            # slots/day). Same-day is physically impossible here — drop the
            # preference rather than make the whole datesheet infeasible. The papers
            # are still scheduled clash-free, just not guaranteed on one day.
            continue
        gday = {d: model.NewBoolVar(f"sdg_{gi}_{d}") for d in days}
        model.Add(sum(gday.values()) == 1)
        for ui in mem:
            for d in days:
                model.Add(sum(x[(ui, c)] for c in cells_by_day[d]) == gday[d])
        # …and in DIFFERENT slots of that day (English-I/II/III → 3 separate slots,
        # same day): at most one group member per cell.
        for c in cells:
            model.Add(sum(x[(ui, c)] for ui in mem) <= 1)

    # adjacency: slot index pairs on the same day whose time gap ≤ 30 min (back-to-back)
    def _adj_pairs(d):
        pairs = []
        dc = cells_by_day[d]
        for i in range(len(dc)):
            for j in range(i + 1, len(dc)):
                a = _slot_time_span(_slot_label(dates[d], dc[i][1], slots))
                b = _slot_time_span(_slot_label(dates[d], dc[j][1], slots))
                if a and b:
                    lo, hi = (a, b) if a[0] <= b[0] else (b, a)
                    if lo[1] <= hi[0] and hi[0] - lo[1] <= 30:
                        pairs.append((dc[i], dc[j]))
        return pairs

    two_terms, b2b_terms, mpd_pen = [], [], []
    gi = 0
    for gset, w in groups.items():
        gl = list(gset)
        for d in days:
            dc = cells_by_day[d]
            cnt = sum(x[(ui, c)] for ui in gl for c in dc)
            if soft_max_per_day:
                # relaxation step: allow >max/day but penalise the overflow heavily,
                # so the solver only ever uses it when nothing else fits the window.
                ov = model.NewIntVar(0, len(gl), f"mpdov_{gi}_{d}")
                model.Add(cnt - max_per_day <= ov)
                mpd_pen.append(w * ov)
            else:
                model.Add(cnt <= max_per_day)
            # two[g,d] = 1 when this group sits 2 papers that day
            tv = model.NewBoolVar(f"two_{gi}_{d}")
            model.Add(cnt <= 1 + tv)
            two_terms.append(w * tv)
            # back-to-back: both cells of an adjacent pair used
            for (c1, c2) in _adj_pairs(d):
                u1 = sum(x[(ui, c1)] for ui in gl)
                u2 = sum(x[(ui, c2)] for ui in gl)
                bb = model.NewBoolVar(f"b2b_{gi}_{d}_{c1[1]}_{c2[1]}")
                model.Add(u1 + u2 - 1 <= bb)
                b2b_terms.append(w * bb)
        gi += 1

    # load balance: minimise the busiest cell's enrolment
    loads = {c: sum(len(units[ui]["students"]) * x[(ui, c)] for ui in range(n_units)) for c in cells}
    maxload = model.NewIntVar(0, total_students or 1, "maxload")
    for c in cells:
        model.Add(loads[c] <= maxload)

    # Objective, strict priority (highest weight first):
    #   • capacity overflow (1e9) and >max/day overflow (1e8) — only non-zero in a
    #     relaxation step; weighted so huge the solver avoids them unless forced,
    #     yet it still returns a 0-same-slot-clash layout when they can't be met.
    #   • 2-per-day (1000): the solver never trades a 2-per-day to save back-to-backs.
    #   • back-to-back (200), then a light load term (2) for an even per-slot spread.
    model.Minimize(
        1_000_000_000 * sum(cap_pen)
        + 100_000_000 * sum(mpd_pen)
        + 1000 * sum(two_terms)
        + 200 * sum(b2b_terms)
        + 2 * maxload
    )

    # warm-start from the greedy schedule (helps the solver a lot)
    if hint_schedule:
        idmap = {id(units[ui]): ui for ui in range(n_units)}
        for c, us in hint_schedule.items():
            for u in us:
                ui = idmap.get(id(u))
                if ui is not None and (ui, c) in x:
                    model.AddHint(x[(ui, c)], 1)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(time_limit_s)
    solver.parameters.num_search_workers = 8
    solver.parameters.relative_gap_limit = 0.0
    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        raise RuntimeError(f"CP-SAT no solution (status={solver.StatusName(status)})")

    schedule = {(d, s): [] for d in range(len(dates)) for s in range(len(slots))}
    for ui in range(n_units):
        for c in cells:
            if solver.Value(x[(ui, c)]):
                schedule[c].append(units[ui])
                break
    lb = solver.BestObjectiveBound()
    obj = solver.ObjectiveValue()
    print(f"[cpsat] cohort={cohort} status={solver.StatusName(status)} "
          f"obj={obj:.0f} bound={lb:.0f} cells={len(cells)} units={n_units} "
          f"groups={len(groups)} time={solver.WallTime():.1f}s", file=sys.stderr)
    return schedule


def _reduce_back_to_back(schedule, dates, slots, cap_per_cell=None, rounds=8):
    """Local-search polish (ITC-2007 style) run AFTER CP-SAT: move a paper out of a
    back-to-back adjacency (two papers <=30 min apart the same day for a shared
    student) to a valid clash-free cell — reducing the back-to-back count while
    NEVER breaking a hard constraint (no student twice in a cell, <=2 papers/day,
    per-cell seat capacity, valid/mask/blocked cell). Every move is re-verified, so
    the CP-SAT solution's 0 same-slot clashes are preserved."""
    cells = _valid_cells(dates, slots)
    cspan = {c: _slot_time_span(_slot_label(dates[c[0]], c[1], slots)) for c in cells}

    def adj(c1, c2):
        if c1[0] != c2[0]:
            return False
        a, b = cspan.get(c1), cspan.get(c2)
        if not a or not b:
            return False
        lo, hi = (a, b) if a[0] <= b[0] else (b, a)
        return lo[1] <= hi[0] and (hi[0] - lo[1]) <= 30

    stu = defaultdict(set)                 # sid -> set of cells occupied
    unit_cell = {}                         # id(unit) -> cell
    for c, us in schedule.items():
        for u in us:
            unit_cell[id(u)] = c
            for sid in u["students"]:
                stu[sid].add(c)

    def cell_load(c):
        return sum(len(u["students"]) for u in schedule[c])

    def b2b(u, cell, exclude):
        n = 0
        for sid in u["students"]:
            for c2 in stu[sid]:
                if c2 != exclude and adj(cell, c2):
                    n += 1
        return n

    def day_count(sid, day, frm):
        # papers sid sits on `day`, EXCLUDING the unit currently at `frm` (being moved)
        return sum(1 for c2 in stu[sid] if c2 != frm and c2[0] == day)

    def can_place(u, cell, frm):
        for uu in schedule[cell]:
            if uu is not u and (u["students"] & uu["students"]):
                return False                       # same-slot student clash
        if day_count_all_over(u, cell, frm):
            return False                           # would give some student >2 that day
        if cap_per_cell and (cell_load(cell) + len(u["students"])) > cap_per_cell:
            return False
        return True

    def day_count_all_over(u, cell, frm):
        day = cell[0]
        for sid in u["students"]:
            if day_count(sid, day, frm) + 1 > 2:
                return True
        return False

    def two_delta(u, frm, to):
        # change in the number of (student, day)-with-2-papers if u moves frm→to.
        # A same-day move never changes it; a cross-day move must NOT increase it
        # (protecting the 2-per-day objective while we cut back-to-back).
        if frm[0] == to[0]:
            return 0
        d = 0
        for sid in u["students"]:
            a = day_count(sid, frm[0], frm)        # sid's other papers on the old day
            b = day_count(sid, to[0], frm)         # sid's other papers on the new day
            before = (1 if a + 1 == 2 else 0) + (1 if b == 2 else 0)
            after = (1 if a == 2 else 0) + (1 if b + 1 == 2 else 0)
            d += after - before
        return d

    moved = 0
    for _ in range(rounds):
        improved = False
        for c in list(schedule.keys()):
            for u in list(schedule.get(c, [])):
                if u.get("fixed") or not u["students"]:
                    continue
                cur = b2b(u, c, c)
                if cur == 0:
                    continue
                best, best_b = None, cur
                for tc in cells:
                    if tc == c or not can_place(u, tc, c):
                        continue
                    if two_delta(u, c, tc) > 0:
                        continue                    # never trade a 2-per-day for a back-to-back
                    nb = b2b(u, tc, c)
                    if nb < best_b:
                        best, best_b = tc, nb
                if best is not None:
                    schedule[c].remove(u)
                    schedule[best].append(u)
                    for sid in u["students"]:
                        stu[sid].discard(c)
                        stu[sid].add(best)
                    unit_cell[id(u)] = best
                    moved += 1
                    improved = True
        if not improved:
            break
    if moved:
        print(f"[polish] back-to-back local search moved {moved} paper(s)", file=sys.stderr)
    return schedule


def schedule_units(units, dates, slots, papers_per_slot=None, seed=42,
                   force_fit=False, restarts=3, max_per_day=1):
    """
    Run several independent placement attempts with different random seeds and
    keep the best. Priority: (1) zero same-slot student clashes, (2) fewest
    same-day pairs, (3) fewest batch overlaps. Random restarts help the local
    search escape bad optima; a guaranteed repair pass fixes any residual
    same-slot clash; a final same-day pass spreads each student's papers across
    days as much as the window allows.
    """
    # Per-day column mask (BTech): use the dedicated validity-aware placer so no
    # paper lands in a slot that day isn't allowed to use. Try several randomised
    # orderings + a mask-aware clash repair and keep the one with the FEWEST
    # student clashes (BTech weekdays have only ONE slot, so a good spread across
    # DAYS is what avoids clashes).
    if SLOT_MASK:
        best, best_c = None, None
        # BTech is small — afford many restarts to find a clash-free day spread.
        # The swap-aware repair (below) usually reaches 0 quickly; extra restarts
        # are cheap insurance for a tight packing (max papers/student ≈ slots).
        n_try = max(restarts, 400)
        for i in range(n_try):
            sched, _ = _schedule_masked(units, dates, slots, seed=(seed + i * 101) if i else None)
            _repair_internal_masked(sched, dates, slots)
            c = _slot_clash_count(sched)
            if best_c is None or c < best_c:
                best, best_c = sched, c
            if c == 0:
                break
        return best, []

    cells = [(d_i, s_i) for d_i in range(len(dates)) for s_i in range(len(slots))]

    best_schedule = None
    best_unplaced = None
    best_score = None
    for i in range(max(1, restarts)):
        sched, unplaced = _schedule_once(
            units, dates, slots, papers_per_slot, seed + i * 101, force_fit)
        _final_repair(sched, dates, slots)          # guarantee: 0 same-slot clashes
        _reduce_same_day(sched, cells, slots, papers_per_slot, force_fit)  # spread days
        # Balance the load across slots FIRST, so the day/gap enforcement below
        # is the final word (the balancer used to run last and re-fill the middle
        # slot, undoing the gap). Balancing only swaps cells, never adds clashes.
        _balance_load_target = max(1, math.ceil(sum(len(u["labels"]) for u in units) / max(1, len(cells))))
        _balance_slots(sched, cells, _balance_load_target)
        _final_repair(sched, dates, slots)          # re-verify 0 clashes after balancing
        # FINAL slotting (runs LAST): break up 3+/day pileups, then seat every
        # student's two same-day papers in the first + last slot (free middle =
        # a real gap). Always on — 1-paper/day is infeasible in a tight window,
        # so residual 2-paper days should still be gapped and never become 3.
        _enforce_gap(sched, dates, slots, max_iter=20)
        _final_repair(sched, dates, slots)          # keep 0 same-slot clashes sacred
        score = (_slot_clash_count(sched), _gap_violation_count(sched, slots),
                 _same_day_pairs(sched), _weighted_clash_total(sched), len(unplaced))
        if best_score is None or score < best_score:
            best_score = score
            best_schedule = sched
            best_unplaced = unplaced
    return best_schedule, best_unplaced


def _repair_internal_masked(schedule, dates, slots, max_iter=300):
    """
    Mask-aware STUDENT-clash repair (for the BTech per-day column mask, where the
    generic _final_repair can't be used because it ignores the mask). Moves any
    unit that shares a student with another unit in the SAME cell to a valid
    (mask-respecting) cell with no student overlap. PINNED gen-ed units (fixed)
    are never moved. Returns the number of moves.
    """
    n_slots = len(slots)
    valid = [(d, s) for d in range(len(dates)) for s in _day_slots(dates, d, n_slots)]
    firsts = {}
    for (d, s) in valid:
        if d not in firsts or s < firsts[d]:
            firsts[d] = s

    def clash_in(cell, u):
        for uu in schedule.get(cell, []):
            if uu is u:
                continue
            if u["students"] & uu["students"]:
                return True
        return False

    def clash_in_excluding(cell, u, exclude):
        # would u clash in `cell` if unit `exclude` were removed from it?
        for uu in schedule.get(cell, []):
            if uu is u or uu is exclude:
                continue
            if u["students"] & uu["students"]:
                return True
        return False

    moves = 0
    for _ in range(max_iter):
        changed = False
        for cell in list(schedule.keys()):
            for u in list(schedule.get(cell, [])):
                if u.get("fixed"):
                    continue                       # never move a pinned gen-ed paper
                if not clash_in(cell, u):
                    continue
                # (a) simplest: move to a valid clash-free cell (fewest units).
                cand = [c for c in valid if c != cell and not clash_in(c, u)]
                if cand:
                    target = min(cand, key=lambda c: len(schedule.get(c, [])))
                    schedule[cell].remove(u)
                    schedule.setdefault(target, []).append(u)
                    moves += 1
                    changed = True
                    continue
                # (b) no empty clash-free cell (BTech weekdays have ONE slot, so
                #     cells fill up): try a SWAP — find a movable unit v in another
                #     valid cell such that u fits v's cell and v fits u's cell, both
                #     clash-free. This breaks local optima a pure move can't.
                swapped = False
                for c2 in valid:
                    if c2 == cell:
                        continue
                    for v in list(schedule.get(c2, [])):
                        if v is u or v.get("fixed"):
                            continue
                        # u into c2 (without v) and v into cell (without u), both clean
                        if clash_in_excluding(c2, u, v):
                            continue
                        if clash_in_excluding(cell, v, u):
                            continue
                        schedule[cell].remove(u)
                        schedule[c2].remove(v)
                        schedule.setdefault(c2, []).append(u)
                        schedule.setdefault(cell, []).append(v)
                        moves += 1
                        changed = True
                        swapped = True
                        break
                    if swapped:
                        break
        if not changed:
            break
    return moves


def _merge_fixed_courses(schedule, dates, slots, fixed):
    """
    Add SHARED gen-ed papers to a cohort's datesheet at a FIXED (date, slot) that
    another datesheet already set — so e.g. SS121 (Fahm-ul-Quran) appears on the
    MS AND B.Tech datesheets at the SAME time it has on the BS sheet (one paper,
    one time → no leak). The grid is extended with any new date/slot the fixed
    papers need, existing cells are re-indexed, and each fixed paper is placed at
    its cell. Returns (schedule, dates, slots).
      fixed : [ { code, name, date:'YYYY-MM-DD', slot:'label', students:[sid,...] } ]
    """
    if not fixed:
        return schedule, dates, slots
    date_strs = [d.strftime("%Y-%m-%d") for d in dates]
    # union of dates (chronological) and slots (existing first, new appended)
    all_dates = sorted(set(date_strs) | {f["date"] for f in fixed if f.get("date")})
    new_dates = [datetime.strptime(s, "%Y-%m-%d") for s in all_dates]
    d_index = {s: i for i, s in enumerate(all_dates)}
    new_slots = list(slots)
    for f in fixed:
        lab = f.get("slot")
        if lab and lab not in new_slots:
            new_slots.append(lab)
    # keep slot COLUMNS in chronological order (exam clock: 1–7 = afternoon), so a
    # newly-added time like 11:00 doesn't land after 03:00.
    def _slot_start_min(lab):
        m = re.match(r'\s*(\d{1,2}):(\d{2})', str(lab or ''))
        if not m:
            return 9999
        h, mm = int(m.group(1)), int(m.group(2))
        if h < 8:
            h += 12
        return h * 60 + mm
    new_slots.sort(key=_slot_start_min)
    s_index = {lab: i for i, lab in enumerate(new_slots)}

    # re-index the existing schedule onto the extended grid
    new_sched = defaultdict(list)
    for (d_i, s_i), units in schedule.items():
        if d_i < len(date_strs) and s_i < len(slots):
            new_sched[(d_index[date_strs[d_i]], s_index[slots[s_i]])].extend(units)

    # place each fixed paper (one unit per code, de-duplicated)
    seen = set()
    for f in fixed:
        code = str(f.get("code") or "").strip()
        if not code or not f.get("date") or not f.get("slot"):
            continue
        if code in seen:
            continue
        seen.add(code)
        cell = (d_index[f["date"]], s_index[f["slot"]])
        new_sched[cell].append({
            "codes": [code], "names": [f.get("name") or code], "labels": [code],
            "batches": set(), "students": set(str(x) for x in (f.get("students") or [])),
            "first_slot": False, "fixed": True,
        })
    return dict(new_sched), new_dates, new_slots


def _repair_external_clashes(schedule, dates, slots, ext_by_student, max_iter=200):
    """
    CROSS-COHORT clash repair. `ext_by_student` maps sid -> set of (d_i, s_i) cells
    the student is ALREADY committed to in ANOTHER datesheet (e.g. a B.Tech student
    sitting a shared gen-ed BS paper). Any unit placed in such a committed cell is
    MOVED to a valid cell that has no external AND no internal clash — so a
    B.Tech-exclusive paper (e.g. CET311) is auto-shifted off the slot where its
    students already sit SS121. Respects the per-day column mask (BTech). Shared
    gen-ed courses themselves are not in this datesheet, so they never move.
    Returns the number of units moved.
    """
    n_slots = len(slots)
    if SLOT_MASK:
        valid = [(d, s) for d in range(len(dates)) for s in _day_slots(dates, d, n_slots)]
    else:
        valid = [(d, s) for d in range(len(dates)) for s in range(n_slots)]
    firsts_by_day = {}
    for (d, s) in valid:
        if d not in firsts_by_day or s < firsts_by_day[d]:
            firsts_by_day[d] = s

    def ext_hit(u, cell):
        for sid in u["students"]:
            cells = ext_by_student.get(sid)
            if cells and cell in cells:
                return True
        return False

    def internal_clash(u, cell, exclude=None):
        for uu in schedule.get(cell, []):
            if uu is exclude:
                continue
            if u["students"] & uu["students"]:
                return True
        return False

    def candidates(u, cell, respect_first):
        out = []
        for c in valid:
            if c == cell:
                continue
            if respect_first and u.get("first_slot") and c[1] != firsts_by_day.get(c[0]):
                continue
            if ext_hit(u, c) or internal_clash(u, c):
                continue
            out.append(c)
        return out

    moves = 0
    for _ in range(max_iter):
        changed = False
        for cell in list(schedule.keys()):
            for u in list(schedule.get(cell, [])):
                if not ext_hit(u, cell):
                    continue
                # Prefer keeping a first-slot course in a first slot, but avoiding
                # the clash matters more — fall back to ANY valid clash-free cell.
                cand = candidates(u, cell, True) or candidates(u, cell, False)
                if not cand:
                    continue
                target = min(cand, key=lambda c: len(schedule.get(c, [])))
                schedule[cell].remove(u)
                schedule.setdefault(target, []).append(u)
                moves += 1
                changed = True
        if not changed:
            break
    return moves


def _final_repair(schedule, dates, slots):
    """
    Guaranteed student-clash repair. For every cell, if a unit shares a student
    with another unit in the same cell, move it to the first cell (respecting
    the first-slot rule) that has no student overlap with it. Repeated until no
    improving move exists. This drives student clashes to zero whenever the grid
    has enough slots (which graph-colouring guarantees it does for a feasible
    window).
    """
    cells = sorted(schedule.keys())

    def cell_students(cell, exclude=None):
        s = set()
        for u in schedule[cell]:
            if u is exclude:
                continue
            s |= u["students"]
        return s

    for _ in range(2000):  # generous cap; converges long before this
        moved = False
        for cell in cells:
            here = schedule[cell]
            # detect a clashing unit in this cell
            seen = {}
            clashing_unit = None
            for u in here:
                bad = any(s in seen for s in u["students"])
                if bad:
                    clashing_unit = u
                    break
                for s in u["students"]:
                    seen[s] = u
            if clashing_unit is None:
                continue
            # find a destination cell with no student overlap. Capacity is
            # ignored here on purpose: eliminating a real student clash matters
            # more than perfect slot balance, and the balance pass already ran.
            cu = clashing_unit
            dest = None
            for target in cells:
                if target == cell:
                    continue
                if cu["first_slot"] and target[1] != 0:
                    continue
                if cu["students"] & cell_students(target):
                    continue
                dest = target
                break
            if dest is not None:
                schedule[cell].remove(cu)
                schedule[dest].append(cu)
                moved = True
            else:
                # No clash-free cell exists for cu as-is. Try a SWAP: find a unit
                # `other` in another cell such that swapping cu <-> other leaves
                # BOTH cells clash-free for the swapped units. This resolves the
                # tight cases a plain move cannot.
                if _repair_by_swap(schedule, cells, cell, cu, cell_students):
                    moved = True
        if not moved:
            break


def _repair_by_swap(schedule, cells, cur_cell, cu, cell_students_fn):
    """Try to swap `cu` with some unit in another cell so both land clash-free."""
    cur_others = cell_students_fn(cur_cell, exclude=cu)
    for target in cells:
        if target == cur_cell:
            continue
        if cu["first_slot"] and target[1] != 0:
            continue
        for other in list(schedule[target]):
            if other["first_slot"] and cur_cell[1] != 0:
                continue
            # students in target excluding `other`
            tgt_others = set()
            for u in schedule[target]:
                if u is other:
                    continue
                tgt_others |= u["students"]
            # cu must be clash-free in target (minus other); other clash-free in cur (minus cu)
            if cu["students"] & tgt_others:
                continue
            if other["students"] & cur_others:
                continue
            # perform the swap
            schedule[cur_cell].remove(cu)
            schedule[target].remove(other)
            schedule[cur_cell].append(other)
            schedule[target].append(cu)
            return True
    return False


def _slot_clash_count(schedule):
    """Total STUDENT collisions across the schedule (the hard constraint)."""
    total = 0
    for cell_units in schedule.values():
        seen = set()
        for u in cell_units:
            for s in u["students"]:
                if s in seen:
                    total += 1
                else:
                    seen.add(s)
    return total


def _weighted_clash_total(schedule):
    """
    Combined objective the optimiser minimises, in strict priority order:

      1. STUDENT SAME-SLOT clashes  (weight 1,000,000) — HARD. A student sitting
         two papers at the exact same time. Must be driven to zero.
      2. STUDENT SAME-DAY pairs     (weight 100)       — SOFT. A student with two
         papers on the same day (but different slots). Allowed as a last resort,
         so we minimise it: ideally one paper per day per student.
      3. BATCH overlaps             (weight 1)         — cosmetic only.

    The huge weight gap guarantees the optimiser never trades a same-slot clash
    for fewer same-day pairs, and never trades a same-day pair for fewer batch
    overlaps.
    """
    SLOT_W = 1_000_000
    DAY_W = 100
    BATCH_W = 1

    # cell key is (day_index, slot_index)
    # ---- same-slot student clashes + batch overlaps (per cell) ----
    student_slot = 0
    batch_total = 0
    for cell_units in schedule.values():
        seen_s = set()
        seen_b = set()
        for u in cell_units:
            for s in u["students"]:
                if s in seen_s:
                    student_slot += 1
                else:
                    seen_s.add(s)
            for b in u["batches"]:
                if b in seen_b:
                    batch_total += 1
                else:
                    seen_b.add(b)

    # ---- same-day pairs (a student with 2+ papers on one day) ----
    same_day = _same_day_pairs(schedule)

    return student_slot * SLOT_W + same_day * DAY_W + batch_total * BATCH_W


def _same_day_pairs(schedule):
    """
    Count, across all students, how many extra papers fall on a day where the
    student already has one. A student with k papers on a single day contributes
    (k - 1). Same-slot collisions are also same-day, but those are penalised far
    more heavily by the slot term, so this stays a pure 'spread across days'
    signal. Lower is better (0 = every student has at most one paper per day).
    """
    # student -> {day_index: count}
    per_student_day = defaultdict(lambda: defaultdict(int))
    for (d_i, _s_i), cell_units in schedule.items():
        for u in cell_units:
            for s in u["students"]:
                per_student_day[s][d_i] += 1
    total = 0
    for day_counts in per_student_day.values():
        for cnt in day_counts.values():
            if cnt > 1:
                total += cnt - 1
    return total


def _unit_clashes_in_cell(unit, cell_units, exclude=None):
    """
    Weighted clash cost of placing `unit` in a cell.

    Student collisions (a real student sitting two papers at once) are the hard
    constraint — weighted very high. Batch overlaps (same batch label, usually
    different students) are a soft, secondary objective — weighted low so the
    optimiser also thins them out once all student clashes are gone.
    """
    STUDENT_W = 1000
    BATCH_W = 1

    others_students = set()
    n_batch = 0
    for other in cell_units:
        if other is exclude or other is unit:
            continue
        others_students |= other["students"]
        if unit["batches"] & other["batches"]:
            n_batch += 1

    if unit["students"]:
        n_student = len(unit["students"] & others_students)
    else:
        # no roster available — treat batch overlap as the student proxy
        n_student = n_batch
        n_batch = 0

    return n_student * STUDENT_W + n_batch * BATCH_W


def _optimise_clashes(schedule, cells, slots, papers_per_slot, force_fit, max_passes=200):
    """
    Hill-climbing: repeatedly take the unit contributing the most same-slot
    clashes and move it to the cell where it would add the fewest, respecting
    the first-slot rule and (when not force_fit) the capacity cap.
    Stops when clash-free or no improving move remains.
    """
    def cell_load(cell):
        return sum(len(u["labels"]) for u in schedule[cell])

    stall = 0
    for _ in range(max_passes):
        # find the worst offending (unit, cell)
        worst = None  # (clashes, cell, unit)
        for cell, units_here in schedule.items():
            for u in units_here:
                c = _unit_clashes_in_cell(u, units_here)
                if c > 0 and (worst is None or c > worst[0]):
                    worst = (c, cell, u)
        if worst is None:
            return  # clash-free
        cur_clashes, cur_cell, unit = worst

        # find the best destination cell (fewest added clashes)
        best_cell = None
        best_added = cur_clashes  # must strictly improve
        for cell in cells:
            if cell == cur_cell:
                continue
            d_i, s_i = cell
            if unit["first_slot"] and s_i != 0:
                continue
            if papers_per_slot and not force_fit:
                if cell_load(cell) + len(unit["labels"]) > papers_per_slot:
                    continue
            added = _unit_clashes_in_cell(unit, schedule[cell])
            if added < best_added:
                best_added = added
                best_cell = cell

        if best_cell is not None:
            schedule[cur_cell].remove(unit)
            schedule[best_cell].append(unit)
            stall = 0
        else:
            # no strictly-improving move for the worst unit; try a swap instead
            if _try_swap(schedule, cells, slots, unit, cur_cell, papers_per_slot, force_fit):
                stall = 0
            else:
                stall += 1
                # After a few stalls, nudge: move the worst unit sideways to the
                # least-clashing cell even if equal, to escape the local optimum.
                if stall >= 2:
                    alt = None
                    alt_added = None
                    for cell in cells:
                        if cell == cur_cell:
                            continue
                        d_i, s_i = cell
                        if unit["first_slot"] and s_i != 0:
                            continue
                        if papers_per_slot and not force_fit:
                            if cell_load(cell) + len(unit["labels"]) > papers_per_slot:
                                continue
                        added = _unit_clashes_in_cell(unit, schedule[cell])
                        if alt_added is None or added < alt_added:
                            alt_added = added
                            alt = cell
                    if alt is not None and alt_added <= cur_clashes:
                        schedule[cur_cell].remove(unit)
                        schedule[alt].append(unit)
                        stall = 0
                    else:
                        return  # genuinely stuck (window too tight)


def _balance_slots(schedule, cells, target, max_passes=4000):
    """
    Even out the paper load across all cells (day × slot) so no single slot is
    overloaded while others sit light — the load-balancing the user asked for.

    Repeatedly moves a NON-first-slot unit out of the most-loaded cell into an
    under-target cell that shares no student with it (so a move never creates a
    clash). First-slot (CE/PD) units are pinned to slot 0 and never moved, so
    the columns balance AROUND them. `target` is the ideal papers-per-cell
    (≈ ceil(total / cells)); we stop once the spread is within one paper.
    """
    def load(c):
        return sum(len(u["labels"]) for u in schedule[c])

    def students(c, exclude=None):
        s = set()
        for u in schedule[c]:
            if u is not exclude:
                s |= u["students"]
        return s

    for _ in range(max_passes):
        loads = {c: load(c) for c in cells}
        over = max(cells, key=lambda c: loads[c])
        under = min(cells, key=lambda c: loads[c])
        if loads[over] - loads[under] <= 1:
            break  # already balanced

        # destination cells that are still below target, lightest first
        dests = sorted((c for c in cells if loads[c] < target and c != over),
                       key=lambda c: loads[c])
        moved = False
        # try to relocate a movable (non-pinned) unit from the heaviest cell
        for u in sorted(schedule[over], key=lambda u: -len(u["labels"])):
            if u["first_slot"]:
                continue                      # must stay in slot 0
            for dest in dests:
                if u["students"] & students(dest):
                    continue                  # would clash
                schedule[over].remove(u)
                schedule[dest].append(u)
                moved = True
                break
            if moved:
                break
        if not moved:
            break  # nothing can be relocated clash-free — genuine constraint limit


def _reduce_same_day(schedule, cells, slots, papers_per_slot, force_fit, max_passes=400):
    """
    Second-stage optimiser (runs AFTER same-slot clashes are zero).

    Goal: give each student at most one paper per day. Since 6 days is usually
    too tight to reach zero same-day, we minimise it: repeatedly find the unit
    whose move most reduces the number of students who have two papers on one
    day, and relocate it — but ONLY to a cell that introduces no same-slot
    student clash (the hard constraint is never violated) and respects the
    first-slot rule and capacity.

    Efficiency: instead of recomputing the whole objective per candidate move,
    we keep a per-(student, day) count and evaluate each move's gain locally
    from that table.
    """
    n_slots = len(slots)

    def cell_load(cell):
        return sum(len(u["labels"]) for u in schedule[cell])

    # student -> [count per day]; and per-cell student set for clash checks
    n_days = 1 + max((d for d, _ in cells), default=0)
    sd = defaultdict(lambda: [0] * n_days)  # student -> per-day paper count
    cell_students = {c: set() for c in cells}
    for (d_i, s_i), units_here in schedule.items():
        for u in units_here:
            cell_students[(d_i, s_i)] |= u["students"]
            for s in u["students"]:
                sd[s][d_i] += 1

    def day_cost(cnt):
        return cnt - 1 if cnt > 1 else 0

    for _ in range(max_passes):
        best_gain = 0
        best_move = None  # (unit, from_cell, to_cell)

        for cur_cell, units_here in list(schedule.items()):
            fd = cur_cell[0]
            for unit in units_here:
                us = unit["students"]
                if not us:
                    continue
                # cost this unit currently contributes on its day (papers it
                # "stacks" for its students on day fd)
                for cell in cells:
                    if cell == cur_cell:
                        continue
                    td, ts = cell
                    if unit["first_slot"] and ts != 0:
                        continue
                    if td == fd:
                        continue  # same day move can't reduce same-day burden
                    # never create a same-slot student clash at destination
                    if us & cell_students[cell]:
                        continue
                    if papers_per_slot and not force_fit:
                        if cell_load(cell) + len(unit["labels"]) > papers_per_slot + 2:
                            continue
                    # gain = (reduction on from-day) - (increase on to-day)
                    gain = 0
                    for s in us:
                        gain += day_cost(sd[s][fd]) - day_cost(sd[s][fd] - 1)
                        gain -= day_cost(sd[s][td] + 1) - day_cost(sd[s][td])
                    if gain > best_gain:
                        best_gain = gain
                        best_move = (unit, cur_cell, cell)

        if best_move is None:
            return  # no improving move — as spread out as the window allows
        unit, frm, to = best_move
        fd, td = frm[0], to[0]
        schedule[frm].remove(unit)
        schedule[to].append(unit)
        # update incremental tables
        cell_students[frm] = set()
        for u in schedule[frm]:
            cell_students[frm] |= u["students"]
        cell_students[to] |= unit["students"]
        for s in unit["students"]:
            sd[s][fd] -= 1
            sd[s][td] += 1


def _try_swap(schedule, cells, slots, unit, cur_cell, papers_per_slot, force_fit):
    """Swap `unit` with a unit in another cell if it lowers the weighted total."""
    base = _weighted_clash_total(schedule)
    for cell in cells:
        if cell == cur_cell:
            continue
        d_i, s_i = cell
        if unit["first_slot"] and s_i != 0:
            continue
        for other in list(schedule[cell]):
            # respect first-slot for the other unit too
            if other["first_slot"] and cur_cell[1] != 0:
                continue
            # perform tentative swap
            schedule[cur_cell].remove(unit)
            schedule[cell].remove(other)
            schedule[cur_cell].append(other)
            schedule[cell].append(unit)
            if _weighted_clash_total(schedule) < base:
                return True  # keep the improving swap
            # revert
            schedule[cur_cell].remove(other)
            schedule[cell].remove(unit)
            schedule[cur_cell].append(unit)
            schedule[cell].append(other)
    return False


def remove_clashes(schedule, slots):
    """
    Final safety sweep: within every slot (same date+time), ensure no two units
    share a student/batch. If found, move the later one to any safe cell.
    Returns number of fixes made.
    """
    cells = sorted(schedule.keys())
    fixes = 0

    def conflict_in_cell(cell, unit, exclude=None):
        for other in schedule[cell]:
            if other is exclude:
                continue
            if _units_conflict(unit, other):
                return True
        return False

    for cell in cells:
        d_i, s_i = cell
        kept = []
        for unit in list(schedule[cell]):
            clash = any(_units_conflict(unit, o) for o in kept)
            if not clash:
                kept.append(unit)
                continue
            # need to relocate this unit
            schedule[cell].remove(unit)
            moved = False
            for target in cells:
                td, ts = target
                if unit["first_slot"] and ts != 0:
                    continue
                # no same-slot clash at target
                if conflict_in_cell(target, unit):
                    continue
                # avoid same-day clash if possible
                same_day_clash = False
                for s2 in range(len(slots)):
                    if s2 == ts:
                        continue
                    if conflict_in_cell((td, s2), unit):
                        same_day_clash = True
                        break
                if same_day_clash:
                    continue
                schedule[target].append(unit)
                moved = True
                fixes += 1
                break
            if not moved:
                # last resort: put it back (keeps paper present)
                schedule[cell].append(unit)
                kept.append(unit)
    return fixes


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# PDF RENDERING  (days = rows, slots = columns)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def _find_logo():
    here = Path(__file__).parent
    for cand in [
        here.parent / "frontend" / "public" / "abasyn-green.png",
        here.parent / "frontend" / "public" / "logo.png",
        here / "abasyn-green.png",
    ]:
        if cand.exists():
            return str(cand)
    return None


def generate_pdf(schedule, dates, slots, meta, output_path):
    """
    Render the datesheet in the exact official Abasyn layout:
      • Logo top-right, date top-right, italic-underlined heading centered
      • Columns: Day | Date | <slot 1> | <slot 2> [| <slot 3> for mids]
      • Course codes bold + underlined, followed by ": Course Name"
      • Footer: "Examination Office AUIC" bottom-right + "Page X of Y"
    Portrait A4 (matches the sample).
    """
    exam_type   = meta["exam_type"]
    heading     = meta["heading"]
    gen_date    = meta.get("gen_date") or datetime.today().strftime("%B %d, %Y")

    styles = getSampleStyleSheet()

    def S(name, **kw):
        if name in styles:
            return styles[name]
        styles.add(ParagraphStyle(name, **kw))
        return styles[name]

    # cell text: "CODE: Name (sections)" with code bold+underlined
    course_style = S("courseCell", fontName="Helvetica", fontSize=6.6,
                     leading=8.4, textColor=_INK, alignment=TA_LEFT)
    day_style  = S("dayCell", fontName="Helvetica-Bold", fontSize=8.5,
                   leading=10.5, textColor=_INK, alignment=TA_CENTER)
    date_style = S("dateCellDark", fontName="Helvetica-Bold", fontSize=7.6,
                   leading=9.5, textColor=_INK, alignment=TA_CENTER)
    hdr_style  = S("slotHdr", fontName="Helvetica-Bold", fontSize=8.6,
                   leading=11, textColor=_INK, alignment=TA_CENTER)

    # ---- page + column widths ---------------------------------------------
    page = A4  # portrait, like the sample
    usable_w = page[0] - 2.2 * cm
    day_w  = 1.75 * cm
    date_w = 2.15 * cm
    slot_w = (usable_w - day_w - date_w) / len(slots)
    col_widths = [day_w, date_w] + [slot_w] * len(slots)

    # ---- header row --------------------------------------------------------
    _per_day = WEEKEND_SLOTS and len(slots) == 1   # BTech: time shown under each date
    header = [Paragraph("Day", hdr_style), Paragraph("Date / Time" if _per_day else "Date", hdr_style)]
    for s in slots:
        header.append(Paragraph("Paper" if _per_day else s, hdr_style))
    table_data = [header]

    def course_line(code, name):
        # underline + bold the code, then ": name"
        safe_name = (name or "").replace("&", "&amp;")
        return Paragraph(f'<u><b>{code}</b></u>: {safe_name}', course_style)

    def cell_flow(units):
        items = []
        for u in units:
            for code, name in zip(u["codes"], u["names"]):
                items.append((code, name))
        if not items:
            return Paragraph("", course_style)
        # sort by code for a tidy column
        items.sort(key=lambda x: x[0])
        return [course_line(c, n) for c, n in items]

    for d_i, d in enumerate(dates):
        # In per-day mode (BTech) the time changes by weekday, so show it under the
        # date instead of only in the (single) column header.
        date_txt = d.strftime("%B %d, %Y")
        if WEEKEND_SLOTS and len(slots) == 1:
            date_txt = f"{date_txt}<br/><b>{_slot_label(d, 0, slots)}</b>"
        row = [
            Paragraph(DAY_NAMES[d.weekday()], day_style),
            Paragraph(date_txt, date_style),
        ]
        for s_i in range(len(slots)):
            row.append(cell_flow(schedule.get((d_i, s_i), [])))
        table_data.append(row)

    tbl = Table(table_data, colWidths=col_widths, repeatRows=1, splitByRow=1)
    style = [
        # header row — light green band, dark text (like the sample)
        ("BACKGROUND", (0, 0), (-1, 0), _MINT),
        ("TOPPADDING", (0, 0), (-1, 0), 6),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 6),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (1, -1), "CENTER"),       # day+date centered
        ("VALIGN", (2, 1), (-1, -1), "TOP"),        # course cells top-aligned
        ("ALIGN", (2, 0), (-1, 0), "CENTER"),       # slot headers centered
        # grid
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#555555")),
        ("BOX", (0, 0), (-1, -1), 1.0, colors.black),
        ("TOPPADDING", (2, 1), (-1, -1), 4),
        ("BOTTOMPADDING", (2, 1), (-1, -1), 4),
        ("LEFTPADDING", (2, 1), (-1, -1), 4),
        ("RIGHTPADDING", (2, 1), (-1, -1), 3),
        ("LEFTPADDING", (0, 0), (1, -1), 2),
        ("RIGHTPADDING", (0, 0), (1, -1), 2),
    ]
    tbl.setStyle(TableStyle(style))

    # ---- header block (heading center, logo + date top-right) --------------
    heading_style = S("headingC", fontName="Helvetica-BoldOblique", fontSize=11,
                      leading=14, textColor=colors.black, alignment=TA_CENTER,
                      underline=True)
    date_top_style = S("dateTop", fontName="Helvetica-BoldOblique", fontSize=9,
                       leading=12, textColor=colors.black, alignment=TA_RIGHT)

    story = []
    logo = _find_logo()

    # top strip: [ spacer | logo+date ] right-aligned
    logo_flow = []
    if logo:
        try:
            img = RLImage(logo)
            ratio = img.imageWidth / img.imageHeight
            img.drawHeight = 0.95 * cm
            img.drawWidth = img.drawHeight * ratio
            logo_flow.append(img)
        except Exception:
            pass
    logo_flow.append(Paragraph(gen_date, date_top_style))

    top = Table([["", logo_flow]], colWidths=[usable_w - 4.5 * cm, 4.5 * cm])
    top.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ALIGN", (1, 0), (1, 0), "RIGHT"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
    ]))
    story.append(top)
    story.append(Spacer(1, 8))
    story.append(Paragraph(f'<u>{heading}</u>', heading_style))
    story.append(Spacer(1, 12))
    story.append(tbl)

    # ---- footer with page numbers + Examination Office AUIC ----------------
    def _footer(canvas, doc_):
        canvas.saveState()
        canvas.setFont("Helvetica-Bold", 9)
        canvas.drawRightString(page[0] - 1.1 * cm, 1.15 * cm, "Examination Office AUIC")
        canvas.setFont("Helvetica", 8)
        page_num = canvas.getPageNumber()
        canvas.drawRightString(page[0] - 1.1 * cm, 0.75 * cm, f"Page {page_num}")
        canvas.restoreState()

    doc = SimpleDocTemplate(
        output_path, pagesize=page,
        topMargin=1.0 * cm, bottomMargin=1.6 * cm,
        leftMargin=1.1 * cm, rightMargin=1.1 * cm,
        title=heading,
    )
    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# HEADING / FILENAME
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def build_heading(program_level, exam_type, semester, year):
    exam_label = "Mid Term Examination" if exam_type == "mids" else "Final Term Examination"
    return f"{program_level} Program Date Sheet, {exam_label}, {semester} {year}"


def build_filename(program_level, exam_type, semester, year):
    exam_label = "Mid term" if exam_type == "mids" else "Final term"
    name = f"{program_level} Program Date Sheet {exam_label} {semester} {year}.pdf"
    return name


def infer_semester_year(start_date: datetime):
    """Guess semester + year from the start date (user can override)."""
    m = start_date.month
    if m in (1, 2, 3, 4, 5):
        sem = "Spring"
    elif m in (6, 7, 8):
        sem = "Summer"
    else:
        sem = "Fall"
    return sem, start_date.year


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ORCHESTRATION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def generate_report(stats, meta, output_path):
    """
    Build a one-page clash-analysis report that accompanies a datesheet.
    Shows dataset size, the exam window, and a verified clash breakdown
    (student-level and batch-level) in clean tables.
    """
    GREEN = colors.HexColor("#0f5132")
    MIDGREEN = colors.HexColor("#198754")
    MINT = colors.HexColor("#d1e7dd")
    LIGHTMINT = colors.HexColor("#e9f5ef")
    OKGREEN = colors.HexColor("#146c43")
    OKBG = colors.HexColor("#d1e7dd")
    AMBERBG = colors.HexColor("#fff3cd")
    GREY = colors.HexColor("#6c757d")
    INK = colors.HexColor("#212529")

    styles = getSampleStyleSheet()

    def S(name, **kw):
        if name in styles:
            for k, v in kw.items():
                setattr(styles[name], k, v)
            return styles[name]
        styles.add(ParagraphStyle(name, **kw))
        return styles[name]

    title_s = S('Rtitle', fontName='Helvetica-Bold', fontSize=15, textColor=GREEN, alignment=TA_CENTER, leading=18)
    sub_s = S('Rsub', fontName='Helvetica', fontSize=8.5, textColor=GREY, alignment=TA_CENTER, leading=11)
    h2_s = S('Rh2', fontName='Helvetica-Bold', fontSize=10.5, textColor=GREEN, leading=13)
    cell_s = S('Rcell', fontName='Helvetica', fontSize=8.5, textColor=INK, leading=11, alignment=TA_CENTER)
    cellb_s = S('Rcellb', fontName='Helvetica-Bold', fontSize=8.5, textColor=INK, leading=11, alignment=TA_CENTER)
    cellL_s = S('RcellL', fontName='Helvetica', fontSize=8.5, textColor=INK, leading=11, alignment=TA_LEFT)

    story = []
    story.append(Paragraph("Examination Datesheet — Clash Analysis Report", title_s))
    story.append(Paragraph(
        f"Abasyn University Islamabad Campus   |   {meta['heading']}", sub_s))
    story.append(Spacer(1, 4))
    story.append(Table([['']], colWidths=[17.5 * cm], style=[('LINEBELOW', (0, 0), (-1, -1), 1.2, GREEN)]))
    story.append(Spacer(1, 9))

    clash_free = stats['student_clashes'] == 0

    # ---- Status banner ----
    if clash_free:
        banner = Table([[Paragraph("<b>STATUS:  CLASH-FREE</b>  —  No student has two papers in the same slot.", 
                                    S('bok', fontName='Helvetica-Bold', fontSize=10, textColor=OKGREEN, alignment=TA_CENTER, leading=13))]],
                       colWidths=[17.5 * cm])
        banner.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), OKBG), ('TOPPADDING', (0, 0), (-1, -1), 7),
                                    ('BOTTOMPADDING', (0, 0), (-1, -1), 7), ('BOX', (0, 0), (-1, -1), 0.8, OKGREEN)]))
    else:
        adv = f" Allocate {stats['min_days_clashfree']} days for a clash-free sheet." if stats.get('min_days_clashfree') else ""
        banner = Table([[Paragraph(f"<b>STATUS:  {stats['student_clashes']} STUDENT CLASH(ES)</b> — window is tight.{adv}", 
                                    S('bwarn', fontName='Helvetica-Bold', fontSize=10, textColor=colors.HexColor('#997404'), alignment=TA_CENTER, leading=13))]],
                       colWidths=[17.5 * cm])
        banner.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), AMBERBG), ('TOPPADDING', (0, 0), (-1, -1), 7),
                                    ('BOTTOMPADDING', (0, 0), (-1, -1), 7), ('BOX', (0, 0), (-1, -1), 0.8, colors.HexColor('#997404'))]))
    story.append(banner)
    story.append(Spacer(1, 10))

    # ---- Section 1: Dataset + window ----
    story.append(Paragraph("1.  Datesheet Summary", h2_s))
    story.append(Spacer(1, 3))
    d1 = [
        [Paragraph('<b>Students</b>', cell_s), Paragraph('<b>Courses</b>', cell_s), Paragraph('<b>Batches</b>', cell_s),
         Paragraph('<b>Exam Days</b>', cell_s), Paragraph('<b>Slots/Day</b>', cell_s), Paragraph('<b>Papers/Slot</b>', cell_s)],
        [Paragraph(str(stats['total_students']), cellb_s), Paragraph(str(stats['total_courses']), cellb_s),
         Paragraph(str(stats['total_batches']), cellb_s), Paragraph(str(stats['total_days']), cellb_s),
         Paragraph(str(stats['slots_per_day']), cellb_s), Paragraph(str(stats['papers_per_slot'] or '—'), cellb_s)],
    ]
    t1 = Table(d1, colWidths=[2.9 * cm] * 6)
    t1.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, 0), MINT), ('BACKGROUND', (0, 1), (-1, 1), LIGHTMINT),
                            ('GRID', (0, 0), (-1, -1), 0.5, MIDGREEN), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                            ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5)]))
    story.append(t1)
    story.append(Paragraph(f"<i>Exam window: {stats['start_date']} to {stats['end_date']}. "
                           f"{'Merges applied: ' + str(stats['merges']) + '. ' if stats['merges'] else ''}"
                           f"Sundays and any marked public holidays are excluded automatically.</i>",
                           S('note', fontName='Helvetica-Oblique', fontSize=7.5, textColor=GREY, leading=10, spaceBefore=3)))
    story.append(Spacer(1, 10))

    # ---- Section 2: Clash analysis ----
    story.append(Paragraph("2.  Clash Analysis (verified against the registration data)", h2_s))
    story.append(Spacer(1, 3))
    d2 = [
        [Paragraph('<b>Clash Type</b>', cellL_s), Paragraph('<b>Count</b>', cell_s), Paragraph('<b>Affected</b>', cell_s), Paragraph('<b>Meaning</b>', cellL_s)],
        [Paragraph('<b>Student clashes</b>', cellL_s), Paragraph(str(stats['student_clashes']), cellb_s),
         Paragraph(f"{stats['students_affected']} students", cell_s),
         Paragraph('One student, two papers, same day &amp; same slot — the real conflict. Must be zero.', cellL_s)],
        [Paragraph('Two papers same day', cellL_s), Paragraph(str(stats.get('same_day_pairs', 0)), cell_s),
         Paragraph(f"{stats.get('students_two_same_day', 0)} students", cell_s),
         Paragraph('One student with two papers on one day, but in different slots (morning + afternoon). Allowed, kept as low as the window permits.', cellL_s)],
        [Paragraph('Batch overlaps', cellL_s), Paragraph(str(stats['batch_overlaps']), cell_s),
         Paragraph(f"{stats['batches_affected']} batches", cell_s),
         Paragraph('Same batch label in a slot — usually different students (soft).', cellL_s)],
    ]
    t2 = Table(d2, colWidths=[3.2 * cm, 1.7 * cm, 2.6 * cm, 10.0 * cm])
    t2.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), GREEN), ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor("#adb5bd")), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('BACKGROUND', (0, 1), (-1, 1), OKBG if clash_free else AMBERBG),
        ('BACKGROUND', (0, 2), (-1, 2), LIGHTMINT),
        ('BACKGROUND', (0, 3), (-1, 3), LIGHTMINT),
    ]))
    story.append(t2)
    story.append(Paragraph(
        "<i>The <b>student clash</b> count is the figure that matters most — a student asked to sit two exams at the exact "
        "same time. This datesheet also spreads each student's papers across days: the <b>two-papers-same-day</b> row counts "
        "students who still have two on one day (in different slots), which the scheduler keeps as low as the exam window allows. "
        "Batch overlaps are harmless — different students within one batch take different electives.</i>",
        S('note2', fontName='Helvetica-Oblique', fontSize=7.5, textColor=GREY, leading=10, spaceBefore=3)))
    story.append(Spacer(1, 10))

    # ---- Section 3: Rules enforced ----
    story.append(Paragraph("3.  Scheduling Rules Applied", h2_s))
    story.append(Spacer(1, 2))
    _fsd = stats.get("first_slot_departments") or []
    if _fsd:
        _fs_rule = (", ".join(_fsd) + " courses are fixed in the first slot of the day; "
                    "the three English papers share one slot.")
    else:
        _fs_rule = ("No department is pinned to the first slot; "
                    "the three English papers share one slot.")
    rules = [
        "Conflict-free placement via graph-colouring: courses sharing any student are guaranteed different slots.",
        _fs_rule,
        "Merged courses (different codes, same paper) are always placed together in a single slot.",
        "Load-balanced: papers are spread evenly across every day and slot, so no single slot is overloaded.",
    ]
    if stats.get("room_note"):
        rules.append("Rooms first, labs as overflow: " + stats["room_note"])
    for r in rules:
        story.append(Paragraph("-  " + r, S('rule', fontName='Helvetica', fontSize=8.5, textColor=INK, leading=11, spaceAfter=3, leftIndent=4)))

    story.append(Spacer(1, 12))
    story.append(Table([['']], colWidths=[17.5 * cm], style=[('LINEABOVE', (0, 0), (-1, -1), 0.8, GREEN)]))
    story.append(Paragraph("Generated automatically by the Abasyn Scheduler engine. Clash figures are computed directly "
                           "from the student registration dataset used to build this datesheet.",
                           S('foot', fontName='Helvetica-Oblique', fontSize=7.5, textColor=GREY, leading=10, alignment=TA_CENTER, spaceBefore=4)))

    doc = SimpleDocTemplate(output_path, pagesize=A4, topMargin=1.0 * cm, bottomMargin=1.0 * cm,
                            leftMargin=1.6 * cm, rightMargin=1.6 * cm, title="Datesheet Clash Analysis Report")
    doc.build(story)


def export_schedule_json(schedule, dates, slots, meta, out_path):
    """
    Write a machine-readable snapshot of the datesheet so other tools (e.g. the
    admit-card generator) can read exactly which course sits on which date/slot
    WITHOUT re-running the scheduler. Returns the JSON file path.
    """
    courses_out = []
    sessions_out = []
    for (d_i, s_i) in sorted(schedule.keys()):
        units = schedule[(d_i, s_i)]
        if not units:
            continue
        codes_here = []
        for u in units:
            # Students sitting this unit — lets ANOTHER datesheet avoid clashing
            # with these students (cross-cohort clash resolution). Sorted for
            # stable output.
            u_students = sorted(str(s) for s in (u.get("students") or []))
            for code, name in zip(u["codes"], u["names"]):
                courses_out.append({
                    "code": code,
                    "name": name,
                    "date": dates[d_i].strftime("%Y-%m-%d"),
                    "date_disp": dates[d_i].strftime("%d-%b-%Y"),
                    "day": DAY_NAMES[dates[d_i].weekday()],
                    "day_index": d_i,
                    "slot_index": s_i,
                    "slot": _slot_label(dates[d_i], s_i, slots),
                    "students": u_students,
                })
                codes_here.append(code)
        sessions_out.append({
            "date": dates[d_i].strftime("%Y-%m-%d"),
            "date_disp": dates[d_i].strftime("%d-%b-%Y"),
            "day": DAY_NAMES[dates[d_i].weekday()],
            "day_index": d_i, "slot_index": s_i, "slot": _slot_label(dates[d_i], s_i, slots),
            "codes": codes_here,
        })

    payload = {
        "exam_type": meta.get("exam_type"),
        "program_level": meta.get("program_level"),
        "semester": meta.get("semester"),
        "year": meta.get("year"),
        "heading": meta.get("heading"),
        "start_date": dates[0].strftime("%d-%b-%Y") if dates else "",
        "end_date": dates[-1].strftime("%d-%b-%Y") if dates else "",
        "dates": [d.strftime("%Y-%m-%d") for d in dates],
        "slots": list(slots),
        "courses": courses_out,
        "sessions": sessions_out,
        # courses with no written paper on THIS sheet (FYP/thesis/labs/…, admin
        # removals) — the auditor uses it to tell "excluded" from "missing".
        "excluded_codes": list(meta.get("excluded_codes") or []),
    }
    sched_path = out_path.rsplit(".", 1)[0] + "_schedule.json"
    with open(sched_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    return sched_path


def run(config: dict) -> dict:
    """
    config keys:
      exam_type       : "mids" | "finals"
      start_date      : "YYYY-MM-DD"
      window_mode     : "by_papers" | "by_days"
      papers_per_slot : int   (when by_papers)
      num_days        : int   (when by_days)
      program_level   : "Undergraduate" | "Postgraduate"
      semester        : "Spring" | "Summer" | "Fall"   (optional; inferred)
      year            : int    (optional; inferred)
      merge_groups    : [[code, code, ...], ...]        (optional)
      data_json       : path to DB export (optional)
      dataset_xlsx    : path to an uploaded dataset (optional)
      out             : output PDF path (optional)
    """
    exam_type = (config.get("exam_type") or "mids").lower()
    if exam_type not in ("mids", "finals"):
        exam_type = "mids"
    slots = MIDS_SLOTS if exam_type == "mids" else FINALS_SLOTS
    # A caller can override the time-slots — e.g. BTech / Engineering-Technology
    # sits one paper per day at 03:00-04:30, so slots_override = ["03:00-04:30"].
    _ov = config.get("slots_override")
    if isinstance(_ov, list) and _ov:
        slots = [str(s).strip() for s in _ov if str(s).strip()]

    # BTech: weekend (Sat/Sun) papers use a different time, and Sundays are used.
    global WEEKEND_SLOTS, INCLUDE_SUNDAYS, SLOT_MASK
    _wknd = config.get("weekend_slots_override")
    WEEKEND_SLOTS = [str(s).strip() for s in _wknd if str(s).strip()] if isinstance(_wknd, list) and _wknd else None
    INCLUDE_SUNDAYS = bool(config.get("include_sundays"))

    # Per-day COLUMN mask: {"weekday":[idx...], "weekend":[idx...]} over the fixed
    # `slots` columns. e.g. BTech has 3 columns 09:00-10:30 / 01:00-02:30 /
    # 03:00-04:30 with weekday→{2}, weekend→{0,1}. Reset to None otherwise.
    _mask = config.get("slot_day_mask")
    if isinstance(_mask, dict) and _mask.get("weekday") is not None and _mask.get("weekend") is not None:
        SLOT_MASK = {"weekday": set(int(i) for i in _mask["weekday"]),
                     "weekend": set(int(i) for i in _mask["weekend"])}
    else:
        SLOT_MASK = None

    # Blocked windows (e.g. Friday Jumma 12:30-14:30). Each entry: {day, start, end}
    # where day is Python weekday() (Mon=0 … Sun=6) and start/end are minutes from
    # midnight. No exam slot may overlap one — enforced for EVERY program.
    global BLOCKED_WINDOWS
    _bw = config.get("blocked_windows")
    BLOCKED_WINDOWS = []
    if isinstance(_bw, list):
        for w in _bw:
            try:
                BLOCKED_WINDOWS.append((int(w["day"]), int(w["start"]), int(w["end"])))
            except Exception:
                continue

    start_str = config.get("start_date")
    start_date = datetime.strptime(start_str, "%Y-%m-%d") if start_str else datetime.today()

    # semester / year
    sem_i, year_i = infer_semester_year(start_date)
    semester = config.get("semester") or sem_i
    year = int(config.get("year") or year_i)
    program_level = config.get("program_level") or "Undergraduate"

    # ---- load courses ------------------------------------------------------
    if config.get("dataset_xlsx"):
        courses = load_courses(Path(config["dataset_xlsx"]))
    elif config.get("data_json"):
        courses = load_courses_from_json(Path(config["data_json"]))
    elif DATASET_PATH.exists():
        courses = load_courses(DATASET_PATH)
    else:
        raise FileNotFoundError("No course data provided and no default dataset found.")

    # ---- user-removed courses (no paper for these) -------------------------
    # The admin can drop specific courses from the datesheet before generating
    # (e.g. courses with no written exam). Match on course code, case-insensitive.
    exclude_codes = {
        str(c).strip().upper()
        for c in (config.get("exclude_courses") or [])
        if str(c).strip()
    }

    # ---- automatic exam eligibility (same rules as the Exam Engine) ---------
    # Courses with NO written paper are dropped from the DATESHEET automatically —
    # FYP / thesis / dissertation / internship / industrial & field training /
    # "Project", "Project-I/II" / labs (incl. the 'L' twin of a lecture, e.g.
    # CETL312 = lab of CET312) / clinical rotations / seminars. They stay in every
    # student's course list in the DB — only the exam schedule skips them.
    # DB `noExam` flags (db_no_exam_codes) are honoured, EXCEPT the old importer's
    # false positive: theory papers whose title merely contains "Project"
    # (Software Project Management, Project Scope … Management) are restored.
    auto_excluded, restored_no_exam, review_no_exam = {}, [], []
    if config.get("auto_eligibility", True):
        try:
            from exam_engine.rules import classify_course
            titles, comps = {}, {}
            _rows = []
            if config.get("data_json") and Path(config["data_json"]).exists():
                with open(config["data_json"], "r", encoding="utf-8") as _f:
                    _rows = (json.load(_f) or {}).get("courses", [])
            for r in _rows:
                cc = _extract_course_code(r.get("code") or r.get("fullCode") or "")
                if cc:
                    titles.setdefault(cc, _norm(r.get("name")))
                    comps.setdefault(cc, set()).add(_norm(r.get("component") or "Lecture").lower())
            for c in courses:
                cc = str(c.get("code", "")).upper()
                titles.setdefault(cc, c.get("name", ""))
            # every known code (incl. ones the loader already dropped as lab / FYP /
            # training) so the exported exclusion list is complete for the auditor
            for cc, t in titles.items():
                comp = "Lab" if comps.get(cc) == {"lab"} else ""
                ok, why = classify_course(cc, t, titles, comp)
                if not ok:
                    auto_excluded[cc] = why
            for cc in {str(x).strip().upper() for x in (config.get("db_no_exam_codes") or []) if str(x).strip()}:
                t = titles.get(cc, "")
                ok, _ = classify_course(cc, t, titles)
                if ok and "project" in t.lower() and cc not in exclude_codes:
                    restored_no_exam.append(cc)
                else:
                    exclude_codes.add(cc)
                    # honoured, but it LOOKS like a theory paper (e.g. VS204 "Ocular
                    # Diseases-I" highlighted yellow) → surfaced for the exam office to
                    # confirm; the system never silently overrides an admin highlight.
                    if ok and t and cc in {str(c.get("code", "")).upper() for c in courses}:
                        review_no_exam.append({"code": cc, "title": t})
        except Exception as _e:
            print(f"[eligibility] skipped: {_e}", file=sys.stderr)
            exclude_codes |= {str(x).strip().upper() for x in (config.get("db_no_exam_codes") or []) if str(x).strip()}
    else:
        exclude_codes |= {str(x).strip().upper() for x in (config.get("db_no_exam_codes") or []) if str(x).strip()}
    exclude_codes |= set(auto_excluded)
    exclude_codes -= {str(x).strip().upper() for x in (config.get("include_courses") or []) if str(x).strip()}
    if exclude_codes:
        # `courses` is a list of course dicts (both loaders return lists). Filter it.
        if isinstance(courses, dict):
            courses = {k: v for k, v in courses.items()
                       if str(v.get("code", "")).strip().upper() not in exclude_codes}
        else:
            courses = [c for c in courses
                       if str(c.get("code", "")).strip().upper() not in exclude_codes]

    if not courses:
        raise ValueError("No examinable courses found in the provided data.")

    # ---- room / lab inventory (rooms get priority; labs are overflow) -------
    # The datesheet balances papers so each slot's concurrent exams fit the
    # available rooms first; labs are only needed if a slot must exceed the
    # room count. Read the counts from the DB export when present.
    n_rooms = n_labs = 0
    total_seats = 0
    try:
        _dj = config.get("data_json")
        if _dj and Path(_dj).exists():
            _raw = json.load(open(_dj, encoding="utf-8"))
            n_rooms = len(_raw.get("rooms") or [])
            n_labs = len(_raw.get("labs") or [])
            # Total exam seat capacity = Σ over rooms+labs of (rows × 2 benches).
            # Used as the per-slot capacity ceiling so the optimiser can't pile every
            # paper into one slot to kill 2-per-day (P5 load balance).
            for _v in list(_raw.get("rooms") or []) + list(_raw.get("labs") or []):
                _rows = int(_v.get("rows") or _v.get("capacity") or 0)
                _seats = int(_v.get("seatsPerRow") or 2) or 2
                total_seats += (_rows * _seats) if _rows else int(_v.get("capacity") or 0)
    except Exception:
        pass

    # ---- which department(s) go in the first slot (admin's choice) ---------
    # config "first_slot_departments" = list of code prefixes (e.g. ["CS","CE"]).
    # Absent  → default CE/PD (legacy). Present (even empty) → exactly that list.
    global FIRST_SLOT_PREFIXES
    if "first_slot_departments" in config:
        fsd = config.get("first_slot_departments") or []
        FIRST_SLOT_PREFIXES = [str(p).strip().upper() for p in fsd if str(p).strip()]
    else:
        FIRST_SLOT_PREFIXES = None

    # ---- merges + units ----------------------------------------------------
    # BUILT-IN English rule (exam office): English-I (SS104) and English-III (SS211)
    # ALWAYS share ONE slot — same day, same time. A student only ever sits ONE
    # English level in a term, so SS104 and SS211 share no students → co-slotting them
    # is clash-free (apply_merges auto-splits if that ever isn't true). This also lets
    # the English group fit a 2-slot FINALS day: {SS104+SS211} in one slot and
    # English-II (SS203) in the OTHER slot the SAME day, via same_day_groups below.
    _merge_groups = [list(g) for g in (config.get("merge_groups") or [])]
    _merge_groups.append(["SS104", "SS211"])
    units = apply_merges(courses, _merge_groups,
                         force_merges=bool(config.get("force_merges")))
    merge_warnings = list(getattr(apply_merges, "last_warnings", []) or [])

    # ---- window: compute days + per-slot cap using the user's formula ------
    #
    # The user's inputs are HARD — we never silently grow the window.
    #
    #   by_days   : user gives D days.  Papers are divided evenly:
    #                 per_slot = ceil(total_papers / (D * n_slots))
    #               so D days always suffice and every slot is packed evenly.
    #               e.g. 200 papers, 4 days, 2 slots -> ceil(200/8) = 25/slot.
    #
    #   by_papers : user gives N papers/slot.  Days are derived:
    #                 D = ceil(total_papers / (N * n_slots))
    #               and each slot holds exactly up to N papers.
    #
    window_mode = config.get("window_mode") or "by_papers"
    n_slots = len(slots)
    total_units = len(units)

    if window_mode == "by_days":
        n_days = max(1, int(config.get("num_days") or 7))
        papers_per_slot = math.ceil(total_units / (n_days * n_slots))
    else:  # by_papers
        papers_per_slot = max(1, int(config.get("papers_per_slot") or 0) or 1)
        n_days = math.ceil(total_units / (papers_per_slot * n_slots))

    dates = get_exam_dates(start_date, n_days, config.get("exclude_dates"))

    # max papers per student per day (default 1; the admin can allow 2)
    try:
        max_per_day = max(1, int(config.get("max_papers_per_day") or 1))
    except Exception:
        max_per_day = 1

    # ---- schedule --------------------------------------------------------
    # PRIMARY: OR-Tools CP-SAT finds the optimal slot layout — fewest student-days
    # with 2 papers, fewest back-to-back pairs, balanced load — while guaranteeing
    # 0 same-slot clashes, ≤2 papers/day, blocked windows and the BTech SLOT_MASK.
    # We warm-start it with the greedy layout. If OR-Tools is missing or the solve
    # fails, we fall back to the greedy scheduler + its repair passes.
    _cohort_tag = "btech" if SLOT_MASK else ("pg" if str(program_level).lower().startswith("post") else "bs")
    cap_per_cell = total_seats if total_seats and total_seats > 0 else None
    # give the big BS model more time; small cohorts converge fast
    _cpsat_time = int(config.get("cpsat_time_limit") or (300 if len(units) > 150 else 90))
    used_cpsat = False
    unplaced = []
    if config.get("use_cpsat", True):
        try:
            # warm-start layout from the greedy scheduler
            hint, _ = schedule_units(units, dates, slots, papers_per_slot,
                                     force_fit=True, max_per_day=max(1, max_per_day), restarts=4)
            # FEASIBILITY CASCADE. The 0-same-slot-clash constraint is SACRED and
            # stays hard in every attempt; we relax the SOFTER hard-constraints in
            # order only when a solve is INFEASIBLE, so a tight window (e.g. too few
            # seats, or a student who must sit >2 papers in a day) can never force a
            # same-slot clash — it just over-fills a slot or a day instead.
            #   0: everything hard (seat capacity + ≤2/day)
            #   1: seat capacity soft (allow a slot to over-fill)
            #   2: + ≤2/day soft (allow a 3rd paper in a day as a last resort)
            _cp_err = None
            for _sc, _smd in ((False, False), (True, False), (True, True)):
                try:
                    schedule = schedule_units_cpsat(
                        units, dates, slots, cap_per_cell=cap_per_cell, max_per_day=2,
                        time_limit_s=_cpsat_time, hint_schedule=hint, cohort=_cohort_tag,
                        same_day_groups=config.get("same_day_groups") or [],
                        soft_capacity=_sc, soft_max_per_day=_smd)
                    if _sc or _smd:
                        print(f"[cpsat] feasible after relaxation "
                              f"(soft_capacity={_sc}, soft_max_per_day={_smd})", file=sys.stderr)
                    used_cpsat = True
                    break
                except Exception as _e:
                    _cp_err = _e
                    continue
            if not used_cpsat:
                raise _cp_err or RuntimeError("CP-SAT infeasible at all relaxation levels")
            # Phase 1b: local-search polish to cut back-to-back pairs (hard
            # constraints preserved — the 0-clash CP-SAT layout stays clash-free).
            _reduce_back_to_back(schedule, dates, slots, cap_per_cell=cap_per_cell)
        except Exception as _e:
            print(f"[cpsat] fell back to greedy: {_e}", file=sys.stderr)
            used_cpsat = False

    if not used_cpsat:
        schedule, unplaced = schedule_units(units, dates, slots, papers_per_slot,
                                            force_fit=True, max_per_day=max_per_day, restarts=12)

    # ---- final clash removal + count --------------------------------------
    # CP-SAT and the per-day column mask (BTech) each place papers in already-valid
    # cells with 0 clashes; the greedy clash/gap/balance passes below assume every
    # slot is usable on every day and would move papers into disallowed cells (and
    # undo the CP-SAT optimum), so we skip them in those cases.
    if not SLOT_MASK and not used_cpsat:
        fixes = remove_clashes(schedule, slots)
        # remove_clashes may relocate units to trim (soft, allowed) batch overlaps.
        # The GAP arrangement must be the TRUE last step: seat each student's two
        # same-day papers in the first + last slot (free middle) and never leave 3
        # in a day. We must NOT _balance_slots after this — re-balancing spreads
        # papers evenly across all slots, which re-fills the middle slot and
        # destroys the gap (the gap pass already balances the middle slot).
        _enforce_gap(schedule, dates, slots, max_iter=20)
        _final_repair(schedule, dates, slots)   # keep 0 same-slot clashes sacred
    else:
        fixes = 0
    student_clashes = _slot_clash_count(schedule)

    # ---- CROSS-COHORT clash resolution (avoid_clash_schedules) -------------
    # Feed other datesheets' schedules (with their per-course students). Any paper
    # in THIS datesheet whose students already sit a shared paper (same real
    # date+slot) in another datesheet is moved to a free, clash-free slot. This is
    # how a B.Tech-exclusive course auto-shifts off a slot occupied by a gen-ed BS
    # paper its students also sit.
    external_clash_moves = 0
    ext_paths = config.get("avoid_clash_schedules") or []
    fixed_courses = config.get("fixed_courses") or []
    if ext_paths or fixed_courses:
        # Parse "HH:MM-HH:MM" → (start_min, end_min); exam hours 1–7 are afternoon.
        def _win(lbl):
            mm = re.findall(r'(\d{1,2}):(\d{2})', str(lbl or ''))
            if len(mm) < 2:
                return None
            def tm(h, m):
                h = int(h); m = int(m)
                if h < 8:
                    h += 12
                return h * 60 + m
            return (tm(*mm[0]), tm(*mm[1]))

        # This grid's cell windows per (date, slot) — matched by TIME OVERLAP, not
        # by label (BS "09:00-12:00" and BTech "09:00-10:30" overlap → a clash).
        cell_win = {}
        for d_i in range(len(dates)):
            for s_i in range(len(slots)):
                w = _win(_slot_label(dates[d_i], s_i, slots))
                if w:
                    cell_win[(d_i, s_i)] = w

        ext_by_student = {}
        date_to_di = {dt.strftime("%Y-%m-%d"): d_i for d_i, dt in enumerate(dates)}
        for p in ext_paths:
            try:
                with open(p, "r", encoding="utf-8") as f:
                    other = json.load(f)
            except Exception:
                continue
            for c in other.get("courses", []):
                d_i = date_to_di.get(c.get("date"))
                if d_i is None:
                    continue
                ew = _win(c.get("slot"))
                if not ew:
                    continue
                # every cell on that date whose window overlaps the external paper
                cells = [(d_i, s_i) for s_i in range(len(slots))
                         if (d_i, s_i) in cell_win
                         and cell_win[(d_i, s_i)][0] < ew[1] and ew[0] < cell_win[(d_i, s_i)][1]]
                if not cells:
                    continue
                for sid in (c.get("students") or []):
                    ext_by_student.setdefault(str(sid), set()).update(cells)
        # The PINNED gen-ed papers are also fixed occupancy: this cohort's OWN
        # courses must move off those slots for students who sit the pinned paper,
        # so e.g. MS501 doesn't land on SS122's slot. (Cells outside this grid —
        # e.g. SS121 on a date this cohort doesn't use — simply don't match.)
        for f in fixed_courses:
            ew = _win(f.get("slot"))
            d_i = date_to_di.get(f.get("date"))
            if ew is None or d_i is None:
                continue
            cells = [(d_i, s_i) for s_i in range(len(slots))
                     if (d_i, s_i) in cell_win
                     and cell_win[(d_i, s_i)][0] < ew[1] and ew[0] < cell_win[(d_i, s_i)][1]]
            if not cells:
                continue
            for sid in (f.get("students") or []):
                ext_by_student.setdefault(str(sid), set()).update(cells)
        if ext_by_student:
            external_clash_moves = _repair_external_clashes(schedule, dates, slots, ext_by_student)
            if external_clash_moves and not SLOT_MASK:
                _final_repair(schedule, dates, slots)   # keep 0 internal clashes
            student_clashes = _slot_clash_count(schedule)
    # BTech (SLOT_MASK) can't use _final_repair — clean up any residual same-slot
    # student clash from the masked placer / the moves above with a mask-aware pass.
    if SLOT_MASK:
        _repair_internal_masked(schedule, dates, slots)
        student_clashes = _slot_clash_count(schedule)

    # ---- shared gen-ed papers pinned onto THIS cohort's sheet --------------
    # SS121/SS122 etc. that MS & B.Tech students also sit are shown on their OWN
    # datesheet at the SAME date/time the BS sheet fixed (one paper, one time).
    fixed_courses = config.get("fixed_courses") or []
    if fixed_courses:
        schedule, dates, slots = _merge_fixed_courses(schedule, dates, slots, fixed_courses)
        # after adding pinned papers, make sure no cohort course now shares a slot
        # with a pinned paper for the same student. _repair_internal_masked NEVER
        # moves a pinned paper (fixed=True) and respects the BTech mask, so the
        # pinned same-slot invariant across sheets is preserved.
        _repair_internal_masked(schedule, dates, slots)
        student_clashes = _slot_clash_count(schedule)

    # ---- room / lab load check (rooms first, labs overflow) ---------------
    # Peak concurrent papers in any single slot: these each need a venue. Rooms
    # are filled first; labs only cover the overflow above the room count.
    max_per_slot = max((sum(len(u["labels"]) for u in cu) for cu in schedule.values()), default=0)
    n_venues = n_rooms + n_labs
    labs_needed = max(0, max_per_slot - n_rooms) if n_rooms else 0
    venue_ok = (n_venues == 0) or (max_per_slot <= n_venues)
    if n_venues and not venue_ok:
        room_note = (f"A slot needs {max_per_slot} venues but only {n_venues} exist "
                     f"({n_rooms} rooms + {n_labs} labs) — add exam days to spread the load.")
    elif labs_needed:
        room_note = (f"Rooms first: up to {n_rooms} papers/slot use rooms; "
                     f"{labs_needed} overflow into labs.")
    elif n_rooms:
        room_note = f"All slots fit within the {n_rooms} rooms — no labs needed."
    else:
        room_note = ""

    # same-day burden: how many students have 2+ papers on one day (different
    # slots). The scheduler minimises this; report it so the user can see it.
    same_day_pairs = _same_day_pairs(schedule)
    students_two_same_day = 0
    _psd = defaultdict(lambda: defaultdict(int))
    for (d_i, _s_i), cu in schedule.items():
        for u in cu:
            for s in u["students"]:
                _psd[s][d_i] += 1
    for day_counts in _psd.values():
        if any(cnt >= 2 for cnt in day_counts.values()):
            students_two_same_day += 1

    # If the user's window is too tight to be clash-free, compute the smallest
    # number of days that WOULD be clash-free (same per-slot balancing), so the
    # UI can advise the user. We do not change their window automatically.
    min_days_clashfree = None
    if student_clashes > 0:
        probe_days = n_days
        for extra in range(1, 40):
            probe_days = n_days + extra
            pps_probe = math.ceil(total_units / (probe_days * n_slots))
            probe_dates = get_exam_dates(start_date, probe_days, config.get("exclude_dates"))
            probe_sched, _ = schedule_units(units, probe_dates, slots, pps_probe, force_fit=True)
            remove_clashes(probe_sched, slots)
            if _slot_clash_count(probe_sched) == 0:
                min_days_clashfree = probe_days
                break

    # ---- heading / filename -----------------------------------------------
    # A cohort may carry its own title on the PDF (e.g. "B.Tech" for the combined
    # Civil + Electrical Engineering-Technology sheet); default = program level.
    heading = build_heading(config.get("program_title") or program_level, exam_type, semester, year)
    filename = build_filename(program_level, exam_type, semester, year)

    out_path = config.get("out")
    if not out_path:
        out_dir = Path(__file__).parent / "output"
        out_dir.mkdir(exist_ok=True)
        out_path = str(out_dir / filename)

    meta = {
        "exam_type": exam_type,
        "heading": heading,
        "program_level": program_level,
        "semester": semester,
        "year": year,
        "excluded_codes": sorted(exclude_codes),
    }
    generate_pdf(schedule, dates, slots, meta, out_path)

    # ---- clash statistics for the report ----------------------------------
    # student clashes already counted; also count batch overlaps and how many
    # of them are "real" (an actual student takes both papers).
    batch_overlaps = 0
    real_batch = 0
    batches_affected = set()
    students_affected = set()
    for cell_units in schedule.values():
        seen_b = set()
        for u in cell_units:
            for b in u["batches"]:
                if b in seen_b:
                    batch_overlaps += 1
                    batches_affected.add(b)
                else:
                    seen_b.add(b)
        seen_s = set()
        for u in cell_units:
            for s in u["students"]:
                if s in seen_s:
                    students_affected.add(s)
                else:
                    seen_s.add(s)

    total_students = len(set(s for u in units for s in u["students"]))
    total_batches = len(set(b for u in units for b in u["batches"]))

    stats = {
        "total_courses": len(courses),
        "total_students": total_students,
        "total_batches": total_batches,
        "student_clashes": student_clashes,
        "students_affected": len(students_affected),
        "same_day_pairs": same_day_pairs,
        "students_two_same_day": students_two_same_day,
        "batch_overlaps": batch_overlaps,
        "batches_affected": len(batches_affected),
        "total_days": len(dates),
        "slots_per_day": len(slots),
        "papers_per_slot": papers_per_slot,
        "max_papers_per_slot": max_per_slot,
        "rooms": n_rooms,
        "labs": n_labs,
        "labs_needed": labs_needed,
        "venue_ok": venue_ok,
        "room_note": room_note,
        "first_slot_departments": (FIRST_SLOT_PREFIXES if FIRST_SLOT_PREFIXES is not None else ["CE", "PD"]),
        "min_days_clashfree": min_days_clashfree,
        "merges": len(config.get("merge_groups") or []),
        "merge_warnings": merge_warnings,
        "start_date": dates[0].strftime("%d-%b-%Y") if dates else "",
        "end_date": dates[-1].strftime("%d-%b-%Y") if dates else "",
    }

    # ---- generate the companion analysis report ---------------------------
    report_path = None
    if config.get("report", True):
        rp = out_path.rsplit(".", 1)[0] + "_Report.pdf"
        try:
            generate_report(stats, meta, rp)
            report_path = rp
        except Exception as e:
            report_path = None

    # ---- structured schedule snapshot (for admit cards etc.) --------------
    try:
        schedule_file = export_schedule_json(schedule, dates, slots, meta, out_path)
    except Exception:
        schedule_file = None

    # ---- department-wise OUTPUT of ONE joint schedule ----------------------
    # When the admin wants separate PDFs per department, the papers are still
    # SOLVED TOGETHER (one CP-SAT model over every student of the cohort) and only
    # the OUTPUT is split. Solving departments separately can double-book a student
    # who takes courses from two departments — the sheets cannot see each other.
    split_results = []
    try:
        for sp in (config.get("split_outputs") or []):
            want = {str(c).strip().upper() for c in (sp.get("codes") or [])}
            sub = {}
            for cell, cell_units in schedule.items():
                keep = [u for u in cell_units if any(str(c).upper() in want for c in u["codes"])]
                if keep:
                    sub[cell] = keep
            if not sub or not sp.get("out"):
                continue
            generate_pdf(sub, dates, slots, meta, sp["out"])
            split_results.append({
                "key": sp.get("key"), "file": sp["out"],
                "schedule_file": export_schedule_json(sub, dates, slots, meta, sp["out"]),
                "papers": sum(len(u["labels"]) for cu in sub.values() for u in cu),
            })
    except Exception as _e:
        print(f"[split] department output failed: {_e}", file=sys.stderr)

    # ---- summary -----------------------------------------------------------
    total_papers = sum(len(u["labels"]) for u in units)
    return {
        "status": "ok",
        "file": out_path,
        "report_file": report_path,
        "schedule_file": schedule_file,
        "filename": filename,
        "heading": heading,
        "exam_type": exam_type,
        "program_level": program_level,
        "semester": semester,
        "year": year,
        "start_date": dates[0].strftime("%d-%b-%Y") if dates else "",
        "end_date": dates[-1].strftime("%d-%b-%Y") if dates else "",
        "total_days": len(dates),
        "slots_per_day": len(slots),
        "papers_per_slot": papers_per_slot,
        "max_papers_per_slot": max_per_slot,
        "rooms": n_rooms,
        "labs": n_labs,
        "labs_needed": labs_needed,
        "venue_ok": venue_ok,
        "room_note": room_note,
        "window_mode": window_mode,
        "total_courses": len(courses),
        "total_units": len(units),
        "total_papers": total_papers,
        "unplaced": len(unplaced),
        "clash_fixes": fixes,
        "student_clashes": student_clashes,
        "external_clash_moves": external_clash_moves,
        "students_affected": len(students_affected),
        "students_two_same_day": students_two_same_day,
        "same_day_pairs": same_day_pairs,
        "used_cpsat": used_cpsat,
        "batch_overlaps": batch_overlaps,
        "batches_affected": len(batches_affected),
        "total_students": total_students,
        "total_batches": total_batches,
        "min_days_clashfree": min_days_clashfree,
        "merges": len(config.get("merge_groups") or []),
        "merge_warnings": merge_warnings,
        "auto_excluded": auto_excluded,
        "restored_no_exam": sorted(restored_no_exam),
        "review_no_exam": review_no_exam,
        "split_results": split_results,
    }


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CLI
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def main():
    parser = argparse.ArgumentParser(description="Abasyn datesheet generator")
    parser.add_argument("exam_type", nargs="?", help="mids | finals")
    parser.add_argument("date", nargs="?", help="Start date YYYY-MM-DD")
    parser.add_argument("--config", help="Path to a JSON config with all inputs")
    parser.add_argument("--data", help="Path to JSON export from the database")
    parser.add_argument("--dataset", help="Path to an uploaded .xlsx dataset")
    parser.add_argument("--out", help="Output PDF path")
    parser.add_argument("--days", type=int, help="Number of exam days (by_days mode)")
    parser.add_argument("--papers-per-slot", type=int, help="Papers per slot (by_papers mode)")
    parser.add_argument("--program-level", default="Undergraduate")
    parser.add_argument("--semester")
    parser.add_argument("--year", type=int)
    args = parser.parse_args()

    if args.config:
        with open(args.config, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    else:
        cfg = {
            "exam_type": args.exam_type or "mids",
            "start_date": args.date or datetime.today().strftime("%Y-%m-%d"),
            "data_json": args.data,
            "dataset_xlsx": args.dataset,
            "out": args.out,
            "program_level": args.program_level,
            "semester": args.semester,
            "year": args.year,
        }
        if args.days:
            cfg["window_mode"] = "by_days"
            cfg["num_days"] = args.days
        elif args.papers_per_slot:
            cfg["window_mode"] = "by_papers"
            cfg["papers_per_slot"] = args.papers_per_slot
        else:
            cfg["window_mode"] = "by_days"
            cfg["num_days"] = 7

    result = run(cfg)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
