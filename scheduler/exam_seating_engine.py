"""
Abasyn Scheduler — Exam Seating Engine (v2)
==========================================

Provided by the exam office. Packs students into the FEWEST rooms (so fewer
invigilators are needed), keeps each course WHOLE in one room whenever it fits,
and splits a course only when it cannot fit a single room — then into EQUAL parts
(never 27 + 3). ~2 courses per room (a small 3rd only to top up leftover seats).

Seating model
-------------
A room has R rows; every row is a bench with 2 seats: LEFT ("7") and RIGHT ("7A").
Hard adjacency rule: the two students on one bench must not sit the same paper.
Guaranteed by the invariant: at most ONE block of any course per room, and no
block longer than R seats — bench partners are exactly R apart in the flat
column-major seat list, so a contiguous block of length ≤ R can never cover both
seats of one bench.

NOTE: `ROOMS` below is only a fallback. The live system passes the REAL room
inventory (from the database / Classes Report, including the Auditorium) into
`allocate_session` / `allocate_all`, so the true bench counts are always used.
"""

from __future__ import annotations
from collections import defaultdict
from dataclasses import dataclass, field
import math

# ---------------------------------------------------------------------------
# ROOM INVENTORY  (fallback only — the live system passes real rooms)
# ---------------------------------------------------------------------------
ROOMS: list[dict] = [
    {"name": "J214", "rows": 27, "verified": True},
    {"name": "J314", "rows": 27, "verified": True},
    {"name": "J312", "rows": 24, "verified": True},
    {"name": "J210", "rows": 18, "verified": True},
    {"name": "I209", "rows": 17, "verified": True},
    {"name": "I210", "rows": 17, "verified": True},
    {"name": "I208", "rows": 16, "verified": True},
    {"name": "I211", "rows": 15, "verified": False},
    {"name": "J301", "rows":  6, "verified": False},
    {"name": "I214", "rows":  4, "verified": False},
]

# How much breathing room to leave when picking rooms for a session.
# 0.00 = absolute minimum rooms (most packed, but the last small papers get cut);
# 0.05 = open ~1 extra room per session and keep far more papers whole.  <- default
PACKING_SLACK = 0.05


def room_capacity(room: dict) -> int:
    return room["rows"] * 2


# ---------------------------------------------------------------------------
# DATA MODEL
# ---------------------------------------------------------------------------
@dataclass
class Block:
    """A contiguous chunk of one course seated in one column of one room."""
    course: str
    students: list

    @property
    def size(self) -> int:
        return len(self.students)


@dataclass
class RoomPlan:
    name: str
    rows: int
    left: list = field(default_factory=list)
    right: list = field(default_factory=list)
    blocks: list = field(default_factory=list)

    def __post_init__(self):
        self.left = [None] * self.rows
        self.right = [None] * self.rows

    @property
    def used(self) -> int:
        return sum(x is not None for x in self.left) + sum(x is not None for x in self.right)

    @property
    def capacity(self) -> int:
        return self.rows * 2

    @property
    def fill_pct(self) -> float:
        return 100.0 * self.used / self.capacity if self.capacity else 0.0

    @property
    def courses(self) -> list:
        return sorted({b.course for b in self.blocks})


# ---------------------------------------------------------------------------
# STEP 1 — split a course into the FEWEST, MOST EQUAL blocks
# ---------------------------------------------------------------------------
def split_even(n: int, parts: int) -> list:
    """113 into 5 -> [23, 23, 23, 22, 22]. Never [27,27,27,27,5]."""
    base, extra = divmod(n, parts)
    return [base + 1] * extra + [base] * (parts - extra)


def make_blocks(course: str, students: list, max_col: int, forced_parts: int = 0) -> list:
    """One block if the course fits a single column, otherwise equal parts."""
    parts = forced_parts or max(1, math.ceil(len(students) / max_col))
    out, i = [], 0
    for size in split_even(len(students), parts):
        out.append(Block(course, students[i:i + size]))
        i += size
    return out


