"""
End-to-end examination pipeline.

    python -m exam_engine.pipeline --config pipeline_config.json

Stages (each one is verified before the next starts):

  1. DATA        uploaded files (any shape) and/or the live DB export → one dataset
  2. ELIGIBILITY which registered courses have a written paper (labs / FYP / thesis /
                 internship / clinical rotations do not; 'Project Management' does)
  3. DATESHEETS  one per cohort on its OWN fixed slots — BS, B.Tech, MS — each built
                 from that cohort's real registrations with OR-Tools CP-SAT:
                 0 student clashes (hard), ≤2 papers/day (hard), minimum same-day load
  4. SEATING     ONE global seating over every cohort (rooms shared safely):
                 overlapping papers co-seated, bench partners never the same paper,
                 room turnover gap, admit cards, ID sheets, invigilation roster with
                 no double duty and no teacher invigilating their own paper
  5. AUDIT       an independent checker re-derives every rule from the source data;
                 any HARD finding fails the run (nothing is published half-right)
  6. TIMETABLE   (optional) the CP-SAT weekly timetable engine on the same uploads

Source data is never modified: the pipeline only reads it and writes new files.
Prints ONE JSON line (the summary) on stdout; exit code 0 = clean, 2 = audit failed.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import traceback
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCHED_DIR = HERE.parent
if str(SCHED_DIR) not in sys.path:
    sys.path.insert(0, str(SCHED_DIR))

from . import ingest as ING                                    # noqa: E402
from .rules import (COHORTS, COHORT_LABEL, cohort_of, classify_course, norm_code,   # noqa: E402
                    cohort_datesheet_policy)
from .audit import Audit, audit_datesheets, audit_seating     # noqa: E402

LOG = []
PFX = ""          # filename prefix (the backend passes a unique stamp)


LOG_FILE = None    # live progress file the backend polls


def log(msg):
    line = f"[pipeline {time.strftime('%H:%M:%S')}] {msg}"
    LOG.append(line)
    print(line, file=sys.stderr, flush=True)
    if LOG_FILE:
        try:
            with open(LOG_FILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass


def _write(path, obj):
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, default=_ser), encoding="utf-8")
    return str(path)


def _ser(o):
    if isinstance(o, set):
        return sorted(o)
    if isinstance(o, Counter):
        return dict(o)
    return str(o)


# ━━ 1. DATA ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def load_data(cfg, outdir):
    base = None
    if cfg.get("data_json") and Path(cfg["data_json"]).exists():
        base = json.load(open(cfg["data_json"], encoding="utf-8"))
    files = [f for f in (cfg.get("files") or []) if Path(f).exists()]
    canon = None
    if files:
        canon = ING.ingest(files)
        log(f"ingested {len(files)} file(s): " + ", ".join(
            f"{f['file']}→{f.get('shape', f.get('error'))}" for f in canon["files"]))
        _write(outdir / f"{PFX}canonical_dataset.json", canon)
        has_students = bool(canon["students"])
        if has_students:
            export = ING.merge_into_export(canon, base) if cfg.get("merge_with_db") and base else ING.to_export(canon, base)
        else:                       # e.g. only a class-wise / rooms file → enrich the DB export
            if not base:
                raise ValueError("No student registrations: upload the student-wise registration report.")
            export = ING.merge_into_export(canon, base)
    elif base:
        export = base
    else:
        raise ValueError("No data: give `files` (uploaded reports) and/or `data_json` (DB export).")
    if not export.get("rooms") and not export.get("labs"):
        raise ValueError("No exam venues: the DB export has no rooms and no rooms file was uploaded.")
    p = _write(outdir / f"{PFX}pipeline_export.json", export)
    log(f"dataset: {len(export['student_registrations'])} students, {len(export['courses'])} course rows, "
        f"{len(export.get('rooms', []))} rooms, {len(export.get('labs', []))} labs")
    return export, p, canon


# ━━ 2. ELIGIBILITY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def decide_eligibility(export, cfg):
    titles, comps = {}, defaultdict(Counter)
    for c in export.get("courses", []):
        code = norm_code(c.get("code"))
        titles.setdefault(code, c.get("name") or code)
        comps[code][c.get("component") or "Lecture"] += 1
    registered = Counter(norm_code(x) for r in export["student_registrations"] for x in set(r.get("courses", [])))
    excluded, reasons = set(), {}
    for code in registered:
        comp = "Lab" if comps[code] and comps[code].most_common(1)[0][0] == "Lab" and "Lecture" not in comps[code] else ""
        ok, why = classify_course(code, titles.get(code, code), titles, comp)
        if not ok:
            excluded.add(code)
            reasons[code] = why
    admin = {norm_code(c) for c in (cfg.get("exclude_courses") or [])}
    for c in admin:
        excluded.add(c)
        reasons.setdefault(c, "excluded by admin")
    # DB 'noExam' flags: honour them, EXCEPT the known false positive of the old
    # importer rule (`\bproject\b` flagged "Software Project Management" etc.).
    overridden = []
    for c in {norm_code(x) for x in (cfg.get("no_exam_codes") or [])}:
        t = titles.get(c, "")
        ok, _ = classify_course(c, t, titles)
        if ok and "project" in t.lower() and c not in admin:
            overridden.append({"code": c, "title": t})
            continue
        excluded.add(c)
        reasons.setdefault(c, "marked no-exam in DB")
    for c in {norm_code(x) for x in (cfg.get("include_courses") or [])}:
        excluded.discard(c)
        reasons.pop(c, None)
    examinable = sorted(c for c in registered if c not in excluded)
    log(f"eligibility: {len(examinable)} examinable papers, {len([c for c in excluded if c in registered])} "
        f"registered courses without a written paper"
        + (f"; {len(overridden)} DB no-exam flag(s) overridden (Project-Management false positives)" if overridden else ""))
    return excluded, reasons, overridden, examinable


# ━━ 3. DATESHEETS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def cohort_export(export, cohort, excluded):
    regs = [r for r in export["student_registrations"] if cohort_of(r.get("program") or r.get("batch")) == cohort]
    taken = {norm_code(c) for r in regs for c in r.get("courses", [])}
    courses = [c for c in export.get("courses", []) if norm_code(c.get("code")) in taken]
    # normalise registration codes for lookup (copy — the source export is untouched)
    regs = [{**r, "courses": list(dict.fromkeys(norm_code(c) for c in r.get("courses", [])))} for r in regs]
    for c in courses:
        c["code"] = norm_code(c.get("code"))
    return {**export, "courses": courses, "student_registrations": regs}


def run_datesheets(export, excluded, cfg, outdir):
    import datesheet as ds
    exam_type = (cfg.get("exam_type") or "finals").lower()
    results, sched_paths, fixed_pool = {}, {}, {}
    order = [c for c in ("bs", "pg", "btech") if c in (cfg.get("cohorts_to_run") or COHORTS)]
    policy = cfg.get("shared_paper_policy", "independent")
    for coh in order:
        cexp = cohort_export(json.loads(json.dumps(export)), coh, excluded)
        if not cexp["student_registrations"]:
            log(f"datesheet[{coh}]: no students — skipped")
            continue
        ccfg = dict(cfg.get("cohort_settings", {}).get(coh, {}))
        data_p = _write(outdir / f"{PFX}ds_{coh}_data.json", cexp)
        tag = {"bs": "BS", "btech": "BTech", "pg": "MS"}[coh]
        out_pdf = str(outdir / f"{PFX}Datesheet_{'Mids' if exam_type == 'mids' else 'Finals'}_{tag}.pdf")
        dcfg = {
            "exam_type": exam_type,
            "start_date": ccfg.get("start_date") or cfg["start_date"],
            "window_mode": ccfg.get("window_mode") or cfg.get("window_mode") or "by_days",
            "num_days": ccfg.get("num_days") or cfg.get("num_days") or 7,
            "papers_per_slot": ccfg.get("papers_per_slot") or cfg.get("papers_per_slot"),
            "max_papers_per_day": ccfg.get("max_papers_per_day") or cfg.get("max_papers_per_day") or 1,
            "semester": cfg.get("semester"), "year": cfg.get("year"),
            "merge_groups": cfg.get("merge_groups") or [],
            "same_day_groups": cfg.get("same_day_groups") or [["SS104", "SS203", "SS211"]],
            "exclude_dates": cfg.get("exclude_dates") or [],
            "blocked_windows": cfg.get("blocked_windows") or [],
            "exclude_courses": sorted(excluded),
            "cpsat_time_limit": ccfg.get("cpsat_time_limit") or cfg.get("cpsat_time_limit"),
            "data_json": data_p, "out": out_pdf,
            **({"first_slot_departments": cfg["first_slot_departments"]} if "first_slot_departments" in cfg else {}),
            **cohort_datesheet_policy(coh, exam_type),
        }
        # Optional: one paper, one time — a code BS already scheduled is pinned at the
        # SAME date/time on the B.Tech / MS sheet (only when that time is one of the
        # cohort's own slot labels, so no new time-slot is ever invented).
        if policy == "same_time" and coh != "bs" and "bs" in results:
            bs_s = json.load(open(sched_paths["bs"], encoding="utf-8"))
            mine = {norm_code(c) for r in cexp["student_registrations"] for c in r["courses"]}
            fixed = []
            for c in bs_s["courses"]:
                code = norm_code(c["code"])
                if code in mine and code not in excluded:
                    studs = [r["student_id"] for r in cexp["student_registrations"] if code in r["courses"]]
                    fixed.append({"code": code, "name": c["name"], "date": c["date"], "slot": c["slot"], "students": studs})
            if fixed:
                dcfg["fixed_courses"] = fixed
                dcfg["exclude_courses"] = sorted(set(dcfg["exclude_courses"]) | {f["code"] for f in fixed})
                log(f"datesheet[{coh}]: {len(fixed)} shared paper(s) pinned to BS date/time")
        dcfg = {k: v for k, v in dcfg.items() if v is not None}
        log(f"datesheet[{coh}]: {len(cexp['student_registrations'])} students — solving …")
        t0 = time.time()
        res = ds.run(dcfg)
        res["seconds"] = round(time.time() - t0, 1)
        results[coh] = res
        sched_paths[coh] = res.get("schedule_file")
        log(f"datesheet[{coh}]: {res.get('total_units')} papers, {res.get('total_days')} days, "
            f"student clashes={res.get('student_clashes')}, students with 2/day={res.get('students_two_same_day', '?')}, "
            f"{res['seconds']}s")
    return results, sched_paths


def policy_slots(sched_paths, exam_type):
    import datesheet as ds
    out = {}
    for coh, p in sched_paths.items():
        if coh == "btech":
            out[coh] = {"slots": {"09:00-10:30", "01:00-02:30", "03:00-04:30"}}
        else:
            out[coh] = {"slots": set(ds.MIDS_SLOTS if exam_type == "mids" else ds.FINALS_SLOTS)}
    return out


# ━━ 4. SEATING / ADMIT / ID / INVIGILATION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def run_admit(export_path, sched_paths, cfg, outdir):
    import admit_cards as ac
    exam_type = (cfg.get("exam_type") or "finals").lower()
    word = "Mids" if exam_type == "mids" else "Finals"
    a = cfg.get("admit") or {}
    acfg = {
        "campus_line": a.get("campus_line") or "Abasyn University Islamabad Campus",
        "data_json": export_path,
        "datesheets_by_cohort": {k: v for k, v in sched_paths.items() if v},
        "out": str(outdir / f"{PFX}AdmitCards_{word}.pdf"),
        "out_seating": str(outdir / f"{PFX}AdmitCards_{word}_SeatingPlan.pdf"),
        "out_idsheets": str(outdir / f"{PFX}AdmitCards_{word}_IdentificationSheets.pdf"),
        "out_invig": str(outdir / f"{PFX}AdmitCards_{word}_Invigilation.pdf"),
        "out_verify": str(outdir / f"{PFX}AdmitCards_{word}_verify.json"),
        "out_layout": str(outdir / f"{PFX}AdmitCards_{word}_layout.json"),
        "base_url": a.get("base_url") or "",
        "verify_secret": a.get("verify_secret") or "",
        "fee_default": a.get("fee_default") or "Unpaid",
        "progress_file": a.get("progress_file"),
        "include_labs": bool(a.get("include_labs")),
        "room_turnover_min": int(cfg.get("room_turnover_min", 30)),
        "invigilator_max_per_day": int(cfg.get("invigilator_max_per_day", 2)),
    }
    log(f"seating: unified over {', '.join(acfg['datesheets_by_cohort'])} …")
    t0 = time.time()
    res = ac.run(acfg)
    res["seconds"] = round(time.time() - t0, 1)
    log(f"seating: {res.get('admit_cards')} admit cards, {res.get('sessions')} sessions, "
        f"unseated={res.get('unseated_count')}, clashes={res.get('clash_count')}, {res['seconds']}s")
    return res


# ━━ 6. TIMETABLE (optional) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def run_timetable(cfg, canon_files, outdir):
    """Run the CP-SAT weekly timetable engine on the uploaded class-wise + student-wise
    reports (its own parse.py validates them). Output: timetable.json + Excel."""
    tt = cfg.get("timetable") or {}
    if not tt.get("enabled"):
        return None
    shapes = {f["shape"]: f["path"] for f in canon_files if f.get("shape") in ("student", "coursewise")}
    if "student" not in shapes or "coursewise" not in shapes:
        log("timetable: needs BOTH the class-wise and the student-wise report — skipped")
        return {"status": "skipped", "reason": "needs class-wise + student-wise reports"}
    if any(Path(shapes[k]).suffix.lower() != ".xls" for k in ("student", "coursewise")):
        log("timetable: the timetable engine reads the original .xls reports — skipped for .xlsx/.csv uploads")
        return {"status": "skipped", "reason": "timetable engine needs the .xls reports"}
    eng = SCHED_DIR / "timetable_engine"
    work = outdir / f"{PFX}timetable"
    if work.exists():
        shutil.rmtree(work)
    shutil.copytree(eng, work, ignore=shutil.ignore_patterns("__pycache__", "*.xls", "*.xlsx", "*.json"))
    shutil.copy(eng / "config.json", work / "config.json")
    shutil.copy(shapes["coursewise"], work / "classwise.xls")
    shutil.copy(shapes["student"], work / "students.xls")
    py = sys.executable
    out = {}
    for step in (["parse.py"], ["engine.py"], ["verify_json.py"]):
        if not (work / step[0]).exists():
            continue
        log(f"timetable: {step[0]} …")
        p = subprocess.run([py] + step, cwd=work, capture_output=True, text=True,
                           timeout=int(tt.get("timeout_s", 1800)))
        out[step[0]] = {"code": p.returncode, "tail": (p.stdout + p.stderr)[-1500:]}
        if p.returncode != 0:
            log(f"timetable: {step[0]} failed (exit {p.returncode})")
            out["status"] = "failed"
            return out
    out["status"] = "ok"
    out["files"] = sorted(str(x) for x in work.glob("timetable*") if x.is_file())
    # verify_json.py prints per timetable: "| room dbl N | teacher clash N | student clash N"
    clashes = {}
    import re as _re
    for line in out.get("verify_json.py", {}).get("tail", "").splitlines():
        m = _re.match(r"\s*(\S+) entries (\d+) \| room dbl (\d+) \| teacher clash (\d+) \| student clash (\d+)", line)
        if m:
            clashes[m.group(1)] = {"entries": int(m.group(2)), "room_double": int(m.group(3)),
                                   "teacher_clash": int(m.group(4)), "student_clash": int(m.group(5))}
    out["verify"] = clashes
    return out


# ━━ REPORT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def write_report(summary, path):
    """Plain, printable audit report (PDF) for the exam office."""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import cm
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
    from reportlab.lib import colors
    S = getSampleStyleSheet()
    doc = SimpleDocTemplate(str(path), pagesize=A4, leftMargin=1.5 * cm, rightMargin=1.5 * cm,
                            topMargin=1.2 * cm, bottomMargin=1.2 * cm, title="Exam Pipeline Audit")
    a = summary["audit"]
    st = []
    st.append(Paragraph("Abasyn University Islamabad Campus — Examination Pipeline Audit", S["Title"]))
    verdict = "CLEAN — all hard rules satisfied" if a["clean"] else "FAILED — hard rule violations found"
    st.append(Paragraph(f"<b>Verdict:</b> <font color='{'#0f5132' if a['clean'] else '#b02a37'}'>{verdict}</font>", S["Heading2"]))
    st.append(Paragraph(f"Generated {summary['generated_at']} · exam: {summary['exam_type']} · start {summary['start_date']}", S["Normal"]))
    st.append(Spacer(1, 0.4 * cm))
    rows = [["Cohort", "Students", "Papers", "Days", "Student clashes", "2 papers/day"]]
    for coh, d in summary["datesheets"].items():
        rows.append([COHORT_LABEL.get(coh, coh), d.get("total_students"), d.get("total_units"),
                     d.get("total_days"), d.get("student_clashes"), d.get("students_two_same_day")])
    t = Table(rows, hAlign="LEFT")
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#14663f")),
                           ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                           ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#94c7ac")),
                           ("FONTSIZE", (0, 0), (-1, -1), 8.5)]))
    st.append(t)
    st.append(Spacer(1, 0.4 * cm))
    ad = summary.get("admit") or {}
    st.append(Paragraph(f"<b>Seating:</b> {ad.get('admit_cards', 0)} admit cards · {ad.get('sessions', 0)} sessions · "
                        f"{ad.get('venues', 0)} venues · unseated {ad.get('unseated_count', 0)} · "
                        f"solo benches {a['stats'].get('solo_benches', 0)} · invigilators {a['stats'].get('invigilators', 0)}",
                        S["Normal"]))
    st.append(Spacer(1, 0.3 * cm))
    st.append(Paragraph("Hard checks", S["Heading3"]))
    hard_names = ["D1_missing_paper", "D2_scheduled_twice", "D3_student_time_clash", "D4_over_daily_cap",
                  "D5_slot_outside_policy", "S1_scheduled_paper_not_seated", "S2_seat_double_booked",
                  "S3_seat_time_differs_from_datesheet", "S3_admit_card_differs_from_seating",
                  "S4_bench_partners_same_paper", "S5_seat_beyond_capacity", "S6_room_turnover_too_short",
                  "I1_invigilator_double_booked", "I2_invigilator_teaches_paper_in_room",
                  "I3_room_understaffed", "I4_invigilator_over_daily_cap"]
    rows = [["Rule", "Violations"]] + [[n, a["hard_counts"].get(n, 0)] for n in hard_names] + \
           [[k, v] for k, v in a["hard_counts"].items() if k not in hard_names]
    t = Table(rows, hAlign="LEFT", colWidths=[11 * cm, 3 * cm])
    sty = [("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#94c7ac")), ("FONTSIZE", (0, 0), (-1, -1), 8.5),
           ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#d1e7dd"))]
    for i, r in enumerate(rows[1:], start=1):
        if r[1]:
            sty.append(("TEXTCOLOR", (1, i), (1, i), colors.HexColor("#b02a37")))
    t.setStyle(TableStyle(sty))
    st.append(t)
    st.append(Spacer(1, 0.3 * cm))
    st.append(Paragraph("Notes (soft)", S["Heading3"]))
    for k, v in a["soft_counts"].items():
        st.append(Paragraph(f"• {k}: {v}", S["Normal"]))
    for code in (a.get("soft", {}).get("W2_same_code_different_times") or [])[:20]:
        st.append(Paragraph(f"&nbsp;&nbsp;– {code['code']}: " + "; ".join(f"{c} {d} {s}" for c, d, s in code["where"]), S["Normal"]))
    if summary.get("overridden_no_exam"):
        st.append(Spacer(1, 0.2 * cm))
        st.append(Paragraph("<b>Courses restored to the datesheet</b> (DB had them as no-exam because their title "
                            "contains 'Project'): " + ", ".join(f"{o['code']} {o['title']}" for o in summary["overridden_no_exam"]),
                            S["Normal"]))
    q = summary.get("data_quality") or {}
    if q:
        st.append(Spacer(1, 0.2 * cm))
        st.append(Paragraph("Data quality (source files were NOT changed)", S["Heading3"]))
        for k, v in q.items():
            st.append(Paragraph(f"• {k}: {v}", S["Normal"]))
    doc.build(st)
    return str(path)


# ━━ MAIN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def run(cfg):
    global PFX, LOG_FILE
    LOG_FILE = cfg.get("log_file")
    PFX = "".join(ch for ch in str(cfg.get("prefix") or "") if ch.isalnum() or ch in "_-")
    outdir = Path(cfg.get("outdir") or (SCHED_DIR / "output" / f"pipeline_{int(time.time())}"))
    outdir.mkdir(parents=True, exist_ok=True)
    exam_type = (cfg.get("exam_type") or "finals").lower()
    summary = {"status": "running", "outdir": str(outdir), "exam_type": exam_type,
               "start_date": cfg.get("start_date"), "generated_at": time.strftime("%Y-%m-%d %H:%M")}
    export, export_path, canon = load_data(cfg, outdir)
    if canon:
        summary["data_quality"] = canon["summary"]["quality_counts"]
        summary["ingest"] = canon["summary"]
    excluded, reasons, overridden, examinable = decide_eligibility(export, cfg)
    summary["examinable_papers"] = len(examinable)
    summary["no_exam_courses"] = reasons
    summary["overridden_no_exam"] = overridden

    ds_res, sched_paths = run_datesheets(export, excluded, cfg, outdir)
    if not sched_paths:
        raise ValueError("No datesheet could be built (no examinable registrations).")
    summary["datesheets"] = {k: {kk: v.get(kk) for kk in (
        "file", "report_file", "schedule_file", "total_students", "total_units", "total_days", "student_clashes",
        "students_two_same_day", "start_date", "end_date", "seconds", "heading", "external_clash_moves")}
        for k, v in ds_res.items()}

    pol = policy_slots(sched_paths, exam_type)
    if cfg.get("shared_paper_policy") == "same_time" and "bs" in pol:
        for coh in pol:                       # pinned shared papers keep the BS time
            pol[coh]["slots"] |= pol["bs"]["slots"]
    A = Audit()
    max_day = 2
    schedules = {c: json.load(open(p, encoding="utf-8")) for c, p in sched_paths.items() if p}
    audit_datesheets(export, schedules, excluded, pol, max_per_day=max_day, A=A)
    ds_hard = {k: v for k, v in A.hard.items() if v}
    if ds_hard and cfg.get("strict", True):
        log(f"AUDIT: datesheet violations {({k: len(v) for k, v in ds_hard.items()})} — seating NOT generated")
        summary["admit"] = None
    elif not cfg.get("skip_admit"):
        ad = run_admit(export_path, sched_paths, cfg, outdir)
        summary["admit"] = {k: ad.get(k) for k in (
            "file", "seating_file", "idsheets_file", "invig_file", "verify_file", "layout_file", "admit_cards",
            "sessions", "venues", "unseated_count", "clash_count", "solo_benches", "turnover_relaxed", "seconds",
            "heading", "total_students", "students_no_paper")}
        layout = json.load(open(ad["layout_file"], encoding="utf-8")) if ad.get("layout_file") else {}
        verify = json.load(open(ad["verify_file"], encoding="utf-8")) if ad.get("verify_file") else None
        audit_seating(export, schedules, layout, verify, turnover_min=int(cfg.get("room_turnover_min", 30)),
                      inv_cap=int(cfg.get("invigilator_max_per_day", 2)), A=A)

    if canon and (cfg.get("timetable") or {}).get("enabled"):
        files_with_path = []
        for f in cfg.get("files") or []:
            for fi in canon["files"]:
                if fi["file"] == Path(f).name:
                    files_with_path.append({**fi, "path": f})
        summary["timetable"] = run_timetable(cfg, files_with_path, outdir)
        tt = summary["timetable"] or {}
        if tt.get("status") == "failed":
            A.h("T0_timetable_engine_failed", {k: v for k, v in tt.items() if k != "status"})
        for name, v in (tt.get("verify") or {}).items():
            for k in ("room_double", "teacher_clash", "student_clash"):
                if v.get(k):
                    A.h(f"T1_timetable_{k}", {"timetable": name, "count": v[k]})

    summary["audit"] = A.result()
    _write(outdir / f"{PFX}audit.json", summary["audit"])
    summary["status"] = "ok" if summary["audit"]["clean"] else "audit_failed"
    try:
        summary["report_file"] = write_report(summary, outdir / f"{PFX}Pipeline_Audit_Report.pdf")
    except Exception as e:
        log(f"report: {e}")
    summary["log"] = LOG[-60:]
    _write(outdir / f"{PFX}pipeline_summary.json", summary)
    log(f"DONE: {'CLEAN' if summary['audit']['clean'] else 'AUDIT FAILED'} · hard={summary['audit']['hard_counts']} "
        f"soft={summary['audit']['soft_counts']}")
    return summary


def main():
    ap = argparse.ArgumentParser(description="Abasyn end-to-end examination pipeline")
    ap.add_argument("--config", required=True)
    a = ap.parse_args()
    cfg = json.load(open(a.config, encoding="utf-8"))
    try:
        s = run(cfg)
    except Exception as e:
        traceback.print_exc()
        print(json.dumps({"status": "failed", "error": str(e), "log": LOG[-30:]}))
        sys.exit(1)
    slim = {k: v for k, v in s.items() if k not in ("log", "no_exam_courses")}
    slim["audit"] = {k: s["audit"][k] for k in ("clean", "hard_counts", "soft_counts", "stats")}
    print(json.dumps(slim, default=_ser))
    sys.exit(0 if s["audit"]["clean"] else 2)


if __name__ == "__main__":
    main()
