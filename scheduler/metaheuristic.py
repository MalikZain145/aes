"""
Metaheuristic timetable improver — the pipeline

    greedy initial feasible  →  Tabu Search  →  Variable Neighbourhood Search

All three keep the SAME overlap-aware hard constraints (teacher / room / lab /
batch / student no double-book, capacity, a course's two theory sessions on
different days). Tabu first squeezes in the sessions the greedy build left
unplaced; VNS then places whatever remains. Clashes stay 0 by construction.

This module has NO dependency on main.py — the engine passes a `Ctx` describing
its live slots / rooms / labs (which may have been overridden by the DB export),
so the solver always uses the same tables the rest of the engine does.
"""
import time, random
from collections import defaultdict


class Ctx:
    """Everything the solver needs from the host engine."""
    def __init__(self, *, DAYS, THEORY_SLOTS, THEORY_SLOTS_2H, LAB_SLOTS, SLOT_OVERLAP,
                 ROOM_CAP, ROOMS_BY_CAP, LAB_CAP, ALL_LABS, TIGHT_FIT_RATIO, is_tba, norm_t):
        self.DAYS = DAYS; self.THEORY = THEORY_SLOTS; self.THEORY2H = THEORY_SLOTS_2H
        self.LAB = LAB_SLOTS; self.OVL = SLOT_OVERLAP
        self.ROOM_CAP = ROOM_CAP; self.ROOMS_BY_CAP = ROOMS_BY_CAP
        self.LAB_CAP = LAB_CAP; self.ALL_LABS = ALL_LABS; self.TIGHT = TIGHT_FIT_RATIO
        self.is_tba = is_tba; self.norm_t = norm_t
        self._labs_flat = sorted({lb for pool in ALL_LABS.values() for lb in pool},
                                 key=lambda lb: LAB_CAP.get(lb, 999))
    def labs_flat(self): return self._labs_flat


# ── session model ─────────────────────────────────────────────────────────────
class Session:
    __slots__ = ("sid", "c", "kind", "place")
    def __init__(self, sid, c, kind):
        self.sid, self.c, self.kind, self.place = sid, c, kind, None
    def is_theory(self): return self.kind != "L"
    def slots(self, ctx):
        return ctx.THEORY2H if self.kind == "T2" else (ctx.LAB if self.kind == "L" else ctx.THEORY)


def expand_sessions(courses):
    out, sid = [], 0
    for c in courses:
        if c["component"] == "Lab":
            out.append(Session(sid, c, "L")); sid += 1
        elif c.get("theory_2h"):
            out.append(Session(sid, c, "T2")); sid += 1
        elif int(c.get("n_theory", 2)) == 1:
            out.append(Session(sid, c, "T1")); sid += 1
        else:
            out.append(Session(sid, c, "T")); sid += 1
            out.append(Session(sid, c, "T")); sid += 1
    return out


