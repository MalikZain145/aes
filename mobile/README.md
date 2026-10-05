# Abasyn Examination System — Admit Card Scanner (mobile)

A small **React Native (Expo)** app that scans an admit-card **QR code** and shows
the student's exam for the day (paper, time, hall, seat) and their **fee status**,
straight from the Abasyn Scheduler backend.

## What it does

Open the app → it shows **"ABASYN UNIVERSITY — Examination System"** and a QR
scanner. Point it at an admit card:

| Situation | The app shows |
|---|---|
| Valid card, exam **today** | Student details + today's **paper, time, Exam Hall, Seat No** + **Fee: Paid**, with an Upcoming / In Progress / Completed tag |
| Valid card, all papers **over** | **No exams found** |
| Valid card, **no exam today** | No exam today (papers are hidden until their day) |
| Card in **our format but not in the database** (fake print) | **Record Not Found** |
| QR that isn't an Abasyn admit card at all | **Student Not Exists — immediately inform the higher authority** |

A **Scan Next** button reopens the scanner for the next student.

## Setup

1. Install dependencies:
   ```bash
   cd mobile
   npm install
   ```
2. Set the backend address in **`config.js`** → `API_BASE`. It must be reachable
   from the phone:
   - Testing on a real phone / emulator on the same Wi-Fi: your PC's LAN IP, e.g.
     `http://192.168.1.20:5000`.
   - Production: your public domain, e.g. `https://exams.abasyn.edu.pk`.
   This should match `PUBLIC_BASE_URL` in the backend `.env` so the QR URLs and
   the app agree.
3. Run it:
   ```bash
   npm start
   ```
   Scan the QR that Expo prints with the **Expo Go** app (Android/iOS), or press
   `a` / `i` for an emulator.

## Build a standalone APK/app

```bash
npm install -g eas-cli
eas build -p android --profile preview
```
(Configure EAS once with `eas build:configure`.)

## Notes

- The backend must be running and reachable, and admit cards must have been
  generated (so the QR tokens exist in the database).
- The app calls the public endpoint `GET {API_BASE}/api/verify/:token` — no login.
