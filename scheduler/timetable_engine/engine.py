"""
AUIC Timetable Engine  (theory now, labs-ready)
===============================================
Pipeline
  1. parse    : registration reports  -> courses, sections, teachers, students
  2. model    : THEORY / LAB / NON-CLASS classification, BS vs MS split (code level >= 500),
                credit hours -> weekly sessions, ghost-section merging
  3. section  : cohort-block student sectioning (+ floaters)
  4. solve    : CP-SAT (Google OR-Tools) constraint model per timetable (BS, MS)
  5. enrol    : floaters placed in clash-free sections (backtracking) + repair loop
  6. rooms    : per-slot min-cost bipartite matching (Hungarian) - capacity aware
  7. verify   : independent checker (rooms, teachers, every single student)
  8. export   : JSON (for the AMS, switchable BS/MS) + Excel views

Run:  python3 engine.py         (reads config.json, classwise.xls, students.xls)
"""
import json, re, math, collections, time, sys, os
import numpy as np
from scipy.optimize import linear_sum_assignment
from ortools.sat.python import cp_model
from parse import load_courses, load_students, norm_teacher

CFG = json.load(open('config.json'))
ROOMS = CFG['rooms']


# --------------------------------------------------------------------------- DB input
# The AMS drives this engine straight from its database (no Excel upload): the backend
# writes a `data.json` in the run folder with the SAME shape parse.py produces, and we
# load courses/students from it. This only changes where the inputs come from — the
# solver, sectioning, rooms and verification are untouched. Falls back to the two .xls
# reports when no data.json is present (standalone / CLI use still works).
def _courses_from_json(rows):
    out = []
    for c in rows:
        secs = []
        for s in (c.get('sections') or []):
            tk = s.get('tkey'); teacher = s.get('teacher')
            if teacher and not tk:
                nt = norm_teacher(teacher)
                if nt:
                    teacher, tk = nt
            secs.append({'label': (str(s.get('label') or '').strip() or 'A'),
                         'teacher': teacher, 'tkey': tk})
        out.append({'row': int(c.get('row') or 0), 'code': str(c['code']).strip(),
                    'title': str(c['title']).strip(), 'credits': float(c['credits']),
                    'nsec': int(c.get('nsec') or (len(secs) or 1)),
                    'enrolled': int(c.get('enrolled') or 0), 'sections': secs})
    return out


def _students_from_json(rows):
    out = []
    for s in rows:
        out.append({'name': s.get('name', ''), 'id': str(s['id']),
                    'program': s.get('program', ''), 'batch': s.get('batch', ''),
                    'courses': [tuple(x) for x in (s.get('courses') or [])]})
    return out

# --------------------------------------------------------------------------- 2. model
LAB_RE = re.compile(r'\(\s*lab\s*\)|\blab\b|optical laboratory', re.I)
NONCLASS_RE = re.compile(r'project|thesis|internship|supervised clinical|clinical practice|'
                         r'clinical rotation|clerkship|practicum|dissertation|field training|'
                         r'industrial training', re.I)
NONCLASS_EXEMPT = re.compile(r'project management|project communication|software project|'
                             r'project scope', re.I)
SPLIT_RE = re.compile(r'\((\d)\s*\+\s*(\d)\)')


def classify(title, credits):
    if LAB_RE.search(title):
        return 'LAB', 0
    if NONCLASS_RE.search(title) and not NONCLASS_EXEMPT.search(title):
        return 'NONCLASS', 0
    m = SPLIT_RE.search(title)
    if m:
        th = int(m.group(1))
    else:
        cr = int(round(credits))
        th = 3 if cr == 4 else cr                    # 4 cr = 3 theory + 1 lab
    if th <= 0:
        return 'LAB', 0
    if th > 3:
        return 'NONCLASS', 0
    return 'THEORY', th


def course_level(code):
    d = re.sub(r'\D', '', code)
    return int(d[:3]) if d else 0