# ── occupancy (identical hard constraints, with move/undo for the search) ─────
class Occ:
    def __init__(self, ctx):
        self.x = ctx
        self.teacher = defaultdict(set); self.room = defaultdict(set)
        self.lab = defaultdict(set); self.batch = defaultdict(set)
        self.students = defaultdict(set); self.cdays = defaultdict(set)
        self.at = defaultdict(list)
        # theory may borrow an idle lab room, but only once labs have claimed theirs
        # (enabled for the improvement phase, off during the first construction).
        self.allow_lab_theory = False

    def _free(self, busy, key, d, s):
        b = busy[key]
        return all((d, s2) not in b for s2 in self.x.OVL[s])
    def teacher_free(self, t, d, s):
        return True if self.x.is_tba(t) else self._free(self.teacher, self.x.norm_t(t), d, s)
    def student_free(self, c, d, s):
        st = c.get("students")
        if not st: return True
        return all(not (st & self.students[(d, s2)]) for s2 in self.x.OVL[s])

    def phys_free(self, r, d, s):
        """A physical room is free only if NEITHER a theory class NOR a lab session
        occupies it in any overlapping time window — this makes HC8 automatic and
        lets a theory class safely borrow a lab room (and vice-versa)."""
        b1 = self.room[r]; b2 = self.lab[r]
        return all((d, s2) not in b1 and (d, s2) not in b2 for s2 in self.x.OVL[s])

    def _tight_pick(self, names, capmap, en, d, s):
        if en <= 0:
            for rm in names:
                if self.phys_free(rm, d, s): return rm
            return None
        tl = en * (1 + self.x.TIGHT)
        for rm in names:
            cap = capmap.get(rm, 0)
            if en <= cap <= tl and self.phys_free(rm, d, s): return rm
        for rm in names:
            if capmap.get(rm, 0) >= en and self.phys_free(rm, d, s): return rm
        return None

    def pick_room(self, c, d, s):
        en = c.get("enrolled", 0)
        rm = self._tight_pick(self.x.ROOMS_BY_CAP, self.x.ROOM_CAP, en, d, s)
        if rm is None and self.allow_lab_theory:   # HC8-safe fallback into an idle lab room
            rm = self._tight_pick(self.x.labs_flat(), self.x.LAB_CAP, en, d, s)
        return rm

    def pick_lab(self, c, d, s):
        en = c.get("enrolled", 0); lc = self.x.LAB_CAP
        for pool in (c["lab_pool"], self.x.labs_flat()):
            tl = en * (1 + self.x.TIGHT)
            for lb in pool:
                cap = lc.get(lb, 999)
                if en <= cap <= tl and self.phys_free(lb, d, s): return lb
            for lb in pool:
                if lc.get(lb, 999) >= en and self.phys_free(lb, d, s): return lb
        return None

    def cap_of(self, room):
        return self.x.ROOM_CAP.get(room, self.x.LAB_CAP.get(room, 0))

    def feasible(self, sess, d, s, room):
        c = sess.c
        if sess.is_theory() and d in self.cdays[c["uid"]]: return False   # HC7
        if not self.teacher_free(c["teacher"], d, s): return False
        if not self._free(self.batch, c["batch_key"], d, s): return False
        if not self.student_free(c, d, s): return False
        return self.phys_free(room, d, s) and self.cap_of(room) >= c.get("enrolled", 0)

    def book(self, sess, d, s, room):
        c = sess.c
        if not self.x.is_tba(c["teacher"]): self.teacher[self.x.norm_t(c["teacher"])].add((d, s))
        self.batch[c["batch_key"]].add((d, s))
        if c.get("students"): self.students[(d, s)] |= c["students"]
        (self.lab if sess.kind == "L" else self.room)[room].add((d, s))
        if sess.is_theory(): self.cdays[c["uid"]].add(d)
        self.at[(d, s)].append(sess); sess.place = (d, s, room)

    def unbook(self, sess):
        d, s, room = sess.place; c = sess.c
        if not self.x.is_tba(c["teacher"]): self.teacher[self.x.norm_t(c["teacher"])].discard((d, s))
        self.batch[c["batch_key"]].discard((d, s))
        if c.get("students"): self.students[(d, s)] -= c["students"]
        (self.lab if sess.kind == "L" else self.room)[room].discard((d, s))
        if sess.is_theory(): self.cdays[c["uid"]].discard(d)
        try: self.at[(d, s)].remove(sess)
        except ValueError: pass
        sess.place = None

    def try_place(self, sess):
        c = sess.c
        for d in self.x.DAYS:
            if sess.is_theory() and d in self.cdays[c["uid"]]: continue
            for s in sess.slots(self.x):
                room = self.pick_lab(c, d, s) if sess.kind == "L" else self.pick_room(c, d, s)
                if room and self.feasible(sess, d, s, room):
                    self.book(sess, d, s, room); return True
        return False

    def blockers(self, sess, d, s):
        c = sess.c; found = set()
        for s2 in self.x.OVL[s]:
            for P in self.at.get((d, s2), []):
                if P is sess: continue
                pc = P.c
                shareT = (not self.x.is_tba(pc["teacher"])) and self.x.norm_t(pc["teacher"]) == self.x.norm_t(c["teacher"])
                shareB = pc["batch_key"] == c["batch_key"]
                shareS = bool(c.get("students") and pc.get("students") and (c["students"] & pc["students"]))
                if shareT or shareB or shareS: found.add(P)
        return found