# ---------------------------------------------------------------------------
# STEP 2 — pick the smallest set of rooms that can hold the session
# ---------------------------------------------------------------------------
def choose_rooms(total: int, rooms: list, biggest_course: int = 0, prefer: str = "large") -> list:
    """Fewest rooms, then least wasted seats. Two capacity tests must pass:
    seats (rows*2) >= total students, and benches (rows) >= biggest single course
    (a course can never take both seats of one bench).

    prefer='large' (default) fills big halls first (BS/undergrad). prefer='small'
    fills the SMALLEST rooms first — used for the small Postgraduate cohort so MS
    lands in different rooms than BS, keeping the two apart on a shared day."""
    small = (prefer == "small")
    rooms = sorted(rooms, key=lambda r: (room_capacity(r) if small else -room_capacity(r)))
    for k in range(1, len(rooms) + 1):
        pick = rooms[:k]
        if sum(map(room_capacity, pick)) < total or sum(r["rows"] for r in pick) < biggest_course:
            continue
        if small:
            # Smallest rooms that fit — do NOT swap in bigger rooms (that would
            # pull MS back into the big halls BS uses).
            return sorted(pick, key=lambda r: room_capacity(r))
        best, best_waste = pick, sum(map(room_capacity, pick)) - total
        for swap_out in range(k):
            for cand in rooms[k:]:
                trial = pick[:swap_out] + [cand] + pick[swap_out + 1:]
                cap = sum(map(room_capacity, trial))
                ben = sum(r["rows"] for r in trial)
                if cap >= total and ben >= biggest_course and cap - total < best_waste:
                    best, best_waste = trial, cap - total
        return sorted(best, key=lambda r: -room_capacity(r))
    return sorted(rooms, key=lambda r: -room_capacity(r))   # shortfall -> caller reports


