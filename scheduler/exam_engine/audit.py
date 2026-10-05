"""
Independent auditor — re-derives every rule from the SOURCE registrations and checks
the generated datesheets / seating / admit cards / invigilation against it.

It shares no state with the generators: it reads only the export JSON, the datesheet
schedule JSONs, the admit-card verify JSON and the seating layout JSON. A run is
"clean" only when every HARD check returns zero findings.

HARD (block publishing)                              SOFT (reported)
  D1 registered examinable paper missing from sheet    W1 student with 2 papers in a day
  D2 paper scheduled twice in one cohort sheet         W2 same code at different times
  D3 student has two papers overlapping in time           across cohorts (paper-leak risk)
  D4 >2 papers for a student in one day                W3 solo benches
  D5 slot outside the cohort's fixed slot policy       W4 invigilator load spread
  S1 scheduled paper not seated                        W5 turnover rule relaxed (capacity)
  S2 seat double-booked (same room/seat/overlapping time)
  S3 seat/time on admit card ≠ seating plan ≠ datesheet
  S4 bench partners writing the same paper
  S5 seat beyond room capacity
  S6 room reused with < turnover minutes between sessions
  I1 invigilator in two rooms at overlapping times
  I2 invigilator teaches a paper written in that room
  I3 room with fewer than 2 invigilators
  I4 invigilator over the daily duty cap
"""
import json
import re
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

from .rules import cohort_of, slot_span, overlaps, norm_code


def _person_key(name):
    n = re.sub(r"[^a-z ]+", " ", str(name or "").lower())
    n = re.sub(r"\b(dr|mr|mrs|ms|miss|engr|prof|professor|sir)\b", " ", n)
    return re.sub(r"\s+", "", n)


def _d(date_str):
    for fmt in ("%Y-%m-%d", "%d-%b-%Y"):
        try:
            return datetime.strptime(date_str, fmt).strftime("%Y-%m-%d")
        except Exception:
            pass
    return date_str


class Audit:
    def __init__(self):
        self.hard = defaultdict(list)
        self.soft = defaultdict(list)
        self.stats = {}

    def h(self, code, item):
        self.hard[code].append(item)

    def s(self, code, item):
        self.soft[code].append(item)

    def result(self):
        return {
            "clean": not any(self.hard.values()),
            "hard_counts": {k: len(v) for k, v in self.hard.items() if v},
            "soft_counts": {k: len(v) for k, v in self.soft.items() if v},
            "hard": {k: v[:200] for k, v in self.hard.items() if v},
            "soft": {k: v[:200] for k, v in self.soft.items() if v},
            "stats": self.stats,
        }


def audit_datesheets(export, schedules, excluded_codes, policies, max_per_day=2, A=None):
    """schedules: {cohort: schedule_json_dict}; policies: {cohort: {"slots": set(...)}}"""
    A = A or Audit()
    regs = export.get("student_registrations", [])
    excluded = {norm_code(c) for c in excluded_codes}
    # cohort -> code -> [entries]
    idx = {}
    for coh, sch in schedules.items():
        m = defaultdict(list)
        for c in sch.get("courses", []):
            m[norm_code(c["code"])].append(c)
        idx[coh] = m
        for code, es in m.items():
            cells = {(e["date"], e["slot"]) for e in es}
            if len(cells) > 1:
                A.h("D2_scheduled_twice", {"cohort": coh, "code": code, "cells": sorted(cells)})
        allowed = policies.get(coh, {}).get("slots")
        if allowed:
            for e in sch.get("courses", []):
                if e["slot"] not in allowed:
                    A.h("D5_slot_outside_policy", {"cohort": coh, "code": e["code"], "slot": e["slot"]})
    papers_checked = 0
    per_student = {}
    for r in regs:
        sid = str(r["student_id"])
        coh = cohort_of(r.get("program") or r.get("batch"))
        m = idx.get(coh)
        if m is None:
            continue
        mine = []
        for code in dict.fromkeys(norm_code(c) for c in r.get("courses", [])):
            if code in excluded:
                continue
            es = m.get(code)
            if not es:
                A.h("D1_missing_paper", {"sid": sid, "cohort": coh, "code": code})
                continue
            e = es[0]
            papers_checked += 1
            mine.append((code, e["date"], e["slot"]))
        per_student[sid] = mine
        for i in range(len(mine)):
            for j in range(i + 1, len(mine)):
                a, b = mine[i], mine[j]
                if a[1] == b[1] and overlaps(slot_span(a[2]), slot_span(b[2])):
                    A.h("D3_student_time_clash", {"sid": sid, "a": a, "b": b})
        day = Counter(d for _, d, _ in mine)
        for d, n in day.items():
            if n > max_per_day:
                A.h("D4_over_daily_cap", {"sid": sid, "date": d, "papers": n})
            elif n == 2:
                A.s("W1_two_papers_one_day", {"sid": sid, "date": d})
    # W2 same code at different times across cohorts
    when = defaultdict(set)
    for coh, m in idx.items():
        for code, es in m.items():
            for e in es:
                when[code].add((coh, e["date"], e["slot"]))
    for code, w in when.items():
        if len({(d, s) for _, d, s in w}) > 1:
            A.s("W2_same_code_different_times", {"code": code, "where": sorted(w)})
    A.stats["papers_checked"] = papers_checked
    A.stats["students_checked"] = len(per_student)
    return A, per_student


