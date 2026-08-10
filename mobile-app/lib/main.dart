import 'package:flutter/material.dart';
import 'screens/settings_screen.dart';

void main() {
  runApp(const SimpleSchoolAttendanceApp());
}

class SimpleSchoolAttendanceApp extends StatelessWidget {
  const SimpleSchoolAttendanceApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'SimpleSchool Attendance',
      theme: ThemeData(
        colorSchemeSeed: Colors.indigo,
        useMaterial3: true,
      ),
      // Always start on Settings so staff can confirm/change the server
      // address before picking a class - the most common first-run issue
      // with this kind of app is pointing at the wrong server IP.
      home: const SettingsScreen(),
    );
  }
}