# ---------------------------------------------------------------------------
# STEP 3 — fill each room to 100%, one course at a time
# ---------------------------------------------------------------------------
def _waterfill(n: int, caps: list) -> list:
    """Spread n students over rooms whose usable sizes are `caps`, as EQUALLY as the
    rooms allow. 100 over [54,54] -> [50,50], never [54,46]."""
    k = len(caps)
    out = [0] * k
    left = n
    active = list(range(k))
    while left > 0 and active:
        share = max(1, left // len(active))
        for i in list(active):
            give = min(share, caps[i] - out[i], left)
            out[i] += give
            left -= give
            if out[i] == caps[i]:
                active.remove(i)
            if left == 0:
                break
    return out


def _assign_courses_to_rooms(enrollments: dict, chosen: list, max_courses: int = 0) -> tuple:
    """Decide WHICH paper sits in WHICH room. Per room: one paper may take at most
    `rows` seats and appear only ONCE. Biggest paper first; keep it whole if a room
    can take it (tightest fit), else spread it over the fewest rooms as evenly as
    those rooms allow. Prefers benching two courses of DIFFERENT programs.

    `max_courses` (>0) caps the distinct papers allowed in ONE room, so a room stays
    ~2 papers (+ a small 3rd) instead of collecting many small papers. When the cap
    would leave students unseated, `allocate_session` opens another room and retries.
    """
    free = {r["name"]: 2 * r["rows"] for r in chosen}
    rows = {r["name"]: r["rows"] for r in chosen}
    order = [r["name"] for r in chosen]
    layout = {n: [] for n in order}
    unseated = []

    def usable(room: str, course: str) -> int:
        if any(b.course == course for b in layout[room]):
            return 0
        if max_courses and len({b.course for b in layout[room]}) >= max_courses:
            return 0                                    # room already has its paper quota
        return min(free[room], rows[room])

    for course, studs in sorted(enrollments.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        n = len(studs)
        whole = [r for r in order if usable(r, course) >= n]
        if whole:
            r = min(whole, key=lambda x: (free[x], -rows[x]))
            layout[r].append(Block(course, list(studs)))
            free[r] -= n
            continue
        pool = sorted(((usable(r, course), r) for r in order if usable(r, course) > 0),
                      key=lambda t: -t[0])
        k, run = 0, 0
        for cap, _ in pool:
            run += cap
            k += 1
            if run >= n:
                break
        picked = pool[:k]
        shares = _waterfill(min(n, run), [c for c, _ in picked])
        i = 0
        for (cap, r), size in zip(picked, shares):
            if size <= 0:
                continue
            layout[r].append(Block(course, studs[i:i + size]))
            free[r] -= size
            i += size
        if i < n:
            unseated += studs[i:]
    return layout, unseated


def _seat_room(room: dict, blocks: list) -> RoomPlan:
    """Write the room's blocks onto benches, column-major:
        flat 0..R-1   -> bench 1..R LEFT  ("1", "2", ...)
        flat R..2R-1  -> bench 1..R RIGHT ("1A", "2A", ...)
    Bench partners are R apart and no block is longer than R, so a contiguous block
    can never put two students of one paper on one bench."""
    plan = RoomPlan(room["name"], room["rows"])
    R = plan.rows
    flat = []
    for b in sorted(blocks, key=lambda x: -x.size):
        plan.blocks.append(b)
        flat += [(b.course, s) for s in b.students]
    for i, cell in enumerate(flat[: 2 * R]):
        (plan.left if i < R else plan.right)[i % R] = cell
    return plan


def allocate_session(session: dict, enrollments: dict, rooms: list = None,
                     max_courses: int = 0, prefer: str = "large") -> dict:
    """session: {"session_id",...}; enrollments: {course_code: [student dict, ...]}.
    `max_courses` (>0) caps distinct papers per room (~2 + a small 3rd); if the cap
    leaves students unseated, the biggest unused rooms are opened until all fit.
    `prefer='small'` fills the smallest rooms first (Postgraduate — keeps MS out of
    the big halls BS occupies)."""
    rooms = rooms or ROOMS
    total = sum(len(v) for v in enrollments.values())
    biggest = max((len(v) for v in enrollments.values()), default=0)
    want = min(int(total * (1 + PACKING_SLACK)), sum(room_capacity(r) for r in rooms))
    chosen = choose_rooms(max(total, want), rooms, biggest, prefer=prefer)
    layout, unseated = _assign_courses_to_rooms(enrollments, chosen, max_courses)

    # Capping papers-per-room can leave a few students unseated → open ANOTHER room
    # and re-assign until everyone fits. BEST-FIT: pick the SMALLEST unused room that
    # holds the remaining students, so a tiny tail (e.g. 1 leftover student) opens a
    # 30-seat room, never the 80-seat Auditorium (which stays reserved for big
    # groups). Only when no single room fits the remainder do we open the biggest.
    if unseated and max_courses:
        used = {r["name"] for r in chosen}
        avail = [r for r in rooms if r["name"] not in used]
        while unseated and avail:
            need = len(unseated)
            fit = [r for r in avail if room_capacity(r) >= need]
            nxt = min(fit, key=room_capacity) if fit else max(avail, key=room_capacity)
            avail.remove(nxt)
            chosen = chosen + [nxt]
            layout, unseated = _assign_courses_to_rooms(enrollments, chosen, max_courses)

    plans = []
    for room in chosen:
        blocks = layout[room["name"]]
        if blocks:
            plans.append(_seat_room(room, blocks))
    return {
        "session": session,
        "rooms": plans,
        "unseated": unseated,
        "total_students": total,
        "capacity_offered": sum(room_capacity(r) for r in chosen),
    }


def allocate_all(date_sheet: list, enrollments: list, rooms: list = None) -> list:
    """date_sheet: [{"session_id","date","day","time","courses":[...]}, ...] -> ONE
    result per session_id (never merged). enrollments: [{"sid","name","prog",...}]."""
    rooms = rooms or ROOMS
    by_course = defaultdict(list)
    for e in enrollments:
        by_course[e["course"]].append(e)
    for c in by_course:
        by_course[c].sort(key=lambda s: (s.get("prog", ""), s.get("batch", ""), s.get("sid", "")))
    out = []
    for sess in date_sheet:
        enr = {c: list(by_course.get(c, [])) for c in sess["courses"] if by_course.get(c)}
        out.append(allocate_session(sess, enr, rooms))
    return out


# ---------------------------------------------------------------------------
# STEP 4 — validation
# ---------------------------------------------------------------------------
def validate(plan: list, enrollments: list) -> list:
    issues = []
    seated = set()
    for sp in plan:
        sid_here = set()
        for rp in sp["rooms"]:
            if rp.used > rp.capacity:
                issues.append(f"{sp['session']['session_id']} {rp.name}: over capacity")
            for i in range(rp.rows):
                l, r = rp.left[i], rp.right[i]
                if l and r and l[0] == r[0]:
                    issues.append(f"{sp['session']['session_id']} {rp.name} row {i+1}: same paper on one bench ({l[0]})")
                for cell in (l, r):
                    if cell:
                        key = (cell[1]["sid"], cell[0])
                        if key in seated:
                            issues.append(f"duplicate seat for {cell[1]['sid']} / {cell[0]}")
                        seated.add(key)
                        if cell[1]["sid"] in sid_here:
                            issues.append(f"{sp['session']['session_id']}: {cell[1]['sid']} seated twice in one session")
                        sid_here.add(cell[1]["sid"])
        for s in sp["unseated"]:
            issues.append(f"{sp['session']['session_id']}: NO SEAT for {s['sid']} ({s['course']})")
    expected = {(e["sid"], e["course"]) for e in enrollments}
    for miss in expected - seated:
        issues.append(f"registered but never seated: {miss[0]} / {miss[1]}")
    return issues
