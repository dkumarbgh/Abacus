# SimpleSchool Attendance (Flutter)

Face-recognition attendance capture app. A teacher points the camera at a
student, taps **Capture & Mark Attendance**, and the backend matches the
photo against enrolled students in that class and marks them present.

This folder contains just the Dart source (`lib/`) and `pubspec.yaml` — it's
not a full generated Flutter project yet. That's normal; run one command to
scaffold the platform folders around it.

## 1. Turn this into a runnable Flutter project

You need the Flutter SDK installed (`flutter --version` to check). Then, from
this `mobile-app/` folder:

```bash
flutter create --project-name simpleschool_attendance --org com.yourschool .
flutter pub get
```

This generates `android/`, `ios/`, etc. around the existing `lib/` folder
without touching it.

## 2. Add camera permissions

**Android** — in `android/app/src/main/AndroidManifest.xml`, add inside `<manifest>`:

```xml
<uses-permission android:name="android.permission.CAMERA" />
```

Also bump the minSdkVersion in `android/app/build.gradle` to at least 21 if it's lower.

**iOS** — in `ios/Runner/Info.plist`, add:

```xml
<key>NSCameraUsageDescription</key>
<string>This app uses the camera to take attendance photos.</string>
```

## 3. Point it at your school server

Run the app (`flutter run`), and on first launch you'll land on a **Server**
screen. Enter your SimpleSchool Node server's address, e.g.:

- Android emulator talking to your dev machine: `http://10.0.2.2:3000` (this is the default)
- A real device on the same WiFi as the server: `http://<your-computer's-LAN-IP>:3000`
- A deployed server: `https://your-school-domain.com`

This is saved on-device (SharedPreferences) so you only set it once. Next
you'll be asked to log in with the same email/password as the web admin
site — the app stores the returned token and sends it automatically on
every request after that.

## 4. Enroll students' faces first

The app can only recognize students who already have a face enrolled on the
backend — do that from the admin website (`/students`, the 📷 button per
student, or during registration) before trying attendance capture on mobile.

## 5. How it works

1. Pick a class.
2. Point the camera at a student, tap **Capture & Mark Attendance**.
3. The photo is sent to `POST /attendance/face-mark` on the Node server,
   which asks the Python face-service for an encoding and compares it
   against enrolled students in that class.
4. A confident match marks that student **Present** for today automatically.
5. If there's no confident match (new haircut, bad lighting, not enrolled,
   etc.), tap the list icon in the top bar for **manual attendance** — pick
   present/absent per student from a simple list, which calls
   `POST /api/attendance/manual`.

## Notes / things to tune later

- Currently only marks "Present" automatically — absentees still need to be
  handled via the manual screen (there's no reliable way to detect "this
  specific enrolled student did not show up" from face capture alone; you'd
  compare against the full roster at end of day instead).
- The match confidence threshold lives on the server
  (`services/faceRecognition.js`, `threshold = 0.6`) — tighten it if you're
  getting false-positive matches between siblings/similar-looking students.
- No login/auth on the app yet — anyone with the server address can mark
  attendance. Fine for a single trusted school device; add a PIN/login
  screen before wider rollout.
