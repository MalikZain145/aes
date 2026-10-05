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
        if e['teacher'] != 'TBA': teach[k + (e['teacher'],)] += 1
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
