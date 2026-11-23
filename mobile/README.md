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

## Offline scanning (v1.1.0)

Exam halls often have weak internet, so the scanner works without it:

- When the phone is online (app opened, every 5 minutes, app brought back to the
  screen) it downloads the **offline data** — every issued admit card, each one
  encrypted with its own QR, so the data shows nothing without the printed card.
- A scanned admit card is checked **on the phone first** (instant). Only a card
  that is not in the offline data goes to the server.
- Attendance for a paper being written is **saved on the phone** and uploaded in
  the background; the server accepts a mark only if it was scanned during that
  paper's time. The bar under the server status shows how many marks are waiting.
- Student ID cards still need the server.

Version 1.1.0 adds `@react-native-async-storage/async-storage` (a native module),
so it needs a **new APK** — an OTA update cannot add it:

```bash
cd mobile
npm install
eas build -p android --profile production
```

Then set on the server (Render → Environment) so old phones are asked to update:
`SCANNER_MIN_VERSION=1.1.0` and `SCANNER_APK_URL=<the APK link EAS gives>`.
Before an exam day, open the app once where there is internet so the offline data
is on the phone.
