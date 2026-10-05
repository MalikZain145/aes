"""
Experiment: an alternative timetable engine architecture

    Constraint model (CSP)  →  initial feasible solution
                            →  Tabu Search + Local Search (ejection moves)
                            →  clash minimisation

…run head-to-head against the current engine's strategy (a tuned greedy with
best-of-N random restarts) on the SAME data and the SAME hard constraints, so the
only thing that differs is the SEARCH strategy. Prints a side-by-side comparison.

Both strategies share:
  • the exact hard constraints of the real engine (all overlap-aware):
      HC1 teacher no double-book · HC3 batch no double-book · HC4/HC9 capacity
      HC5/HC6 lectures in theory slots / labs in lab slots · HC7 a course's two
      theory sessions on different days · student no double-book.
  • the same session model, room/lab pools and tight-fit room selection.
So clashes are 0 by construction for both; the real objective both are judged on
is UNPLACED sessions (a course losing a weekly session because no clash-free slot
was free). Fewer unplaced = higher-accuracy timetable.

Run:  python tabu_scheduler.py            (uses the bundled timetable-dataset.xlsx)
      python tabu_scheduler.py --data export.json   (a DB export, like the app)
"""
import os, sys, time, random, argparse
from collections import defaultdict

import main as M   # reuse the real engine's constants, loaders and course builder

DAYS            = M.DAYS
THEORY_SLOTS    = M.THEORY_SLOTS
THEORY_SLOTS_2H = M.THEORY_SLOTS_2H
LAB_SLOTS       = M.LAB_SLOTS
SLOT_OVERLAP    = M.SLOT_OVERLAP
TIGHT           = M.TIGHT_FIT_RATIO


def all_labs_flat():
    labs = {lb for pool in M.ALL_LABS.values() for lb in pool}
    return sorted(labs, key=lambda lb: M.LAB_CAP.get(lb, 999))


# ── session model ─────────────────────────────────────────────────────────────
class Session:
    __slots__ = ("sid", "c", "kind", "sibling", "place")
    def __init__(self, sid, c, kind):
        self.sid, self.c, self.kind, self.sibling, self.place = sid, c, kind, None, None
    def slots(self):
        return THEORY_SLOTS_2H if self.kind == "T2" else (LAB_SLOTS if self.kind == "L" else THEORY_SLOTS)
    def is_theory(self):
        return self.kind != "L"


def expand_sessions(courses):
    out, sid = [], 0
    for c in courses:
        if c["component"] == "Lab":
            out.append(Session(sid, c, "L")); sid += 1
        elif c.get("theory_2h"):
            out.append(Session(sid, c, "T2")); sid += 1
        elif int(c.get("n_theory", 2)) == 1:
            out.append(Session(sid, c, "T1")); sid += 1
        else:  # 3+ credit → two sessions on different days
            a = Session(sid, c, "T"); sid += 1
            b = Session(sid, c, "T"); sid += 1
            a.sibling, b.sibling = b, a
            out += [a, b]
    return out