def audit_seating(export, schedules, layout, verify, turnover_min=30, inv_cap=2, A=None):
    A = A or Audit()
    regs = {str(r["student_id"]): r for r in export.get("student_registrations", [])}
    # datesheet time per (cohort, code)
    ds_time = {}
    for coh, sch in schedules.items():
        for c in sch.get("courses", []):
            ds_time[(coh, norm_code(c["code"]))] = (c["date"], c["slot"])
    venues = {v["name"]: v for v in layout.get("venues", [])}
    # ---- flatten seats
    seats = []
    for sess in layout.get("sessions", []):
        sdate = _d(sess["date"])
        for room in sess["rooms"]:
            for row in room["rows"]:
                seats.append({"date": sdate, "session_slot": sess["slot"], "time": row.get("time") or sess["slot"],
                              "room": room["name"], "row": int(row["row"]), "seat": row["seat"],
                              "col": row.get("col"), "sid": str(row["sid"]), "course": norm_code(row["course"])})
    A.stats["seats"] = len(seats)
    # S2 double booking: same date+room+seat with overlapping times
    by_rs = defaultdict(list)
    for s in seats:
        by_rs[(s["date"], s["room"], s["seat"])].append(s)
    for k, lst in by_rs.items():
        for i in range(len(lst)):
            for j in range(i + 1, len(lst)):
                if overlaps(slot_span(lst[i]["session_slot"]), slot_span(lst[j]["session_slot"])):
                    A.h("S2_seat_double_booked", {"date": k[0], "room": k[1], "seat": k[2],
                                                  "a": (lst[i]["sid"], lst[i]["course"]),
                                                  "b": (lst[j]["sid"], lst[j]["course"])})
    # S1 / S3 coverage + time consistency
    seat_of = defaultdict(list)
    for s in seats:
        seat_of[(s["sid"], s["course"])].append(s)
        r = regs.get(s["sid"])
        if not r:
            A.h("S3_seated_unknown_student", {"sid": s["sid"], "course": s["course"]})
            continue
        coh = cohort_of(r.get("program") or r.get("batch"))
        want = ds_time.get((coh, s["course"]))
        if not want:
            A.h("S3_seated_paper_not_on_datesheet", {"sid": s["sid"], "course": s["course"], "cohort": coh})
        elif (want[0], want[1]) != (s["date"], s["time"]):
            A.h("S3_seat_time_differs_from_datesheet",
                {"sid": s["sid"], "course": s["course"], "datesheet": want, "seat": (s["date"], s["time"])})
        if s["course"] not in {norm_code(c) for c in r.get("courses", [])}:
            A.h("S3_seated_in_unregistered_course", {"sid": s["sid"], "course": s["course"]})
    for k, lst in seat_of.items():
        if len(lst) > 1:
            A.h("S3_paper_seated_twice", {"sid": k[0], "course": k[1], "n": len(lst)})
    # every scheduled paper must have a seat
    for sid, r in regs.items():
        coh = cohort_of(r.get("program") or r.get("batch"))
        for code in dict.fromkeys(norm_code(c) for c in r.get("courses", [])):
            if (coh, code) in ds_time and (sid, code) not in seat_of:
                A.h("S1_scheduled_paper_not_seated", {"sid": sid, "course": code, "when": ds_time[(coh, code)]})
    # admit-card (verify json) must equal the seating layout
    if verify:
        for st in verify.get("students", []):
            for e in st.get("exams", []):
                key = (str(st["sid"]), norm_code(e["code"]))
                lst = seat_of.get(key)
                if not lst:
                    A.h("S3_admit_card_seat_missing", {"sid": key[0], "course": key[1]})
                    continue
                s = lst[0]
                if (s["room"], s["seat"], s["date"], s["time"]) != (e["room"], e["seat"], e["date"], e["slot"]):
                    A.h("S3_admit_card_differs_from_seating",
                        {"sid": key[0], "course": key[1], "card": (e["room"], e["seat"], e["date"], e["slot"]),
                         "plan": (s["room"], s["seat"], s["date"], s["time"])})
    # S4 bench partners + S5 capacity
    bench = defaultdict(list)
    for s in seats:
        bench[(s["date"], s["session_slot"], s["room"], s["row"])].append(s)
        v = venues.get(s["room"])
        if v and s["row"] > int(v.get("rows") or 0):
            A.h("S5_seat_beyond_capacity", {"room": s["room"], "row": s["row"], "rows": v.get("rows")})
        if s["room"] not in venues:
            A.h("S5_unknown_room", {"room": s["room"]})
    solo = 0
    for k, lst in bench.items():
        if len(lst) == 1:
            solo += 1
        if len(lst) > 2:
            A.h("S2_bench_over_two", {"bench": k, "n": len(lst)})
        if len(lst) == 2 and lst[0]["course"] == lst[1]["course"]:
            A.h("S4_bench_partners_same_paper", {"bench": k, "course": lst[0]["course"]})
    A.stats["solo_benches"] = solo
    for k, lst in bench.items():
        if len(lst) == 1:
            A.s("W3_solo_benches", {"bench": k, "sid": lst[0]["sid"], "course": lst[0]["course"]})
    # S6 turnover
    room_sessions = defaultdict(set)
    for s in seats:
        room_sessions[(s["date"], s["room"])].add(s["session_slot"])
    relaxed = set(layout.get("turnover_relaxed") or [])
    for (d, room), sl in room_sessions.items():
        spans = sorted((slot_span(x), x) for x in sl)
        for (a, la), (b, lb) in zip(spans, spans[1:]):
            if a and b and 0 <= b[0] - a[1] < turnover_min:
                item = {"date": d, "room": room, "first": la, "next": lb, "gap_min": b[0] - a[1]}
                if any(r.startswith(d) for r in relaxed):
                    A.s("W5_turnover_relaxed_for_capacity", item)
                else:
                    A.h("S6_room_turnover_too_short", item)
    # ---- invigilation
    ct = {k: set(v) for k, v in (layout.get("course_teachers") or {}).items()}
    duty = defaultdict(list)          # person -> [(date, span, room)]
    for sess in layout.get("sessions", []):
        sdate, span = _d(sess["date"]), slot_span(sess["slot"])
        for room in sess["rooms"]:
            invs = room.get("invigilators") or []
            if len(invs) < 2:
                A.h("I3_room_understaffed", {"date": sdate, "slot": sess["slot"], "room": room["name"], "n": len(invs)})
            courses = {norm_code(r["course"]) for r in room["rows"]}
            banned = set().union(*[ct.get(c, set()) for c in courses]) if courses else set()
            for p in invs:
                if _person_key(p) in banned:
                    A.h("I2_invigilator_teaches_paper_in_room",
                        {"date": sdate, "slot": sess["slot"], "room": room["name"], "invigilator": p})
                duty[p].append((sdate, span, room["name"], sess["slot"]))
    for p, lst in duty.items():
        for i in range(len(lst)):
            for j in range(i + 1, len(lst)):
                if lst[i][0] == lst[j][0] and overlaps(lst[i][1], lst[j][1]):
                    A.h("I1_invigilator_double_booked", {"invigilator": p, "a": lst[i][2:], "b": lst[j][2:], "date": lst[i][0]})
        for d, n in Counter(x[0] for x in lst).items():
            if n > inv_cap:
                A.h("I4_invigilator_over_daily_cap", {"invigilator": p, "date": d, "duties": n})
    if duty:
        loads = [len(v) for v in duty.values()]
        A.stats["invigilators"] = len(duty)
        A.stats["duty_min_max"] = (min(loads), max(loads))
        if max(loads) - min(loads) > 3:
            A.s("W4_uneven_invigilation_load", {"min": min(loads), "max": max(loads)})
    return A


def run_audit(export_path, schedule_paths, layout_path=None, verify_path=None, excluded_codes=(),
              policies=None, turnover_min=30, max_per_day=2, inv_cap=2):
    export = json.load(open(export_path, encoding="utf-8"))
    schedules = {c: json.load(open(p, encoding="utf-8")) for c, p in schedule_paths.items() if p and Path(p).exists()}
    A, _ = audit_datesheets(export, schedules, excluded_codes, policies or {}, max_per_day=max_per_day)
    if layout_path and Path(layout_path).exists():
        layout = json.load(open(layout_path, encoding="utf-8"))
        verify = json.load(open(verify_path, encoding="utf-8")) if verify_path and Path(verify_path).exists() else None
        audit_seating(export, schedules, layout, verify, turnover_min=turnover_min, inv_cap=inv_cap, A=A)
    return A.result()