# ── shared moves / local search ───────────────────────────────────────────────
class Improver:
    def __init__(self, occ, sessions, ctx, rng):
        self.occ = occ; self.sessions = sessions; self.x = ctx; self.rng = rng

    def relocate(self, P, avoid):
        occ = self.occ; c = P.c
        for d in self.x.DAYS:
            if P.is_theory() and d in occ.cdays[c["uid"]]: continue
            for s in P.slots(self.x):
                if (d, s) == avoid: continue
                room = occ.pick_lab(c, d, s) if P.kind == "L" else occ.pick_room(c, d, s)
                if room and occ.feasible(P, d, s, room):
                    occ.book(P, d, s, room); return True
        return False

    def place_or_eject(self, U, tabu=None, it=0, tenure=0, unplaced_len=0, best=1 << 30):
        occ = self.occ
        if occ.try_place(U): return True
        c = U.c
        for d in self.x.DAYS:
            if U.is_theory() and d in occ.cdays[c["uid"]]: continue
            for s in U.slots(self.x):
                room = occ.pick_lab(c, d, s) if U.kind == "L" else occ.pick_room(c, d, s)
                if room is None: continue
                blk = occ.blockers(U, d, s)
                if len(blk) != 1: continue
                P = next(iter(blk))
                if tabu is not None:
                    aspires = (unplaced_len - 1) < best
                    if tabu.get(P.sid, 0) > it and not aspires: continue
                saved = P.place; occ.unbook(P)
                if self.relocate(P, avoid=(d, s)) and occ.feasible(U, d, s, room):
                    occ.book(U, d, s, room)
                    if tabu is not None: tabu[P.sid] = it + tenure
                    return True
                if P.place: occ.unbook(P)
                occ.book(P, *saved)
        return False

    def random_place(self, P):
        occ = self.occ; c = P.c
        days = list(self.x.DAYS); self.rng.shuffle(days)
        slots = list(P.slots(self.x)); self.rng.shuffle(slots)
        for d in days:
            if P.is_theory() and d in occ.cdays[c["uid"]]: continue
            for s in slots:
                room = occ.pick_lab(c, d, s) if P.kind == "L" else occ.pick_room(c, d, s)
                if room and occ.feasible(P, d, s, room):
                    occ.book(P, d, s, room); return True
        return False

    # ── multi-level ejection chains ───────────────────────────────────────────
    # A cheap undo-log (record the inverse of every move) lets a chain explore
    # "evict P → move P's blocker Q → move Q's blocker …" up to `depth` and cleanly
    # roll back a dead-end branch in O(moves), no full-state snapshots.
    def _undo_to(self, log, mark):
        occ = self.occ
        while len(log) > mark:
            act = log.pop()
            if act[0] == "unbook":
                occ.unbook(act[1])
            else:                                   # ("book", sess, (d, s, room))
                occ.book(act[1], act[2][0], act[2][1], act[2][2])

    def _pick_at(self, U, d, s):
        return self.occ.pick_lab(U.c, d, s) if U.kind == "L" else self.occ.pick_room(U.c, d, s)

    def _cells(self, U):
        occ = self.occ; c = U.c; out = []
        for d in self.x.DAYS:
            if U.is_theory() and d in occ.cdays[c["uid"]]: continue
            for s in U.slots(self.x):
                out.append((d, s))
        return out

    def _relocate_avoiding(self, P, avoid_day, avoid_slots, log):
        """Place P at any feasible cell that is NOT on avoid_day within avoid_slots,
        so P truly vacates the region the parent needs."""
        occ = self.occ; c = P.c
        for d in self.x.DAYS:
            if P.is_theory() and d in occ.cdays[c["uid"]]: continue
            for s in P.slots(self.x):
                if d == avoid_day and s in avoid_slots:
                    continue
                room = self._pick_at(P, d, s)
                if room and occ.feasible(P, d, s, room):
                    occ.book(P, d, s, room); log.append(("unbook", P)); return True
        return False

    def _chain_into(self, U, d, s, depth, forbidden, log):
        """Try to place U specifically at (d, s): directly, else evict the single
        blocker and move it OUT of U's overlap region — directly or by chaining it
        into another cell (multi-level). Every dead-end branch is rolled back."""
        occ = self.occ
        room = self._pick_at(U, d, s)
        if room and occ.feasible(U, d, s, room):
            occ.book(U, d, s, room); log.append(("unbook", U)); return True
        if room is None:
            return False                            # room-bound — nothing to eject
        blk = occ.blockers(U, d, s)
        if len(blk) != 1:
            return False                            # only single-blocker cells are chainable
        P = next(iter(blk))
        if P in forbidden:
            return False
        mark = len(log); saved = P.place
        occ.unbook(P); log.append(("book", P, saved))
        avoid = self.x.OVL[s]
        moved = self._relocate_avoiding(P, d, avoid, log)
        if not moved and depth > 0:
            for (pd, ps) in self._chainable_cells(P, avoid_day=d, avoid_slots=avoid, limit=6):
                if self._chain_into(P, pd, ps, depth - 1, forbidden | {U}, log):
                    moved = True; break
        if moved:
            room = self._pick_at(U, d, s)
            if room and occ.feasible(U, d, s, room):
                occ.book(U, d, s, room); log.append(("unbook", U)); return True
        self._undo_to(log, mark)
        return False

    def _chainable_cells(self, P, avoid_day, avoid_slots, limit):
        """Cells P could be chained into: room free, exactly one blocker, and not in
        the region we must keep clear for the parent."""
        occ = self.occ; c = P.c; out = []
        for d in self.x.DAYS:
            if P.is_theory() and d in occ.cdays[c["uid"]]: continue
            for s in P.slots(self.x):
                if d == avoid_day and s in avoid_slots:
                    continue
                if self._pick_at(P, d, s) is None:
                    continue
                if len(occ.blockers(P, d, s)) == 1:
                    out.append((d, s))
                    if len(out) >= limit:
                        return out
        return out

    def chain_place(self, U, max_depth):
        for (d, s) in self._cells(U):
            if self._chain_into(U, d, s, max_depth, {U}, []):
                return True
        return False

    def snapshot(self): return {s.sid: s.place for s in self.sessions if s.place}
    def restore(self, snap):
        for s in self.sessions:
            if s.place: self.occ.unbook(s)
        for s in self.sessions:
            p = snap.get(s.sid)
            if p: self.occ.book(s, *p)
        return [s for s in self.sessions if not s.place]


