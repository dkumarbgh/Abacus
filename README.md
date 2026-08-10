# SimpleSchool

A small school management system: Node.js + Express + EJS + SQLite, plus a
Python face-recognition microservice and a Flutter mobile app for
attendance capture. Supports **multiple schools** on one deployment, each
fully isolated, with login-based access.

## Fee discounts & waivers

On any student's fee collection page (`/fee-payments/:studentId`), each fee
line has a **Discount/Waive** button:

- **Discount** — enter a flat rupee amount or a percentage, plus an optional
  reason (e.g. "Sibling discount", "Staff ward"). The fee's Net amount and
  Due amount update everywhere immediately (dues page, fees-due report,
  fees-pending report, student individual report).
- **Waive Full Amount** — one click, waives whatever remains on that fee
  item entirely (implemented as a 100% discount under the hood, so it shows
  up the same way as any other discount and can be removed the same way).
- Only one discount/waiver can be active per student per fee item —
  applying a new one replaces the old one rather than stacking.
- Remove a discount from the same page to go back to the full amount.

## Authentication & multi-school support

- **Web admin site**: session-based login. Every school's Admin can add
  Teacher/Accountant/Admin logins for their own staff from `/users`.
- **Mobile app**: JWT login (`POST /api/login`) — a token, not a cookie,
  since that's more natural for Flutter. Same credentials as the web login.
- **Data isolation**: every table has a `school_id`, and every query in
  every route is scoped to the logged-in user's school. One school can
  never see or modify another school's data, even by guessing IDs in a URL.
- **New school**: `/register-school` creates a school + its first Admin
  login in one step. Anyone with the server URL can currently self-register
  a new school — see "Known limitations" below if you want to lock that down.

**Your existing data** (students, classes, etc. from before this update)
was automatically migrated into a school called "Default School" on first
startup, with a temporary login:

```
email: admin@defaultschool.local
password: changeme123
```

**Log in and change this password immediately** (Users page doesn't yet
have a self-service password change — see limitations — for now, delete
the user from `/users` and re-add with a new password, or update
`password_hash` directly in `school.db` using bcrypt).

## Modules

| Feature | Where |
|---|---|
| Student registration (with guardian info + photo) | `/students/add` |
| Face enrollment (re-upload/replace a student's photo) | `/students/enroll-face/:id` |
| Classes, teachers, subjects, timetable | `/classes`, `/teachers`, `/subjects`, `/timetable` |
| Manual attendance (existing) | `/attendance` |
| Face-recognition attendance (mobile app) | `POST /attendance/face-mark`, see `mobile-app/` |
| Fee categories & structure (with due dates) | `/fee-structure`, `/fees` |
| Fee collection (record payments, WhatsApp receipt) | `/fee-payments` |
| Fee discounts & waivers (flat or %, per student per fee item) | `/fee-payments` (Discount/Waive button on each fee row) |
| Exams & marks entry | `/exams` |
| Practice sheets (teacher-uploaded PDFs) | `/practice-sheets` |
| WhatsApp messaging (single + class broadcast) | `/whatsapp` |
| Users & logins (Admin only) | `/users` |
| **Reports hub** | `/reports` |
| — Fees due report | `/reports/fees-due` |
| — Fees pending report (+ bulk WhatsApp reminder) | `/reports/fees-pending` |
| — Attendance report (+ Excel export) | `/reports/attendance` |
| — Exam-level results (ranked) | `/reports/exam-results/:examId` |
| — Student individual report (printable) | `/reports/student/:studentId` |
| — Fee receipt (PDF) | `/reports/receipt/:paymentId` |

## 1. Setup

```bash
npm install
npm run dev          # nodemon app.js, runs on http://localhost:3000
```

`school.db` (SQLite) is created/migrated automatically on startup — all
tables and columns (including the multi-school migration) were added with
idempotent migrations, so this is safe to run against your existing
database. Sessions use an in-memory store by default (everyone's logged out
if the server restarts) — fine at this scale; swap in `connect-redis` or
similar if that becomes annoying.

## 2. WhatsApp setup

Uses `whatsapp-web.js` — your school's own WhatsApp number, no Meta business
approval needed. On first server start, a QR code prints in the terminal.
Scan it from WhatsApp → Linked Devices → Link a Device. The session is
cached in `whatsapp-session/` so you won't need to scan again.

If Chromium isn't installed (`npm install` normally downloads it
automatically), messages will just log as "FAILED" — the rest of the app
keeps working fine either way.

Keep messages to genuine parent communication (fee receipts, reminders,
attendance alerts, notices) — heavy bulk-blast usage risks the number
getting flagged. Bulk sends (`sendBulk`) already include a delay between
messages.

## 3. Face-recognition attendance setup

Three pieces work together:

1. **Node app** (this repo) — stores student records and face encodings,
   exposes `/attendance/face-mark` for the mobile app to call.
2. **Python face-service** (`face-service/`) — a small Flask microservice
   that turns a photo into a face encoding. Stateless; the Node app does the
   actual comparison/matching.
3. **Flutter app** (`mobile-app/`) — camera capture UI for teachers.

Start the face-service:

```bash
cd face-service
pip install -r requirements.txt   # needs cmake + a C++ compiler for dlib
python app.py                     # runs on http://localhost:5001
```

The Node app talks to it via `FACE_SERVICE_URL` (defaults to
`http://localhost:5001` — set this env var if you run it elsewhere).

Enroll faces from the admin site (`/students`, the 📷 button, or during
registration) before trying attendance capture on mobile — see
`mobile-app/README.md` for the full mobile setup (it needs one `flutter
create` step to scaffold Android/iOS folders around the provided source).

## 4. Project structure

```
config/database.js       # SQLite connection + idempotent schema migrations
routes/                  # one file per module (students, fees, exams, etc.)
services/
  whatsappClient.js       # whatsapp-web.js wrapper + message logging
  faceRecognition.js      # calls face-service, does the matching in JS
views/                    # EJS templates
public/uploads/           # student photos, practice sheets, tmp capture files
face-service/             # Python Flask microservice (face encoding)
mobile-app/               # Flutter source for the attendance app
```

## 5. Known limitations / next steps

- `/register-school` is currently open to anyone who reaches the server —
  fine while testing, but before real deployment either remove public
  registration (create schools manually / via an invite flow) or put it
  behind an additional check.
- No self-service "forgot password" or in-app password change yet — an
  Admin can remove and re-add a user from `/users` to reset their password.
- Mobile JWTs are long-lived (30 days) and there's no revoke/logout list -
  fine for a small trusted deployment, worth tightening for wider rollout.
- Sessions use an in-memory store, so a server restart logs everyone out.
- Face-recognition attendance only auto-marks "Present" on a confident
  match; absentees still need the manual fallback (there's no way to detect
  "this enrolled student didn't show up today" from photos alone — you'd
  compare against the full roster at day's end instead).
- The match threshold is in `services/faceRecognition.js` if you need to
  tune false-positive/negative rates.
- `/students/add` registration currently has no duplicate-admission-number
  check — worth adding once real data volume grows.