# ── occupancy (identical hard constraints to the real engine) ─────────────────
class Occ:
    def __init__(self):
        self.teacher = defaultdict(set); self.room = defaultdict(set)
        self.lab = defaultdict(set); self.batch = defaultdict(set)
        self.students = defaultdict(set); self.cdays = defaultdict(set)
        self.at = defaultdict(list)   # (day,slot) → [session]  (for ejection lookups)

    def _free(self, busy, key, d, s):
        b = busy[key]
        return all((d, s2) not in b for s2 in SLOT_OVERLAP[s])
    def teacher_free(self, t, d, s):
        return True if M.is_tba(t) else self._free(self.teacher, M.norm_t(t), d, s)
    def batch_free(self, b, d, s):  return self._free(self.batch, b, d, s)
    def room_free(self, r, d, s):   return self._free(self.room, r, d, s)
    def lab_free(self, lb, d, s):   return self._free(self.lab, lb, d, s)
    def student_free(self, c, d, s):
        st = c.get("students")
        if not st: return True
        return all(not (st & self.students[(d, s2)]) for s2 in SLOT_OVERLAP[s])

    def pick_room(self, c, d, s):
        en = c.get("enrolled", 0)
        if en <= 0:
            for rm in M.ROOMS_BY_CAP:
                if self.room_free(rm, d, s): return rm
            return None
        tl = en * (1 + TIGHT)
        for rm in M.ROOMS_BY_CAP:
            cap = M.ROOM_CAP.get(rm, 0)
            if en <= cap <= tl and self.room_free(rm, d, s): return rm
        for rm in M.ROOMS_BY_CAP:
            if M.ROOM_CAP.get(rm, 0) >= en and self.room_free(rm, d, s): return rm
        return None

    def pick_lab(self, c, d, s):
        en = c.get("enrolled", 0)
        for pool in (c["lab_pool"], all_labs_flat()):
            tl = en * (1 + TIGHT)
            for lb in pool:
                cap = M.LAB_CAP.get(lb, 999)
                if en <= cap <= tl and self.lab_free(lb, d, s): return lb
            for lb in pool:
                cap = M.LAB_CAP.get(lb, 999)
                if cap >= en and self.lab_free(lb, d, s): return lb
        return None

    def feasible(self, sess, d, s, room):
        """Assumes sess is currently UNBOOKED. Same hard checks as the engine."""
        c = sess.c
        if sess.is_theory() and d in self.cdays[c["uid"]]:
            return False                                   # HC7
        if not self.teacher_free(c["teacher"], d, s): return False
        if not self.batch_free(c["batch_key"], d, s): return False
        if not self.student_free(c, d, s): return False
        if sess.kind == "L":
            return self.lab_free(room, d, s) and M.LAB_CAP.get(room, 0) >= c.get("enrolled", 0)
        return self.room_free(room, d, s) and M.ROOM_CAP.get(room, 0) >= c.get("enrolled", 0)

    def book(self, sess, d, s, room):
        c = sess.c
        if not M.is_tba(c["teacher"]): self.teacher[M.norm_t(c["teacher"])].add((d, s))
        self.batch[c["batch_key"]].add((d, s))
        if c.get("students"): self.students[(d, s)] |= c["students"]
        (self.lab if sess.kind == "L" else self.room)[room].add((d, s))
        if sess.is_theory(): self.cdays[c["uid"]].add(d)
        self.at[(d, s)].append(sess)
        sess.place = (d, s, room)

    def unbook(self, sess):
        d, s, room = sess.place
        c = sess.c
        if not M.is_tba(c["teacher"]): self.teacher[M.norm_t(c["teacher"])].discard((d, s))
        self.batch[c["batch_key"]].discard((d, s))
        if c.get("students"): self.students[(d, s)] -= c["students"]
        (self.lab if sess.kind == "L" else self.room)[room].discard((d, s))
        if sess.is_theory(): self.cdays[c["uid"]].discard(d)
        try: self.at[(d, s)].remove(sess)
        except ValueError: pass
        sess.place = None

    def try_place(self, sess):
        c = sess.c
        for d in DAYS:
            if sess.is_theory() and d in self.cdays[c["uid"]]: continue
            for s in sess.slots():
                room = self.pick_lab(c, d, s) if sess.kind == "L" else self.pick_room(c, d, s)
                if room and self.feasible(sess, d, s, room):
                    self.book(sess, d, s, room); return True
        return False

    def blockers(self, sess, d, s):
        """The already-placed sessions that clash with `sess` at (d,s) on
        teacher / batch / student (the structural blockers ejection can move)."""
        c = sess.c; found = set()
        for s2 in SLOT_OVERLAP[s]:
            for P in self.at.get((d, s2), []):
                if P is sess: continue
                pc = P.c
                shareT = (not M.is_tba(pc["teacher"])) and M.norm_t(pc["teacher"]) == M.norm_t(c["teacher"])
                shareB = pc["batch_key"] == c["batch_key"]
                shareS = bool(c.get("students") and pc.get("students") and (c["students"] & pc["students"]))
                if shareT or shareB or shareS: found.add(P)
        return found


def build_order(sessions, shuffle, seed=None):
    theory = [s for s in sessions if s.is_theory()]
    labs = [s for s in sessions if s.kind == "L"]
    if shuffle:
        rng = random.Random(seed); rng.shuffle(theory); rng.shuffle(labs)
    labs.sort(key=lambda s: -s.c.get("enrolled", 0))   # biggest lab sections first
    return theory + labs


