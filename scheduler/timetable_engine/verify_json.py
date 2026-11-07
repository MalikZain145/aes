"""Independent checker: reads only timetable.json + data.json."""
import json, collections, re
d = json.load(open('timetable.json')); raw = json.load(open('data.json'))
for name, t in d['timetables'].items():
    E = t['entries']
    room, teach, stud = collections.Counter(), collections.Counter(), collections.Counter()
    seen = collections.defaultdict(set)
    for e in E:
        k = (e['day'], e['slot_index'])
        room[k + (e['room'],)] += 1
        if str(e['teacher']).strip().lower() not in ('tba', 'no teacher', ''): teach[k + (e['teacher'],)] += 1
        for s in e['student_ids']:
            stud[k + (s,)] += 1
            seen[s].add((e['course_code'], e['course_title']))
    print(name, 'entries', len(E), '| room dbl', sum(v > 1 for v in room.values()),
          '| teacher clash', sum(v > 1 for v in teach.values()),
          '| student clash', sum(v > 1 for v in stud.values()),
          '| students', len(seen))
# coverage: every registered theory course of every student is scheduled
from engine import classify, course_level
miss = 0; tot = 0
allseen = collections.defaultdict(set)
for t in d['timetables'].values():
    for e in t['entries']:
        for s in e['student_ids']: allseen[s].add(e['course_code'])
for st in raw['students']:
    for code, title, cr in st['courses']:
        if classify(title, cr)[0] == 'THEORY':
            tot += 1
            if code not in allseen[st['id']]: miss += 1
print('theory registrations', tot, 'not scheduled', miss)
# rooms: only the configured rooms, reserved rooms (GP1/GP2) only for their departments, capacity
cfg = json.load(open('config.json'))
rooms = {r['name']: r for r in cfg['rooms']}
for name, t in d['timetables'].items():
    unknown = sum(1 for e in t['entries'] if e['room'] not in rooms)
    misuse = 0
    for e in t['entries']:
        r = rooms.get(e['room']) or {}
        only = [str(x).upper() for x in (r.get('only') or [])]
        pre = (re.match(r'[A-Za-z]+', e['course_code']) or [''])[0].upper()
        if only and pre not in only:
            misuse += 1
    over = sum(1 for e in t['entries'] if e.get('students', 0) > e.get('room_capacity', 10 ** 6))
    print(name, '| rooms outside list', unknown, '| reserved-room misuse', misuse, '| over capacity', over)
