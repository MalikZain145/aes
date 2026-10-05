# Abasyn Scheduler

**Smart academic scheduling for Abasyn University Islamabad Campus.**

A full-stack web application that generates conflict-free weekly **timetables** and **exam datesheets** (mid-term & final-term) from your live campus data. Built on a constraint-satisfaction solver that guarantees no teacher, room, lab, or batch clashes.

![Stack](https://img.shields.io/badge/stack-React%20%2B%20Node%20%2B%20Python%20%2B%20MongoDB-0f3d2e)

---

## What it does

- **Manage data from the browser** — add/edit/remove courses, teachers, rooms, and labs. Everything is stored in MongoDB and used fresh on every generation.
- **Upload datasets** — admins can upload a new course dataset (.xlsx, same column format) from the UI; courses, teachers, **emails and faculty IDs** are imported into the database automatically. No Excel file is needed at generation time.
- **Auto-sectioning** — any course with more than 50 students is automatically split into sections (A, B, …) of at most 50, each placed in a room sized to it.
- **Credit-hour aware scheduling** — multi-session courses are placed on **alternate days** (Mon/Wed, Tue/Thu …); every lab runs **once a week as a single 3-hour block**.
- **Generate timetables** — a Python CSP engine places every lecture and lab into valid slots, checking the hard constraints, then exports **Excel + PDF + a clash report**. Reaches ~99% scheduling accuracy.
- **Generate datesheets** — produce mid-term (1.5 hr) or final-term (2 hr) exam schedules as PDF, with no batch sitting two papers at once.
- **Review everything** — a Reports page lists every generated file with inline clash-report previews and one-click downloads.
- **Honest constraint reporting** — the Constraints page documents exactly what is enforced and what the known limits are.
- **Admin-only access** — a single administrator account. No public sign-up.

---

## Architecture

```
abasyn-scheduler/
├── backend/        Node + Express + MongoDB API (spawns the Python solver)
├── frontend/       React (Vite) admin dashboard
└── scheduler/      Python timetable + datesheet generators
```

The backend exports the live database to JSON, runs the Python scripts via `child_process`, parses the machine-readable summary they emit, and records the output files. The React frontend talks to the Express API.

---

## Prerequisites

- **Node.js** 18+ and npm
- **Python** 3.9+ (`python3` on PATH, or set `PYTHON_BIN`)
- **MongoDB** running locally or a MongoDB Atlas connection string
- **LibreOffice** (optional) — only needed for timetable **PDF** export. Without it, Excel and the clash report are still produced.

---

## Setup

### 1. Python solver

```bash
cd scheduler
pip install -r requirements.txt
```

### 2. Backend

```bash
cd backend
npm install
cp .env.example .env        # then edit .env (see below)
npm run seed                # creates the admin + seeds rooms/labs/courses
npm run dev                 # starts the API on http://localhost:5000
```

**Edit `.env`** before seeding:

| Variable | Purpose | Default |
|---|---|---|
| `MONGO_URI` | MongoDB connection | `mongodb://127.0.0.1:27017/abasyn_scheduler` |
| `JWT_SECRET` | Token signing secret — **change this** | — |
| `ADMIN_USERNAME` | Admin login username | `admin` |
| `ADMIN_PASSWORD` | Admin login password — **change this** | `admin123` |
| `PYTHON_BIN` | Python executable | `python3` (use `python` on Windows) |
| `CLIENT_ORIGIN` | Frontend origin for CORS | `http://localhost:5173` |

> The seed script imports the bundled `scheduler/timetable-dataset.xlsx` (≈800 courses, 19 programmes, 160 teachers) plus 42 rooms and 48 labs. Run `npm run seed -- --fresh` to wipe and reseed (the admin account is preserved).

### 3. Frontend

```bash
cd frontend
npm install
npm run dev                 # starts the UI on http://localhost:5173
```

Open **http://localhost:5173**, sign in with your admin credentials, and you're ready.

---

## Usage

1. **Dashboard** — overview of your data and recent activity.
2. **Courses / Teachers / Rooms & Labs** — manage the inputs. Changes apply on the next generation.
3. **Timetable** — click *Generate Timetable*. Watch the solver run, then review the clash summary and download Excel/PDF/report.
4. **Date Sheets** — pick mid-term or final-term, choose a start date, and generate the PDF.
5. **Reports** — find every file you've generated; preview clash reports inline.
6. **Constraints** — see what the engine guarantees and its known limits.

---

## Production build

```bash
# Build the frontend
cd frontend && npm run build

# Run the backend in production (serves frontend/dist automatically)
cd ../backend && NODE_ENV=production npm start
```

With `NODE_ENV=production`, the Express server serves the built React app, so the whole thing runs on a single port (5000 by default).

---

## The scheduling engine

University timetabling is **NP-hard**. The solver models it as a Constraint Satisfaction Problem: each session is a variable whose domain is its valid `(day, slot, room)` combinations. Sessions are placed in a best-fit-decreasing order with backtracking, and the scheduler runs several attempts and keeps the highest-accuracy result. The output never violates a **hard constraint**:

1. No teacher double-booking
2. No room double-booking
3. No lab double-booking (with overlapping lab-time windows)
4. No student-batch overlap
5. **Best-fit room matching** — each class gets the smallest room that comfortably fits it (a 20-student class lands in a ~20-seat room, not a 70-seat hall), minimising wasted space
6. Correct slot type (lectures → theory slots, labs → lab slots)
7. A course's sessions spread across different days
8. **Auto-split oversized labs** — a lab section bigger than the largest available lab is automatically divided into equal groups (each in its own lab and slot), so every student gets a seat

On the bundled sample dataset this reaches **~99.3% scheduling accuracy** (1,347 of 1,357 sessions placed perfectly, zero hard clashes).

**Tunable knobs** (top of `scheduler/main.py`):
- `TIGHT_FIT_RATIO` (default `0.30`) — how snugly classes are matched to room size
- `SPLIT_TOLERANCE` (default `0.0`) — how much lab overflow is tolerated before a section is split
- `ATTEMPTS` (in `main()`, default `3`) — how many scheduling attempts to try before keeping the best

**Known limits (reported honestly, not hidden):** a few lab sessions may remain a seat or two over capacity where a department simply has no larger lab, and a small number may be unplaced where a single batch enrols more lab courses than the available labs and weekly slots can physically hold. Both are real resource constraints — adding lab capacity resolves them.

---

## Scripts reference

**Backend**
- `npm run dev` — start API with auto-reload
- `npm start` — start API (production)
- `npm run seed` — seed database
- `npm run seed -- --fresh` — wipe & reseed

**Frontend**
- `npm run dev` — start dev server
- `npm run build` — production build
- `npm run preview` — preview the build

**Scheduler (standalone, optional)**
- `python main.py --data <export.json> --outdir output --prefix Timetable`
- `python datesheet.py mids 2026-06-01 --data <export.json> --out datesheet.pdf`

---

*Abasyn Scheduler · Smart Scheduling, Better Education*
