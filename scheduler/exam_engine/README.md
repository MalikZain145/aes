# Exam Engine — one-click, end-to-end, audited

Upload the exam-office reports → get **BS · B.Tech · MS datesheets**, **one clash-free
seating plan**, **admit cards**, **identification sheets** and the **invigilation roster** —
and an **independent audit** that must pass before anything is published.

## Run it

**From the app:** Scheduling → **Exam Engine (1-click)** (admin only).
Drop the files, pick the first exam date / number of days, press *Run exam engine*.
Progress streams live; when the audit is CLEAN every file appears in **Reports**.

**API:** `POST /api/exam-pipeline/run` (multipart `files[]` + fields below) → `{ jobId }`,
then poll `GET /api/exam-pipeline/jobs/:jobId`.

**Command line (no server, no DB):**
```bash
cd scheduler
pip install -r requirements.txt
python -m exam_engine.ingest  students.xls classwise.xls --out canon.json --export-out export.json
python -m exam_engine.pipeline --config sample_config.json     # exit 0 = clean, 2 = audit failed
```

## Input files (detected by their headers — .xls / .xlsx / .csv, title rows above the header are fine)

| Shape | Recognised by | Used for |
|---|---|---|
| Student-wise registration | `Courses with Names` | every student's papers — the clash-free backbone (**required**, or already in the DB) |
| Class-wise enrolment | `Course Code` + `Meta Details` / `Enrolled Students` | titles, sections, **teachers** (invigilator conflict-of-interest) |
| Timetable dataset | `Code`, `Name`, `Component`, `Program Batch` | components, teachers |
| Rooms list | `Room`/`Name` + `Capacity` (+ `Exam Capacity`, `Type`) | exam venues (otherwise the DB's Rooms & Labs) |

**Source data is never edited.** Codes are compared upper-cased (`Mg231` ≡ `MG231`) for lookups only;
such spellings and class-wise vs student-wise count differences are listed under *Data quality*.
In the app, uploaded data is **added** to MongoDB (new students / courses / teachers);
existing records stay as they are unless *refresh changed student registrations* is ticked.

## What it guarantees (HARD — the run fails if any is violated)

| | Rule |
|---|---|
| D1 | every registered examinable paper is on the student's own cohort datesheet |
| D2 | a paper sits in exactly one slot per datesheet |
| D3 | no student has two papers whose times overlap |
| D4 | no student has more than 2 papers in a day (1/day is the target; 2 only when unavoidable) |
| D5 | every paper uses its cohort's **existing fixed slots** (nothing re-timed) |
| S1 | every scheduled paper has a seat |
| S2 | no seat is double-booked — including overlapping sessions (B.Tech 09:00-10:30 inside BS 09:00-12:00 are co-seated in ONE allocation) |
| S3 | admit card = seating plan = ID sheet = datesheet (room, seat, date, **the student's own paper time**) |
| S4 | bench partners never write the same paper |
| S5 | no seat beyond a room's exam capacity |
| S6 | a room is empty for ≥ *turnover* minutes (default 30) between two sessions |
| I1 | no invigilator in two rooms at the same time |
| I2 | **no teacher invigilates a room where a paper they teach is being written** |
| I3 | every room has ≥ 2 invigilators (≈1 per 25 students) |
| I4 | no invigilator over the daily duty cap (default 2) |

SOFT notes are reported, not blocking: students with 2 papers in a day, the same course code
examined at different times in different cohorts (paper-leak risk — set
`shared_paper_policy: "same_time"` to pin them to one date/time), solo benches, invigilation load.

## Fixed time-slots (unchanged)

| Cohort | Finals | Mids |
|---|---|---|
| BS (Undergraduate) | 09:00-12:00 · 01:00-03:00 | 09:00-10:30 · 11:00-12:30 · 01:00-02:30 |
| MS / MPhil / PhD | same columns as BS (Postgraduate heading) | same |
| B.Tech / BSc Eng. Tech | weekdays 03:00-04:30 · Sat/Sun 09:00-10:30 & 01:00-02:30 (Sundays used) | same |

## Which courses have a written paper

Not examined: labs (component Lab, title says *lab*, or the `…L…` twin of a lecture with the same
title, e.g. CETL312 = lab of CET312), FYP / thesis / dissertation / internship / industrial or field
training / *Project*, *Project-I/II*, *Research Project*, clinical rotations (*Refraction Clinic*,
*Supervised clinical practice*, *OT/Ward Procedures*, *Operating Room Skills*), seminars.
**Examined:** *Software Project Management*, *Project Scope, Time and Cost Management*,
*AI and Computer Applications in Project Management*, etc. — the old `\bproject\b` rule wrongly
dropped these; DB `noExam` flags caused by it are overridden in the run (and listed in the report).
Admin overrides: `exclude_courses`, `include_courses`.

## Config keys (`--config` JSON / API fields)

`exam_type` (finals|mids) · `start_date` · `num_days` · `window_mode` · `max_papers_per_day` (1|2) ·
`cohort_settings` `{bs|btech|pg: {num_days, start_date, max_papers_per_day}}` · `cohorts_to_run` ·
`merge_groups` · `same_day_groups` · `exclude_dates` · `blocked_windows` · `exclude_courses` ·
`include_courses` · `shared_paper_policy` (independent|same_time) · `room_turnover_min` ·
`invigilator_max_per_day` · `files` · `data_json` · `merge_with_db` · `timetable.enabled` ·
`strict` (default true: seating is not generated if the datesheet audit fails).

## Outputs (prefixed per run)

`Datesheet_<Finals|Mids>_{BS,BTech,MS}.pdf` (+ `_Report.pdf`, `_schedule.json`) ·
`AdmitCards_*.pdf`, `_SeatingPlan.pdf`, `_IdentificationSheets.pdf`, `_Invigilation.pdf`,
`_verify.json` (QR records), `_layout.json` (seats + invigilators) ·
`Pipeline_Audit_Report.pdf`, `audit.json`, `pipeline_summary.json`.
