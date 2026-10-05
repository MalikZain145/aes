"""
Why are theory sessions left unplaced 'despite spare rooms'?

Runs the meta pipeline, then for every UNPLACED theory session inspects EVERY
candidate (day, slot) against the FINAL timetable and records which hard
constraint blocks it there — teacher busy / batch (class) busy / student
overlap / no free room / HC7 (the course's other session already used that day).

A session is unplaced because EVERY cell is blocked; the constraint that blocks
(nearly) all of its cells is its real bottleneck.
"""
import argparse
from collections import Counter, defaultdict
import main as M
import metaheuristic as MH


def ctx_from_main():
    return MH.Ctx(
        DAYS=M.DAYS, THEORY_SLOTS=M.THEORY_SLOTS, THEORY_SLOTS_2H=M.THEORY_SLOTS_2H,
        LAB_SLOTS=M.LAB_SLOTS, SLOT_OVERLAP=M.SLOT_OVERLAP, ROOM_CAP=M.ROOM_CAP,
        ROOMS_BY_CAP=M.ROOMS_BY_CAP, LAB_CAP=M.LAB_CAP, ALL_LABS=M.ALL_LABS,
        TIGHT_FIT_RATIO=M.TIGHT_FIT_RATIO, is_tba=M.is_tba, norm_t=M.norm_t)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--data"); ap.add_argument("--seed", type=int, default=3)
    ap.add_argument("--time", type=float, default=20.0); a, _ = ap.parse_known_args()

    df, _ = (M.load_data_from_json(a.data) if a.data else M.load_data())
    courses = M.build_course_dicts(df)
    ctx = ctx_from_main()
    sessions, unplaced, stats = MH.solve(courses, ctx, seed=a.seed, tabu_time=a.time, vns_time=a.time)

    # rebuild final occupancy
    occ = MH.Occ(ctx); occ.allow_lab_theory = True
    for s in sessions:
        if s.place: occ.book(s, *s.place)

    theory_unpl = [s for s in unplaced if s.is_theory()]
    print(f"\nTotal sessions {stats['total']} · unplaced {len(unplaced)} "
          f"(theory {len(theory_unpl)}, lab {len(unplaced)-len(theory_unpl)})\n")

    verdicts = Counter()
    teacher_load = Counter()   # how many unplaced theory each teacher is behind
    batch_load = Counter()
    rows = []
    for U in theory_unpl:
        c = U.c
        cells = 0
        blocked = Counter()      # constraint -> #cells it blocks (independent)
        for d in ctx.DAYS:
            if d in occ.cdays[c["uid"]]:
                blocked["hc7_sameday"] += len(U.slots(ctx)); cells += len(U.slots(ctx)); continue
            for s in U.slots(ctx):
                cells += 1
                tb = not occ.teacher_free(c["teacher"], d, s)
                bb = not occ._free(occ.batch, c["batch_key"], d, s)
                sb = not occ.student_free(c, d, s)
                rb = occ.pick_room(c, d, s) is None
                if tb: blocked["teacher"] += 1
                if bb: blocked["batch"] += 1
                if sb: blocked["student"] += 1
                if rb and not (tb or bb or sb): blocked["no_room"] += 1
        # the bottleneck = the constraint blocking the most cells
        dom = blocked.most_common(1)[0][0] if blocked else "?"
        verdicts[dom] += 1
        if dom == "teacher": teacher_load[c["teacher"]] += 1
        if dom == "batch":   batch_load[c["batch_key"]] += 1
        rows.append((c["code"], c.get("section", ""), c["teacher"], c["batch_key"],
                     dom, blocked["teacher"], blocked["batch"], blocked["student"], cells))

    print("=" * 78)
    print("  WHY EACH UNPLACED THEORY SESSION IS STUCK  (dominant blocker)")
    print("=" * 78)
    label = {"teacher": "Teacher already busy in every free slot",
             "batch": "Class/batch already booked in every slot",
             "student": "Shared students clash in every slot",
             "hc7_sameday": "Course's other session used the only free days",
             "no_room": "No fitting room free", "?": "unknown"}
    for k, n in verdicts.most_common():
        print(f"   {n:>3}  ·  {label.get(k, k)}")
    print("-" * 78)
    if teacher_load:
        print("  Most overloaded teachers (unplaced theory blamed on them):")
        for t, n in teacher_load.most_common(6):
            print(f"      {n} session(s) · {t}")
    if batch_load:
        print("  Most saturated batches:")
        for b, n in batch_load.most_common(6):
            print(f"      {n} session(s) · {b}")
    print("-" * 78)
    print("  Sample (code/section · teacher · batch · blocker · blocked-cells T/B/S of total):")
    for r in rows[:12]:
        print(f"      {r[0]}{('-'+r[1]) if r[1] else ''}  ·  {r[2][:22]:<22}  ·  {r[3][:26]:<26}  "
              f"·  {r[4]:<8}  ·  T{r[5]}/B{r[6]}/S{r[7]} of {r[8]}")
    print("=" * 78)


if __name__ == "__main__":
    main()