def build(courses, students):
    pools = collections.OrderedDict()
    for c in courses:
        c['kind'], c['theory_cr'] = classify(c['title'], c['credits'])
        pools.setdefault((c['code'], c['title']), []).append(c)
    by_code = collections.defaultdict(list)
    for k in pools:
        by_code[k[0]].append(k)
    enrol = collections.defaultdict(list)
    for i, s in enumerate(students):
        s['cohort'] = f"{s['program']} | {s['batch']}"
        for code, title, cr in s['courses']:
            k = (code, title) if (code, title) in pools else by_code[code][0]
            enrol[k].append(i)

    offerings, log = [], collections.defaultdict(list)
    for k, rows in pools.items():
        kind = rows[0]['kind']
        nsec = sum(r['nsec'] for r in rows)
        if kind != 'THEORY':
            log[kind].append(f"{k[0]} {k[1]} ({nsec} sec)")
            continue
        secs = []
        for r in rows:
            per = r['enrolled'] / max(1, r['nsec'])
            for sc in r['sections']:
                secs.append({'teacher': sc['teacher'], 'tkey': sc['tkey'],
                             'theory_cr': r['theory_cr'], 'target': per})
        if any(s['target'] > 0 for s in secs):
            secs = [s for s in secs if s['target'] > 0]
        total = len(enrol.get(k, []))
        if total == 0:
            log['ZERO_ENROLLED'].append(f"{k[0]} {k[1]} ({nsec} sec)")
            continue
        keff = min(len(secs), max(1, total // CFG['min_section'],
                                  math.ceil(total / CFG['split_above'])))
        if keff < len(secs):
            log['MERGED_GHOST'].append(f"{k[0]} {k[1]}: {len(secs)} -> {keff} sections ({total} students)")
            secs.sort(key=lambda s: (s['tkey'] is None, -s['target']))
            secs = secs[:keff]
        biggest = max(r['cap'] for r in ROOMS)
        if len(secs) == 1 and total > biggest and CFG.get('auto_split_oversize', True):
            n = math.ceil(total / CFG['split_above'])
            log['AUTO_SPLIT'].append(f"{k[0]} {k[1]}: {total} students > largest room "
                                     f"({biggest}) -> {n} sections, same teacher")
            secs = [dict(secs[0]) for _ in range(n)]
        tt = 'MS' if course_level(k[0]) >= CFG['ms_level_from'] else 'BS'
        offerings.append({'code': k[0], 'title': k[1], 'tt': tt, 'sections': secs,
                          'students': enrol[k]})
    return offerings, log


# --------------------------------------------------------------------------- 3. sectioning
def section_students(students, offerings):
    maxcap = CFG['split_above']
    need = collections.defaultdict(int)
    for off in offerings:
        k = len(off['sections'])
        if k == 1:
            continue
        cnt = collections.Counter(students[i]['cohort'] for i in off['students'])
        tgt = min(max(1.0, len(off['students']) / k), maxcap)
        for coh, n in cnt.items():
            if n >= CFG['block_min']:
                need[coh] = max(need[coh], min(k, math.ceil(n / (tgt * 1.15))))
    members = collections.defaultdict(list)
    for i, s in enumerate(students):
        members[s['cohort']].append(i)
    for coh, idx in members.items():
        g = max(1, need.get(coh, 1))
        idx.sort(key=lambda i: int(re.sub(r'\D', '', students[i]['id']) or 0))
        for pos, i in enumerate(idx):
            students[i]['group'] = f"{coh} | G-{chr(65 + pos * g // len(idx))}" if g > 1 else coh

    sections = []
    for oi, off in enumerate(offerings):
        secs = off['sections']
        for j, s in enumerate(secs):
            s.update({'id': len(sections) + j, 'off': oi, 'label': chr(65 + j), 'students': []})
        sections.extend(secs)
        if len(secs) == 1:
            secs[0]['students'] = list(off['students'])
            off['floaters'] = []
            continue
        cnt = collections.Counter(students[i]['cohort'] for i in off['students'])
        units, floaters = collections.defaultdict(list), []
        for i in off['students']:
            (units[students[i]['group']] if cnt[students[i]['cohort']] >= CFG['block_min']
             else floaters).append(i)
        total = len(off['students'])
        for s in secs:
            s['want'] = total / len(secs)          # balanced sections
        # same group-letter -> same section letter where possible, then LPT balance
        for u, idx in sorted(units.items(), key=lambda kv: -len(kv[1])):
            best = max(secs, key=lambda s: s['want'] - len(s['students']))
            best['students'].extend(idx)
        off['floaters'] = floaters
    for s in sections:
        off = offerings[s['off']]
        s['est'] = len(s['students']) + math.ceil(len(off['floaters']) / len(off['sections']))
    return sections


