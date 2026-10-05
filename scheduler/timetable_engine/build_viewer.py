"""Build the self-contained HTML viewer from timetable.json (drops per-student IDs)."""
import json
d = json.load(open('timetable.json'))
cfg = json.load(open('config.json'))
out = {}
keep = ['course_code', 'course_title', 'section', 'teacher', 'tag', 'day', 'slot_index', 'room',
        'room_capacity', 'students', 'classes']
for name, t in d['timetables'].items():
    out[name] = {'days': t['days'], 'slots': t['slots'], 'metrics': t['metrics'],
                 'break_after': cfg['timetables'][name]['break_after_slot'],
                 'entries': [{k: e[k] for k in keep} for e in t['entries']]}
html = open('viewer_template.html').read().replace('/*DATA*/', json.dumps(out, separators=(',', ':')))
open('auic_timetable.html', 'w').write(html)
print(len(html) // 1024, 'KB')
