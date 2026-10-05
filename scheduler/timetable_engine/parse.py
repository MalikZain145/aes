"""Parse the two registration reports into clean JSON."""
import xlrd, re, json, collections

def norm_teacher(t):
    t = t.strip().rstrip(',').strip()
    t = re.sub(r'^[A-Z]{2,4}-\d+\s*-\s*', '', t)          # "CS-038 - Dr. X"
    if not t or t.lower() == 'no teacher':
        return None
    key = re.sub(r'\b(mr|ms|mrs|dr|engr|prof)\b\.?', '', t, flags=re.I)
    key = re.sub(r'[^a-z]', '', key.lower())
    return t, key

def load_courses(path):
    s = xlrd.open_workbook(path).sheet_by_index(0)
    rows = []
    for r in range(1, s.nrows):
        v = s.row_values(r)
        secs = []
        for line in v[6].split('\n'):
            line = line.strip()
            if not line:
                continue
            parts = line.split(' - ', 2)
            label = parts[0].replace('Section-', '').strip()
            teacher = norm_teacher(parts[2]) if len(parts) > 2 else None
            secs.append({'label': label, 'teacher': teacher[0] if teacher else None,
                         'tkey': teacher[1] if teacher else None})
        rows.append({'row': int(v[0]), 'code': v[1].strip(), 'title': v[2].strip(),
                     'credits': float(v[3]), 'nsec': int(v[4]), 'enrolled': int(v[5]),
                     'sections': secs})
    return rows

PAT = re.compile(r'(\S+) - (.+?) - (\d+(?:\.\d+)?),\s*')

def load_students(path):
    s = xlrd.open_workbook(path).sheet_by_index(0)
    out = []
    for r in range(1, s.nrows):
        v = s.row_values(r)
        courses = [(m.group(1).strip(), m.group(2).strip(), float(m.group(3)))
                   for m in PAT.finditer(v[6])]
        out.append({'name': v[1], 'id': str(v[2]).replace('.0', ''), 'program': v[3],
                    'batch': v[4], 'courses': courses})
    return out

if __name__ == '__main__':
    C = load_courses('classwise.xls')
    S = load_students('students.xls')
    json.dump({'courses': C, 'students': S}, open('data.json', 'w'), indent=1)
    # match check
    bykey = collections.defaultdict(list)
    for c in C:
        bykey[c['code']].append(c)
    miss = collections.Counter(); amb = collections.Counter(); n = 0
    for st in S:
        for code, title, cr in st['courses']:
            n += 1
            cands = bykey.get(code, [])
            if not cands:
                miss[(code, title)] += 1
            elif len(cands) > 1:
                amb[code] += 1
    print('students', len(S), 'enrolments', n)
    print('unmatched', sum(miss.values()), miss.most_common(15))
    print('ambiguous codes', amb.most_common(30))
    ids = collections.Counter(st['id'] for st in S)
    print('dup student ids', [k for k, c in ids.items() if c > 1][:10])