# --------------------------------------------------------------------------- 4. CP-SAT
class Timetable:
    def __init__(self, name, spec, sections, offerings, students):
        self.name, self.spec = name, spec
        self.days, self.slots = spec['days'], spec['slots']
        self.ND, self.NS = len(self.days), len(self.slots)
        self.T = self.ND * self.NS
        self.offerings, self.students = offerings, students
        self.secs = [s for s in sections if offerings[s['off']]['tt'] == name]
        self.sessions = []                                   # (section, idx, dur, room_type)
        for s in self.secs:
            durs = spec['sessions_by_theory_cr'][str(s['theory_cr'])]
            s['tag'] = spec['tag_by_theory_cr'][str(s['theory_cr'])]
            s['sess'] = []
            for j, d in enumerate(durs):
                s['sess'].append(len(self.sessions))
                self.sessions.append({'sec': s['id'], 'j': j, 'dur': d, 'rtype': 'classroom'})
        self.secmap = {s['id']: s for s in self.secs}
        self.extra_fixed = collections.defaultdict(set)     # student -> forced sections (repair)

    def starts(self, dur):
        out = []
        for d in range(self.ND):
            for k in range(self.NS - dur + 1):
                b = self.spec['break_after_slot']
                if dur > 1 and k <= b < k + dur - 1:
                    continue
                out.append(d * self.NS + k)
        return out

    def fixed_sets(self):
        """per student: sections he surely attends in this timetable."""
        per = collections.defaultdict(set)
        for s in self.secs:
            for i in s['students']:
                per[i].add(s['id'])
        for i, fs in self.extra_fixed.items():
            per[i] |= fs
        return per

    def solve(self, seconds, hint=None):
        m = cp_model.CpModel()
        S = self.sessions
        X = {}
        cover = collections.defaultdict(list)                # (session, t) -> literals
        dayind = collections.defaultdict(list)
        for si, ss in enumerate(S):
            lits = []
            for st in self.starts(ss['dur']):
                v = m.NewBoolVar(f'x{si}_{st}')
                X[si, st] = v
                lits.append(v)
                for t in range(st, st + ss['dur']):
                    cover[si, t].append(v)
                dayind[si, st // self.NS].append(v)
            m.AddExactlyOne(lits)
        occ = lambda si, t: cover.get((si, t), [])
        penalties = []

        # ---- cliques: teacher, student fixed sets  -> no overlap (HARD)
        cliques = []
        byteacher = collections.defaultdict(list)
        for s in self.secs:
            if s['tkey']:
                byteacher[s['tkey']].extend(s['sess'])
        cliques += [('T', tuple(v), k) for k, v in byteacher.items() if len(v) > 1]
        fs = self.fixed_sets()
        groupsets = collections.Counter()
        for i, secs in fs.items():
            sess = tuple(sorted(x for sid in secs for x in self.secmap[sid]['sess']))
            if len(sess) > 1:
                groupsets[sess] += 1
        # drop sets strictly contained in another set (implied)
        sets = sorted(groupsets, key=len, reverse=True)
        kept = []
        for st in sets:
            ss = set(st)
            if not any(ss < set(k) for k in kept[:400] if len(k) > len(st)):
                kept.append(st)
        cliques += [('S', st, groupsets[st]) for st in kept]
        self.n_cliques = len(cliques)
        for kind, sess, w in cliques:
            for t in range(self.T):
                lits = [v for si in sess for v in occ(si, t)]
                if len(lits) > 1:
                    m.AddAtMostOne(lits)
            # daily load (soft)
            lim = self.spec.get('max_per_day_group', CFG['max_per_day_group']) if kind == 'S' \
                else self.spec.get('max_per_day_teacher', CFG['max_per_day_teacher'])
            for d in range(self.ND):
                lits = [v for si in sess for v in dayind[si, d]]
                if len(lits) > lim:
                    ex = m.NewIntVar(0, len(lits), '')
                    m.Add(ex >= sum(lits) - lim)
                    penalties.append((ex, 15 if kind == 'S' else 8))

        # ---- sessions of one section on different days, spaced, same time (soft)
        for s in self.secs:
            ids = s['sess']
            for d in range(self.ND):
                lits = [v for si in ids for v in dayind[si, d]]
                if len(lits) > 1:
                    m.AddAtMostOne(lits)
            if len(ids) == 2:
                a, b = ids
                da = sum(d * v for d in range(self.ND) for v in dayind[a, d])
                db = sum(d * v for d in range(self.ND) for v in dayind[b, d])
                m.Add(da + 1 <= db)                           # symmetry breaking
                close = m.NewBoolVar('')
                m.Add(db - da >= 2).OnlyEnforceIf(close.Not())
                penalties.append((close, 6))
                ka = sum((st % self.NS) * X[a, st] for st in self.starts(S[a]['dur']))
                kb = sum((st % self.NS) * X[b, st] for st in self.starts(S[b]['dur']))
                diff = m.NewIntVar(0, self.NS, '')
                m.AddAbsEquality(diff, ka - kb)
                penalties.append((diff, 1))

        # ---- rooms: total (HARD) + nested capacity levels (Hall's theorem, soft slack)
        classrooms = [r for r in ROOMS]
        caps = sorted(set(r['cap'] for r in classrooms))
        size = [self.secmap[ss['sec']]['est'] for ss in S]
        self.cap_slack = []
        peak = m.NewIntVar(0, len(classrooms), 'peak')
        penalties.append((peak, 3))
        for t in range(self.T):
            alls = [v for si in range(len(S)) for v in occ(si, t)]
            m.Add(sum(alls) <= len(classrooms))
            m.Add(sum(alls) <= peak)
            # Hall deficiency for nested room sets: the minimum number of sessions in
            # slot t that cannot get a big-enough room = max_i (need_i - have_i).
            ov = None
            for i in range(1, len(caps)):
                need = [v for si in range(len(S)) if size[si] > caps[i - 1] for v in occ(si, t)]
                have = sum(1 for r in classrooms if r['cap'] >= caps[i])
                if len(need) > have:
                    if ov is None:
                        ov = m.NewIntVar(0, len(S), f'ov{t}')
                        penalties.append((ov, CFG.get('w_capacity', 200)))
                        self.cap_slack.append(ov)
                    m.Add(sum(need) - have <= ov)

        m.Minimize(sum(w * v for v, w in penalties))
        if hint:
            for (si, st), v in X.items():
                m.AddHint(v, hint.get(si) == st)
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = seconds
        solver.parameters.num_workers = CFG['workers']
        t0 = time.time()
        res = solver.Solve(m)
        self.status = solver.StatusName(res)
        self.solve_time = time.time() - t0
        if res not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return False
        self.objective = solver.ObjectiveValue()
        self.bound = solver.BestObjectiveBound()
        self.start = {}
        for (si, st), v in X.items():
            if solver.Value(v):
                self.start[si] = st
        return True

    # ------------------------------------------------------------------ 5. floaters
    def slots_of(self, sid):
        out = set()
        for si in self.secmap[sid]['sess']:
            st = self.start[si]
            out |= set(range(st, st + self.sessions[si]['dur']))
        return out

    def enrol_floaters(self):
        fs = self.fixed_sets()
        needs = collections.defaultdict(list)                # student -> offerings to choose
        for oi, off in enumerate(self.offerings):
            if off['tt'] != self.name:
                continue
            for i in off.get('floaters', []):
                if not any(sid in fs[i] for sid in (s['id'] for s in off['sections'])):
                    needs[i].append(oi)
        load = collections.Counter()
        for s in self.secs:
            load[s['id']] = len(s['students'])
        choice, bad = {}, {}
        for i in sorted(needs, key=lambda i: -len(needs[i])):
            busy = collections.Counter()
            for sid in fs[i]:
                for t in self.slots_of(sid):
                    busy[t] += 1
            offs = sorted(needs[i], key=lambda oi: len(self.offerings[oi]['sections']))
            best = [None, 10 ** 9]

            def rec(k, busy, picked, clashes):
                if clashes >= best[1]:
                    return
                if k == len(offs):
                    best[0], best[1] = dict(picked), clashes
                    return
                secs = sorted(self.offerings[offs[k]]['sections'],
                              key=lambda s: load[s['id']] / max(1, s['est']))
                for s in secs:
                    sl = self.slots_of(s['id'])
                    c = sum(1 for t in sl if busy[t] > 0)
                    for t in sl:
                        busy[t] += 1
                    picked[offs[k]] = s['id']
                    rec(k + 1, busy, picked, clashes + c)
                    for t in sl:
                        busy[t] -= 1
                    if best[1] == 0:
                        return
            rec(0, busy, {}, 0)
            for oi, sid in best[0].items():
                choice[i, oi] = sid
                load[sid] += 1
            if best[1] > 0:
                bad[i] = best[0]
        self.floater_choice = choice
        return bad

    def finalize_members(self):
        for s in self.secs:
            s['final'] = list(s['students'])
        for (i, oi), sid in self.floater_choice.items():
            self.secmap[sid]['final'].append(i)
        for i, fsecs in self.extra_fixed.items():
            for sid in fsecs:
                if i not in self.secmap[sid]['final']:
                    self.secmap[sid]['final'].append(i)

    def load_solution(self, entries):
        """re-use a saved timetable.json (e.g. only re-do rooms or exports)."""
        idx = {(self.offerings[s['off']]['code'], self.offerings[s['off']]['title'], s['label']): s for s in self.secs}
        byid = {st['id']: i for i, st in enumerate(self.students)}
        self.start, self.status = {}, 'LOADED'
        for s in self.secs:
            s['final'] = []
        for e in entries:
            s = idx[e['course_code'], e['course_title'], e['section']]
            si = s['sess'][e['session_no'] - 1]
            self.start[si] = self.days.index(e['day']) * self.NS + e['slot_index']
            if e['session_no'] == 1:
                s['final'] = [byid[x] for x in e['student_ids']]

    # ------------------------------------------------------------------ 6. rooms
    def assign_rooms(self):
        R = ROOMS
        self.room = {}
        pref = {}
        for t in range(self.T):
            here = [si for si, st in self.start.items()
                    if st <= t < st + self.sessions[si]['dur']]
            carry = {si: self.room[si] for si in here if si in self.room}   # multi-slot hold
            todo = [si for si in here if si not in self.room]
            free = [ri for ri in range(len(R)) if ri not in carry.values()]
            if not todo:
                continue
            C = np.zeros((len(todo), len(free)))
            for a, si in enumerate(todo):
                sec = self.secmap[self.sessions[si]['sec']]
                n = len(sec['final'])
                for b, ri in enumerate(free):
                    cap = R[ri]['cap']
                    over = max(0, n - cap)
                    # 1st: fewest over-full sessions, 2nd: fewest extra chairs, 3rd: least waste
                    C[a, b] = (CFG.get("w_room_overfull_session", 150) if over else 0) + 100 * over + (cap - n if cap >= n else 0) \
                        + (0 if pref.get(sec['id']) == ri else 4)
            ra, cb = linear_sum_assignment(C)
            for a, b in zip(ra, cb):
                si = todo[a]
                self.room[si] = free[b]
                pref.setdefault(self.sessions[si]['sec'], free[b])

    # ------------------------------------------------------------------ 7. verify
    def verify(self):
        rep = collections.defaultdict(list)
        roomuse, teach, stud = collections.defaultdict(list), collections.defaultdict(list), \
            collections.defaultdict(list)
        for si, st in self.start.items():
            ss = self.sessions[si]
            sec = self.secmap[ss['sec']]
            for t in range(st, st + ss['dur']):
                roomuse[t, self.room[si]].append(si)
                if sec['tkey']:
                    teach[t, sec['tkey']].append(si)
                for i in sec['final']:
                    stud[t, i].append(si)
        rep['room_double_booked'] = [k for k, v in roomuse.items() if len(v) > 1]
        rep['teacher_clash'] = [k for k, v in teach.items() if len(v) > 1]
        rep['student_clash'] = [k for k, v in stud.items() if len(v) > 1]
        for s in self.secs:
            days = [self.start[si] // self.NS for si in s['sess']]
            if len(days) != len(set(days)):
                rep['same_day_repeat'].append(s['id'])
        over = []
        for si, ri in self.room.items():
            n = len(self.secmap[self.sessions[si]['sec']]['final'])
            if n > ROOMS[ri]['cap']:
                over.append((si, n, ROOMS[ri]['cap']))
        rep['over_capacity'] = over
        return rep


# --------------------------------------------------------------------------- driver
WARM = json.load(open(sys.argv[2])) if len(sys.argv) > 2 and sys.argv[1] == '--from' else None


def run():
    t0 = time.time()
    if os.path.exists('data.json'):
        D = json.load(open('data.json'))
        courses = _courses_from_json(D['courses'])
        students = _students_from_json(D['students'])
    else:
        courses = load_courses('classwise.xls')
        students = load_students('students.xls')
    offerings, log = build(courses, students)
    sections = section_students(students, offerings)
    results = {}
    for name, spec in CFG['timetables'].items():
        tt = Timetable(name, spec, sections, offerings, students)
        print(f'[{name}] sections={len(tt.secs)} sessions={len(tt.sessions)} '
              f'room-slots={len(ROOMS) * tt.T}', flush=True)
        if WARM and name in WARM['timetables']:
            tt.load_solution(WARM['timetables'][name]['entries'])
            print('  loaded previous solution (no re-solve)', flush=True)
            tt.assign_rooms()
            tt.report = tt.verify()
            print('  verify:', {k: len(v) for k, v in tt.report.items()}, flush=True)
            results[name] = tt
            continue
        ok = tt.solve(CFG['solver_seconds'])
        print(f'  solve: {tt.status} obj={getattr(tt, "objective", None)} '
              f'bound={getattr(tt, "bound", None)} {tt.solve_time:.0f}s cliques={tt.n_cliques}', flush=True)
        if not ok:
            results[name] = tt
            continue
        bad = tt.enrol_floaters()
        print(f'  floaters: {len(tt.floater_choice)} placements, {len(bad)} students clash', flush=True)
        if bad:
            # freeze every floater's choice -> the model now sees ALL students exactly,
            # re-optimise from the current solution (hint) so every student is clash-free
            for (i, oi), sid in tt.floater_choice.items():
                tt.extra_fixed[i].add(sid)
            tt.floater_choice = {}
            ok = tt.solve(CFG['solver_seconds'], hint=dict(tt.start))
            print(f'  re-solve (all students hard): {tt.status} obj={getattr(tt, "objective", None)}', flush=True)
            bad = tt.enrol_floaters()
        tt.finalize_members()
        tt.assign_rooms()
        tt.report = tt.verify()
        print('  verify:', {k: len(v) for k, v in tt.report.items()}, flush=True)
        results[name] = tt
    print(f'total {time.time() - t0:.0f}s')
    return students, offerings, sections, results, log


if __name__ == '__main__':
    import export
    export.export(*run())