def greedy(sessions, order):
    for s in sessions: s.place = None
    occ = Occ(); unplaced = []
    for sess in order:
        if not occ.try_place(sess): unplaced.append(sess)
    return occ, unplaced


# ── Strategy A: current engine's approach — best-of-N random restarts ─────────
def strategy_greedy_restart(sessions, attempts=12, seed=1):
    best = None
    for i in range(attempts):
        order = build_order(sessions, shuffle=True, seed=seed + i)
        occ, unplaced = greedy(sessions, order)
        if best is None or len(unplaced) < best[1]:
            best = (occ, len(unplaced), i + 1)
        if not unplaced:
            return occ, 0, i + 1
    return best


# ── Strategy B: CSP feasible → Tabu Search + local search ─────────────────────
def strategy_tabu(sessions, max_iter=200000, time_limit=45.0, tenure=15,
                  init_restarts=3, seed=1):
    # CSP construction — take the best of a few feasible constructions as the start
    # (the "initial feasible timetable" the Tabu phase then improves).
    best_init, best_un = None, None
    for i in range(init_restarts):
        occ_i, un_i = greedy(sessions, build_order(sessions, shuffle=True, seed=seed + i))
        if best_un is None or len(un_i) < len(best_un):
            best_init = {s.sid: s.place for s in sessions if s.place}; best_un = un_i
    for s in sessions:
        if s.place: s.place = None
    occ = Occ()
    for s in sessions:
        p = best_init.get(s.sid)
        if p: occ.book(s, *p)
    unplaced = [s for s in sessions if not s.place]

    best_count = len(unplaced)
    best_place = dict(best_init)
    tabu = {}                                    # sid → iteration it is tabu until
    rng = random.Random(seed)
    t0 = time.time(); it = 0; ptr = 0; stall = 0

    def relocate(P, avoid):
        c = P.c
        for d in DAYS:
            if P.is_theory() and d in occ.cdays[c["uid"]]: continue
            for s in P.slots():
                if (d, s) == avoid: continue
                room = occ.pick_lab(c, d, s) if P.kind == "L" else occ.pick_room(c, d, s)
                if room and occ.feasible(P, d, s, room):
                    occ.book(P, d, s, room); return True
        return False

    def try_fix(U):
        """One Tabu step for a single unplaced session: direct place, else eject
        one blocker and place. Returns True if U got placed."""
        c = U.c
        if occ.try_place(U):
            return True
        for d in DAYS:
            if U.is_theory() and d in occ.cdays[c["uid"]]: continue
            for s in U.slots():
                room = occ.pick_lab(c, d, s) if U.kind == "L" else occ.pick_room(c, d, s)
                if room is None:
                    continue                     # room/capacity blocked — ejection can't help
                blk = occ.blockers(U, d, s)
                if len(blk) != 1:
                    continue
                P = next(iter(blk))
                aspires = (len(unplaced) - 1) < best_count
                if tabu.get(P.sid, 0) > it and not aspires:
                    continue
                saved = P.place
                occ.unbook(P)
                if relocate(P, avoid=(d, s)) and occ.feasible(U, d, s, room):
                    occ.book(U, d, s, room)
                    tabu[P.sid] = it + tenure
                    return True
                if P.place: occ.unbook(P)
                occ.book(P, *saved)              # revert
        return False

    while it < max_iter and unplaced and (time.time() - t0) < time_limit:
        it += 1
        U = unplaced[ptr % len(unplaced)]
        if try_fix(U):
            unplaced.remove(U); stall = 0
        else:
            ptr += 1; stall += 1

        if len(unplaced) < best_count:
            best_count = len(unplaced)
            best_place = {s.sid: s.place for s in sessions if s.place}
            stall = 0

        # stuck on the current unplaced set → diversify (kick a few placed sessions)
        if stall >= max(8, len(unplaced)):
            placed = [s for s in sessions if s.place]
            for P in rng.sample(placed, min(5, len(placed))):
                saved = P.place; occ.unbook(P)
                if not relocate(P, avoid=saved):
                    occ.book(P, *saved)
            stall = 0

    for s in sessions:
        if s.place: occ.unbook(s)
    occ2 = Occ()
    for s in sessions:
        p = best_place.get(s.sid)
        if p: occ2.book(s, *p)
    return occ2, best_count, it


