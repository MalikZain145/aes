"""
Business rules shared by every stage of the exam pipeline.

Nothing here changes data. These functions only DECIDE (is this paper examinable?
which cohort is this student in? which time-slots does a cohort use?).
"""
import re

# The datesheet engine owns the canonical no-exam keyword list + lab-by-name test.
import datesheet as _ds

COHORTS = ("bs", "btech", "pg")
COHORT_LABEL = {"bs": "BS (Undergraduate)", "btech": "B.Tech / BSc Engineering Technology",
                "pg": "MS / MPhil / PhD (Postgraduate)"}


# ── codes ────────────────────────────────────────────────────────────────────
def norm_code(raw) -> str:
    """Lookup key for a course code: trimmed, upper-case, inner spaces removed.
    ('Mg231' → 'MG231', 'CS 313' → 'CS313', 'CS499-II' stays)."""
    return re.sub(r"\s+", "", str(raw or "")).upper()


def norm_text(s) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip()


def title_key(s) -> str:
    """Title comparison key: case/punctuation-insensitive, '(lab)' and credit tags removed."""
    t = str(s or "").lower()
    t = re.sub(r"\((?:lab|\d+(?:\.\d+)?|\d\+\d)\)", " ", t)
    t = re.sub(r"\blab\b", " ", t)
    return re.sub(r"[^a-z0-9]+", "", t)


# ── cohorts ──────────────────────────────────────────────────────────────────
def cohort_of(program: str) -> str:
    """'pg' (MS/MPhil/PhD/Master/MBA), 'btech' (B.Tech / Engineering Technology) or 'bs'.
    Kept identical to admit_cards._student_cohort and generateController._isPGprog/_isBTprog."""
    p = " " + str(program or "").lower().replace(".", "").replace("-", " ") + " "
    if any(k in p for k in (" ms ", " mphil ", "mphil", " master", " mba ", " msc ",
                            "postgrad", " pgd ", " phd ", "doctor of philosophy", " dphil ")):
        return "pg"
    if ("btech" in p) or (" b tech" in p) or ("engineering technology" in p):
        return "btech"
    return "bs"


# ── exam eligibility ─────────────────────────────────────────────────────────
def lab_sibling(code: str, all_codes) -> str:
    """'CETL312' → 'CET312' when that lecture code exists (department prefix + 'L')."""
    m = re.match(r"^([A-Z]+)L(\d.*)$", code or "")
    if m and len(m.group(1)) >= 2:
        sib = m.group(1) + m.group(2)
        if sib in all_codes:
            return sib
    return ""


def classify_course(code: str, title: str, titles_by_code: dict, component: str = "") -> tuple:
    """Return (examinable: bool, reason: str).
       not examinable when:
         • component is Lab, or the title says 'lab'
         • it is the LAB twin of a lecture: 'CETL312 Reinforced and Pre Stress Concrete'
           has the SAME title as lecture CET312 → it is CET312's lab, no separate paper
         • FYP / thesis / internship / project-I/II / field training / seminar …
       ('Software Project Management', 'Project Scope, Time and Cost Management' ARE
        examinable — they are theory papers, not projects.)"""
    if str(component or "").lower() == "lab":
        return False, "lab component"
    if _ds._looks_like_lab(title):
        return False, "lab (title)"
    sib = lab_sibling(code, titles_by_code)
    if sib and title_key(title) == title_key(titles_by_code.get(sib, "")):
        return False, f"lab twin of {sib}"
    # Exam-office convention: an 'L' after the department prefix = LAB course
    # (CETL, CTL, ELTL, TCTL, NSCL, CSL …). When the prefix without the 'L' is a real
    # department prefix in this term's data, the course is a lab even if its title
    # does not say "lab" and its lecture twin is not offered this term.
    m = re.match(r"^([A-Z]{2,})L(\d{3,4}.*)$", str(code or "").upper())
    if m and any(re.match(r"^" + re.escape(m.group(1)) + r"\d", k) for k in titles_by_code):
        return False, f"lab course ({m.group(1)}L…)"
    if _ds._is_excluded(title):
        return False, "project / thesis / internship / training"
    if PRACTICAL_RE.search(str(title or "")):
        return False, "clinical / practical (no written paper)"
    return True, ""


# Practical / clinical rotations — assessed in the clinic/lab, not by a written paper.
# Word-precise: "Refraction Clinic-I", "Supervised clinical practice-V", "OT Procedures"
# are practical; "Clinical Medicine-I", "Clinical Psychology" are THEORY (kept).
PRACTICAL_RE = re.compile(
    r"(\bclinic\b|supervised\s+clinical\s+practice|clinical\s+(duty|rotation|placement)|"
    r"\bward\s+procedures\b|^\s*ot\s+procedures\b|optical\s+laboratory|"
    r"operating\s+room\s+skills|\bseminar\b|\bpracticum\b|\bclerkship\b)", re.I)


# ── fixed time-slot policies (UNCHANGED university slots) ────────────────────
def cohort_datesheet_policy(cohort: str, exam_type: str) -> dict:
    """Datesheet config fragment per cohort. These are exactly the slots the system
    already uses — nothing is re-timed:
        BS    finals 09:00-12:00 | 01:00-03:00      mids 09:00-10:30 | 11:00-12:30 | 01:00-02:30
        MS    same columns as BS (Postgraduate heading)
        B.Tech 09:00-10:30 | 01:00-02:30 | 03:00-04:30 with weekdays → 03:00-04:30 only,
               Sat/Sun → 09:00-10:30 & 01:00-02:30, Sundays used."""
    if cohort == "btech":
        return {
            "program_level": "Undergraduate",
            "program_title": "B.Tech",
            "slots_override": ["09:00-10:30", "01:00-02:30", "03:00-04:30"],
            "slot_day_mask": {"weekday": [2], "weekend": [0, 1]},
            "include_sundays": True,
        }
    if cohort == "pg":
        return {"program_level": "Postgraduate"}
    return {"program_level": "Undergraduate"}


def slot_span(label):
    """'01:00-03:00' → (780, 900) minutes; exam clock hours 1-7 are afternoon."""
    mm = re.findall(r"(\d{1,2}):(\d{2})", str(label or ""))
    if len(mm) < 2:
        return None

    def tm(h, m):
        h, m = int(h), int(m)
        if h < 8:
            h += 12
        return h * 60 + m
    return tm(*mm[0]), tm(*mm[1])


def overlaps(a, b) -> bool:
    return bool(a and b and a[0] < b[1] and b[0] < a[1])
