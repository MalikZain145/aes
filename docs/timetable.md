# Class Timetable (CP-SAT engine)

The new timetable feature generates **BS** (Mon–Fri) and **MS** (Sat–Sun) weekly
class timetables with Google OR-Tools CP-SAT, driven **straight from the database**
(no Excel upload). The old CSP scheduler (`/api/schedule`, `scheduler/main.py`) is
left untouched.

## Flow
1. **Admin → Class Timetable → Generate & Publish → Generate Timetable.**
   - The backend reads the live DB: `Room` (active) → `config.rooms`,
     `Course` (active, not `noTimetable`, component ≠ Lab) grouped by code →
     the course/section/teacher list, and `StudentRegistration` → each student's
     theory courses.
   - It writes a per-run temp folder (`TIMETABLE_WORKDIR`, default OS temp) with
     `config.json` + `data.json` (parse.py's exact shape) and the engine `.py`
     files, then `spawn`s `python engine.py` (never a shell string).
   - stdout streams into `run.log` (polled by the UI). A 20-min timeout
     (`TIMETABLE_TIMEOUT_MS`) kills a stuck run. Only **one run at a time** (409).
   - On success it runs `verify_json.py`, then imports `timetable.json` into
     `timetableEntries` + `studentSections` in one bulk write and marks the run `done`.
2. **Publish** makes that run the live timetable for its term (atomic — any other
   published run for the same term is unpublished first).
3. **View** shows the published timetable with a **BS/MS** switch and four views
   (Class group / Teacher / Room / Course), a weekly grid with the BS break row,
   a live "class now" highlight, and a metrics strip.
4. **My Timetable** (`/api/timetable/me`) gives a student/teacher their own weekly
   grid from the published run.

## Engine
`scheduler/timetable_engine/` — `parse.py`, `engine.py` (CP-SAT), `export.py`,
`verify_json.py`, `config.json`, `README.md`. The only integration change to the
engine is a DB-input shim in `engine.run()`: when a `data.json` is present it loads
courses/students from it (the AMS path); otherwise it reads the two `.xls` reports
(standalone CLI). The solver, sectioning, room matching and verification are unchanged.

Rules live in `config.json` (see the engine README): BS 5×1.5h slots with a
13:00–14:00 break, MS 3×3h weekend slots, `ms_level_from: 500`, per-credit session
counts, soft caps (`max_per_day_group`/`teacher`), `w_capacity`, `solver_seconds`.

## API (`/api/timetable`, JWT)
| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/config` | admin | effective config (DB rooms + rules) |
| PUT | `/config` | admin | save editable rules (rooms stay DB-sourced) |
| POST | `/runs` | admin | start a run (202; 409 if one is active) |
| GET | `/runs` | admin | recent runs |
| GET | `/runs/:id` | admin | status + log + metrics (poll) |
| POST | `/runs/:id/publish` | admin | publish (atomic per term) |
| GET | `/runs/:id/export.xlsx` | admin | engine Excel workbook |
| GET | `/?level=&view=&key=` | any | published entries, filtered |
| GET | `/filters?level=` | any | distinct teachers/rooms/courses/classes |
| GET | `/me` | any | the signed-in user's own timetable |

## Collections
- `timetableRuns` {term, status, startedAt, finishedAt, config, metrics, summary, log, error, published, xlsxFile}
- `timetableEntries` {runId, level, day, slotIndex, time, room, block, roomCapacity, courseCode, courseTitle, section, teacher, tag, type, students, studentIds, classes}
- `studentSections` {runId, level, studentId, courseCode, section}

## Env
- `PYTHON_BIN` — python interpreter (default `python`/`python3`).
- `TIMETABLE_WORKDIR` — per-run temp root (default OS temp).
- `TIMETABLE_TIMEOUT_MS` — engine timeout (default 1 200 000 = 20 min).
- Python deps: `pip install -r scheduler/timetable_engine/requirements.txt`
  (ortools, xlrd, openpyxl, scipy, numpy). The run fails clearly if a dep/python is missing.

## Adding labs later
Lab support is designed-in but off. Add `Room`s with `type: "lab"`, set
`config.labs.enabled = true`, and follow the engine README's "Adding labs later"
section (lab sessions = 2 consecutive slots not crossing the break, lab-only rooms).
The theory timetable does not change until labs are enabled.