# ── Strategy C: CSP feasible → Variable Neighbourhood Search + local search ───
def strategy_vns(sessions, time_limit=45.0, k_max=6, init_restarts=3, seed=1):
    # CSP construction — best of a few feasible constructions = the starting point.
    best_init, best_un = None, None
    for i in range(init_restarts):
        occ_i, un_i = greedy(sessions, build_order(sessions, shuffle=True, seed=seed + i))
        if best_un is None or len(un_i) < len(best_un):
            best_init = {s.sid: s.place for s in sessions if s.place}; best_un = un_i
    for s in sessions:
        s.place = None
    occ = Occ()
    for s in sessions:
        p = best_init.get(s.sid)
        if p: occ.book(s, *p)
    unplaced = [s for s in sessions if not s.place]
    rng = random.Random(seed)
    t0 = time.time(); iters = 0

    def relocate(P, avoid):
        c = P.c
        for d in DAYS:
            if P.is_theory() and d in occ.cdays[c["uid"]]: continue
            for s in P.slots():
                if (d, s) == avoid: continue
                room = occ.pick_lab(c, d, s) if P.kind == "L" else occ.pick_room(c, d, s)
                if room and occ.feasible(P, d, s, room):
                    occ.book(P, d, s, room); return True
        return False

    def place_or_eject(U):
        if occ.try_place(U):
            return True
        c = U.c
        for d in DAYS:
            if U.is_theory() and d in occ.cdays[c["uid"]]: continue
            for s in U.slots():
                room = occ.pick_lab(c, d, s) if U.kind == "L" else occ.pick_room(c, d, s)
                if room is None:
                    continue
                blk = occ.blockers(U, d, s)
                if len(blk) != 1:
                    continue
                P = next(iter(blk)); saved = P.place
                occ.unbook(P)
                if relocate(P, avoid=(d, s)) and occ.feasible(U, d, s, room):
                    occ.book(U, d, s, room); return True
                if P.place: occ.unbook(P)
                occ.book(P, *saved)
        return False

    def local_search():                          # descend to a local optimum
        improved = True
        while improved and unplaced and (time.time() - t0) < time_limit:
            improved = False
            for U in list(unplaced):
                if place_or_eject(U):
                    unplaced.remove(U); improved = True

    def random_place(P):                          # place P at a RANDOM feasible slot
        c = P.c; days = DAYS[:]; rng.shuffle(days); slots = P.slots()[:]; rng.shuffle(slots)
        for d in days:
            if P.is_theory() and d in occ.cdays[c["uid"]]: continue
            for s in slots:
                room = occ.pick_lab(c, d, s) if P.kind == "L" else occ.pick_room(c, d, s)
                if room and occ.feasible(P, d, s, room):
                    occ.book(P, d, s, room); return True
        return False

    def snapshot(): return {s.sid: s.place for s in sessions if s.place}
    def restore(snap):
        for s in sessions:
            if s.place: occ.unbook(s)
        for s in sessions:
            p = snap.get(s.sid)
            if p: occ.book(s, *p)
        return [s for s in sessions if not s.place]

    local_search()
    best_count = len(unplaced); best_place = snapshot()

    # VNS: neighbourhood N_k = "disturb 4k random sessions". Shake in N_k, local-search,
    # and if it improves, accept & reset k=1; otherwise widen the neighbourhood (k+1).
    while unplaced and (time.time() - t0) < time_limit:
        k = 1
        while k <= k_max and (time.time() - t0) < time_limit:
            iters += 1
            placed = [s for s in sessions if s.place]
            if placed:                            # SHAKING at strength k
                for P in rng.sample(placed, min(len(placed), k * 4)):
                    occ.unbook(P)
                    if not random_place(P):
                        unplaced.append(P)
            local_search()                        # LOCAL SEARCH
            if len(unplaced) < best_count:        # MOVE OR NOT
                best_count = len(unplaced); best_place = snapshot(); k = 1
            else:
                unplaced[:] = restore(best_place); k += 1

    unplaced[:] = restore(best_place)
    return occ, best_count, iters