def _order(sessions, rng):
    theory = [s for s in sessions if s.is_theory()]
    labs = [s for s in sessions if s.kind == "L"]
    rng.shuffle(theory); rng.shuffle(labs)
    labs.sort(key=lambda s: -s.c.get("enrolled", 0))
    return theory + labs


def initial_feasible(sessions, ctx, restarts=3, seed=1):
    """CSP construction — best of a few greedy feasible builds."""
    best, best_un = None, None
    for i in range(restarts):
        for s in sessions: s.place = None
        occ = Occ(ctx); rng = random.Random(seed + i); un = []
        for sess in _order(sessions, rng):
            if not occ.try_place(sess): un.append(sess)
        if best_un is None or len(un) < len(best_un):
            best = {s.sid: s.place for s in sessions if s.place}; best_un = un
    for s in sessions: s.place = None
    occ = Occ(ctx)
    for s in sessions:
        p = best.get(s.sid)
        if p: occ.book(s, *p)
    return occ, [s for s in sessions if not s.place]


def tabu_improve(sessions, occ, unplaced, ctx, time_limit=20.0, tenure=15, seed=1):
    """Place the still-unplaced sessions via single-ejection moves with tabu memory."""
    occ.allow_lab_theory = True                  # stubborn theory may borrow idle lab rooms
    unplaced = sorted(unplaced, key=lambda s: 0 if s.kind == "L" else 1)   # labs first (scarcer)
    imp = Improver(occ, sessions, ctx, random.Random(seed))
    tabu = {}; best = len(unplaced); best_place = imp.snapshot()
    t0 = time.time(); it = 0; ptr = 0; stall = 0; MAXIT = 200000
    while it < MAXIT and unplaced and (time.time() - t0) < time_limit:
        it += 1
        U = unplaced[ptr % len(unplaced)]
        if imp.place_or_eject(U, tabu=tabu, it=it, tenure=tenure, unplaced_len=len(unplaced), best=best):
            unplaced.remove(U); stall = 0
        else:
            ptr += 1; stall += 1
        if len(unplaced) < best:
            best = len(unplaced); best_place = imp.snapshot(); stall = 0
        if stall >= max(8, len(unplaced)):
            placed = [s for s in sessions if s.place]
            for P in imp.rng.sample(placed, min(5, len(placed))):
                saved = P.place; occ.unbook(P)
                if not imp.random_place(P): occ.book(P, *saved)
            stall = 0
    unplaced = imp.restore(best_place)
    return occ, unplaced, it


