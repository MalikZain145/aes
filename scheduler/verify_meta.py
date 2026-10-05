"""
Independent audit of the meta pipeline (greedy → Tabu → VNS).

Runs the full solver, then re-scans the FINAL timetable FROM SCRATCH — not
trusting the solver's own booking — and checks every hard/soft constraint by
brute force over all session pairs:

  HARD   teacher clash · theory-room clash · lab clash · batch clash ·
         student clash · room/lab capacity · HC7 (a course's two theory
         sessions on different days) · HC8 (theory in a lab room's overlapping
         time) · lectures only in theory slots, labs only in lab slots.

Two sessions conflict when they are on the SAME day and their time windows
OVERLAP (via SLOT_OVERLAP) and they share the resource.
"""
import time
import main as M
import metaheuristic as MH


def audit(sessions, ctx):
    placed = [s for s in sessions if s.place]
    issues = {k: [] for k in
              ["teacher", "room", "lab", "batch", "student", "cap", "hc7", "hc8", "slotkind"]}

    # bucket by day → for O(pairs-per-day) scanning
    by_day = {}
    for s in placed:
        by_day.setdefault(s.place[0], []).append(s)

    THEORY = set(ctx.THEORY) | set(ctx.THEORY2H)
    LAB = set(ctx.LAB)

    for d, day_sessions in by_day.items():
        for i in range(len(day_sessions)):
            A = day_sessions[i]; da, sa, ra = A.place; ca = A.c
            # slot-kind sanity
            if A.kind == "L" and sa not in LAB: issues["slotkind"].append((A, "lab not in lab slot"))
            if A.kind != "L" and sa not in THEORY: issues["slotkind"].append((A, "theory not in theory slot"))
            # capacity (a theory class may sit in a classroom OR a borrowed lab room)
            cap = ctx.ROOM_CAP.get(ra, ctx.LAB_CAP.get(ra, 0))
            if ca.get("enrolled", 0) > cap:
                issues["cap"].append((A, f"{ca.get('enrolled')}/{cap} in {ra}"))
            for j in range(i + 1, len(day_sessions)):
                B = day_sessions[j]; db, sb, rb = B.place; cb = B.c
                if sb not in ctx.OVL[sa]:
                    continue                       # time windows don't overlap → no conflict
                # teacher
                if (not ctx.is_tba(ca["teacher"]) and not ctx.is_tba(cb["teacher"])
                        and ctx.norm_t(ca["teacher"]) == ctx.norm_t(cb["teacher"])):
                    issues["teacher"].append((A, B))
                # room / lab (same physical room)
                if ra == rb:
                    (issues["lab"] if (A.kind == "L" and B.kind == "L") else issues["room"]).append((A, B))
                # HC8: one is a theory class sitting in a room that the other uses as a lab
                if ra == rb and ((A.kind == "L") != (B.kind == "L")):
                    issues["hc8"].append((A, B))
                # batch
                if ca["batch_key"] == cb["batch_key"]:
                    issues["batch"].append((A, B))
                # student (shared real student)
                if ca.get("students") and cb.get("students") and (ca["students"] & cb["students"]):
                    issues["student"].append((A, B))

    # HC7 — a course's two theory sessions must be on different days
    days_of = {}
    for s in placed:
        if s.is_theory():
            days_of.setdefault(s.c["uid"], []).append(s.place[0])
    for uid, days in days_of.items():
        if len(days) != len(set(days)):
            issues["hc7"].append(uid)

    return issues, len(placed), len(sessions)


def main():
    import argparse, random
    ap = argparse.ArgumentParser()
    ap.add_argument("--data"); ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--time", type=float, default=15.0)
    a, _ = ap.parse_known_args()

    print("Loading dataset …")
    if a.data:
        df, _ = M.load_data_from_json(a.data)
    else:
        df, _ = M.load_data()
    courses = M.build_course_dicts(df)
    ctx = MH.Ctx(
        DAYS=M.DAYS, THEORY_SLOTS=M.THEORY_SLOTS, THEORY_SLOTS_2H=M.THEORY_SLOTS_2H,
        LAB_SLOTS=M.LAB_SLOTS, SLOT_OVERLAP=M.SLOT_OVERLAP, ROOM_CAP=M.ROOM_CAP,
        ROOMS_BY_CAP=M.ROOMS_BY_CAP, LAB_CAP=M.LAB_CAP, ALL_LABS=M.ALL_LABS,
        TIGHT_FIT_RATIO=M.TIGHT_FIT_RATIO, is_tba=M.is_tba, norm_t=M.norm_t)

    print("Solving  (greedy → Tabu → VNS) …")
    t0 = time.time()
    sessions, unplaced, stats = MH.solve(courses, ctx, seed=a.seed,
                                         tabu_time=a.time, vns_time=a.time)
    dt = time.time() - t0
    print(f"  sessions {stats['total']}   unplaced: init {stats['after_init']} "
          f"→ Tabu {stats['after_tabu']} → VNS {stats['after_vns']} "
          f"→ Chains {stats['after_chain']}   ({dt:.1f}s)")
    print(f"  ejection chains placed {stats['placed_by_chain']} more session(s)\n")

    th_un = sum(1 for s in unplaced if s.is_theory()); lb_un = sum(1 for s in unplaced if s.kind == "L")
    print(f"  unplaced breakdown → theory {th_un}, lab {lb_un}\n")

    issues, placed, total = audit(sessions, ctx)

    print("=" * 66)
    print("  INDEPENDENT CONSTRAINT AUDIT  (re-scanned from scratch)")
    print("=" * 66)
    labels = [
        ("teacher", "Teacher double-booking"),
        ("room",    "Theory-room double-booking"),
        ("lab",     "Lab-room double-booking"),
        ("batch",   "Batch (class) double-booking"),
        ("student", "Student double-booking"),
        ("cap",     "Room/Lab capacity"),
        ("hc7",     "Same course: two theory sessions same day"),
        ("hc8",     "Theory class overlapping a lab room"),
        ("slotkind","Lecture-in-theory-slot / lab-in-lab-slot"),
    ]
    all_ok = True
    for key, name in labels:
        n = len(issues[key])
        mark = "PASS" if n == 0 else f"FAIL ({n})"
        if n: all_ok = False
        print(f"  [{mark:>8}]  {name}")
    print("-" * 66)
    print(f"  placed {placed}/{total}  ({100*placed/total:.2f}%)   unplaced {total-placed}")
    print("=" * 66)
    print("  ✓ ALL HARD CONSTRAINTS SATISFIED — 0 clashes/overlaps." if all_ok
          else "  ✗ Some constraints violated — see counts above.")
    print("=" * 66)


if __name__ == "__main__":
    main()
