# AUIC Timetable Engine (theory, labs-ready)

## Run
```
pip install ortools xlrd openpyxl scipy numpy
python3 parse.py          # classwise.xls + students.xls -> data.json (sanity report)
python3 engine.py         # solves BS + MS, verifies, writes timetable.json + Excel
python3 build_viewer.py   # optional: auic_timetable.html viewer (BS/MS switch)
```
Inputs: `classwise.xls` (Course Registration Report classwise) and `students.xls`
(student-wise registration report). All rules live in `config.json`.

## config.json
| key | meaning |
|---|---|
| rooms | name, block, cap, type (`classroom` now; add `lab` rooms later) |
| timetables.BS / MS | days, slot times, `break_after_slot`, sessions per theory credit, tags |
| ms_level_from | course code level >= this (500) goes to the MS weekend timetable |
| block_min | a cohort with >= this many students in a course moves as a block |
| min_section / split_above | ghost-section merging and max planned section size |
| max_per_day_group / teacher | soft daily-load limits |
| w_capacity | weight of the room-capacity objective |
| solver_seconds, workers | CP-SAT time budget |

## Output for the AMS: timetable.json
`timetables.BS.entries[]` and `timetables.MS.entries[]`, one object per weekly session:
`course_code, course_title, section, teacher, tag, day, slot_index, time, room,
room_capacity, students, student_ids, classes, type ("theory")`.
The BS/MS button in the AMS just switches which `entries` array it renders.

## Adding labs later
1. Add lab rooms to `config.rooms` with `"type": "lab"`.
2. For lab sections create sessions with `dur: 2` (two consecutive 1.5h slots = 3h) and
   `rtype: "lab"` in `Timetable.__init__`.  `starts()` already only allows consecutive
   slots that do not cross the break; `occ()` already makes a 2-slot session occupy both
   slots, so teacher/student/room no-overlap works unchanged.
3. Add a per-slot counting constraint `lab sessions <= lab rooms` next to the total-rooms
   constraint, and in `assign_rooms()` give lab sessions infinite cost on non-lab rooms.
   A multi-slot session keeps its room across its slots (`carry`), so a theory class can
   use a lab room only when no lab is running there.