def vns_improve(sessions, occ, unplaced, ctx, time_limit=20.0, k_max=6, seed=1):
    """Variable Neighbourhood Search: shake in N_k (disturb 4k sessions), local-search,
    accept-and-reset or widen the neighbourhood."""
    occ.allow_lab_theory = True
    unplaced = list(unplaced)
    imp = Improver(occ, sessions, ctx, random.Random(seed))
    t0 = time.time(); it = 0

    def local_search():
        improved = True
        while improved and unplaced and (time.time() - t0) < time_limit:
            improved = False
            for U in sorted(unplaced, key=lambda s: 0 if s.kind == "L" else 1):  # labs first
                if imp.place_or_eject(U):
                    unplaced.remove(U); improved = True

    local_search()
    best = len(unplaced); best_place = imp.snapshot()
    while unplaced and (time.time() - t0) < time_limit:
        k = 1
        while k <= k_max and (time.time() - t0) < time_limit:
            it += 1
            placed = [s for s in sessions if s.place]
            if placed:
                for P in imp.rng.sample(placed, min(len(placed), k * 4)):
                    occ.unbook(P)
                    if not imp.random_place(P): unplaced.append(P)
            local_search()
            if len(unplaced) < best:
                best = len(unplaced); best_place = imp.snapshot(); k = 1
            else:
                unplaced[:] = imp.restore(best_place); k += 1
    unplaced[:] = imp.restore(best_place)
    return occ, unplaced, it


def chain_repair(sessions, occ, unplaced, ctx, max_depth=3, time_limit=15.0, seed=1):
    """Final pass: try to place each still-unplaced session with a multi-level
    ejection chain (depth-limited). Placements the single-move improvers couldn't
    reach are unlocked by cascading several sessions aside — all clash-validated."""
    occ.allow_lab_theory = True
    imp = Improver(occ, sessions, ctx, random.Random(seed))
    order = sorted(unplaced, key=lambda s: 0 if s.kind == "L" else 1)   # labs first
    t0 = time.time(); placed_more = 0; remaining = []
    for U in order:
        if (time.time() - t0) >= time_limit:
            remaining.append(U); continue
        if imp.chain_place(U, max_depth):
            placed_more += 1
        else:
            remaining.append(U)
    return occ, remaining, placed_more


def solve(courses, ctx, seed=1, tabu_time=20.0, vns_time=20.0, init_restarts=3,
          chain_depth=3, chain_time=15.0):
    """Full pipeline: greedy → Tabu → VNS → multi-level ejection-chain repair.
    Returns (sessions, unplaced_sessions, stats)."""
    sessions = expand_sessions(courses)
    occ, unplaced = initial_feasible(sessions, ctx, restarts=init_restarts, seed=seed)
    n_init = len(unplaced)
    occ, unplaced, tabu_it = tabu_improve(sessions, occ, unplaced, ctx, time_limit=tabu_time, seed=seed)
    n_after_tabu = len(unplaced)
    occ, unplaced, vns_it = vns_improve(sessions, occ, unplaced, ctx, time_limit=vns_time, seed=seed)
    n_after_vns = len(unplaced)
    placed_by_chain = 0
    if chain_depth and unplaced:
        occ, unplaced, placed_by_chain = chain_repair(
            sessions, occ, unplaced, ctx, max_depth=chain_depth, time_limit=chain_time, seed=seed)
    stats = {"total": len(sessions), "after_init": n_init,
             "after_tabu": n_after_tabu, "after_vns": n_after_vns, "after_chain": len(unplaced),
             "tabu_iters": tabu_it, "vns_iters": vns_it, "placed_by_chain": placed_by_chain}
    return sessions, unplaced, stats