# ── comparison runner ─────────────────────────────────────────────────────────
def load_courses():
    ap = argparse.ArgumentParser(); ap.add_argument("--data"); a, _ = ap.parse_known_args()
    if a.data:
        df, _ = M.load_data_from_json(a.data)
    else:
        df, _ = M.load_data()
    return M.build_course_dicts(df)


def summarise(sessions, occ, label):
    placed = [s for s in sessions if s.place]
    unpl = [s for s in sessions if not s.place]
    th_t = sum(1 for s in sessions if s.is_theory())
    lb_t = sum(1 for s in sessions if s.kind == "L")
    th_u = sum(1 for s in unpl if s.is_theory())
    lb_u = sum(1 for s in unpl if s.kind == "L")
    return {
        "label": label, "total": len(sessions), "placed": len(placed), "unplaced": len(unpl),
        "theory_unplaced": th_u, "lab_unplaced": lb_u, "theory_total": th_t, "lab_total": lb_t,
        "accuracy": 100.0 * len(placed) / max(1, len(sessions)),
    }


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--seed", type=int, default=20260911)
    ap.add_argument("--time", type=float, default=45.0); ap.add_argument("--attempts", type=int, default=12)
    args, _ = ap.parse_known_args()
    seed = args.seed
    random.seed(seed)
    print("Loading dataset & building courses …")
    courses = load_courses()
    sessions = expand_sessions(courses)
    n_th = sum(1 for s in sessions if s.is_theory()); n_lb = sum(1 for s in sessions if s.kind == "L")
    print(f"  courses: {len(courses)}   sessions: {len(sessions)}  (theory {n_th}, lab {n_lb})\n")

    # Strategy A — greedy + best-of-N restarts (what the app uses)
    t0 = time.time()
    occA, unA, attemptsA = strategy_greedy_restart(sessions, attempts=args.attempts, seed=seed)
    tA = time.time() - t0
    sumA = summarise(sessions, occA, "A) Greedy + best-of-12 restarts (current)")

    # Strategy B — CSP feasible init → Tabu Search + local search
    t0 = time.time()
    occB, unB, itersB = strategy_tabu(sessions, max_iter=200000, time_limit=args.time, tenure=15, seed=seed)
    tB = time.time() - t0
    sumB = summarise(sessions, occB, "B) CSP-init -> Tabu Search + local search")

    # Strategy C — CSP feasible init → Variable Neighbourhood Search + local search
    t0 = time.time()
    occC, unC, itersC = strategy_vns(sessions, time_limit=args.time, k_max=6, seed=seed)
    tC = time.time() - t0
    sumC = summarise(sessions, occC, "C) CSP-init -> Variable Neighbourhood Search")

    def line(s, extra):
        print(f"  {s['label']}")
        print(f"      placed {s['placed']}/{s['total']}  ({s['accuracy']:.2f}%)   "
              f"unplaced {s['unplaced']}  [theory {s['theory_unplaced']}, lab {s['lab_unplaced']}]   {extra}")

    print("=" * 74)
    print("  RESULT — same data, same hard constraints, three different searches")
    print("=" * 74)
    line(sumA, f"clashes 0 · {attemptsA} attempts · {tA:.2f}s")
    line(sumB, f"clashes 0 · {itersB} tabu iters · {tB:.2f}s")
    line(sumC, f"clashes 0 · {itersC} vns iters · {tC:.2f}s")
    print("-" * 74)
    rank = sorted([("Greedy(best-of-N)", sumA["unplaced"]),
                   ("Tabu Search", sumB["unplaced"]),
                   ("VNS", sumC["unplaced"])], key=lambda x: x[1])
    print("  Ranking (fewest unplaced = best):")
    for i, (name, u) in enumerate(rank, 1):
        print(f"      {i}. {name:<20} {u} unplaced  ({100*(sumA['total']-u)/sumA['total']:.2f}% placed)")
    print("-" * 74)
    print(f"  vs current greedy:  Tabu {sumA['unplaced']-sumB['unplaced']:+d} placed   "
          f"VNS {sumA['unplaced']-sumC['unplaced']:+d} placed")
    print(f"  VNS vs Tabu:        {sumB['unplaced']-sumC['unplaced']:+d} placed for VNS")
    print("=" * 74)


if __name__ == "__main__":
    main()
