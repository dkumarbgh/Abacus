import 'package:flutter/material.dart';
import '../services/api_service.dart';

class ManualAttendanceScreen extends StatefulWidget {
  final int classId;
  final String className;
  final String attendanceDate;

  const ManualAttendanceScreen({
    super.key,
    required this.classId,
    required this.className,
    required this.attendanceDate,
  });

  @override
  State<ManualAttendanceScreen> createState() => _ManualAttendanceScreenState();
}

class _ManualAttendanceScreenState extends State<ManualAttendanceScreen> {
  late Future<List<Map<String, dynamic>>> _studentsFuture;
  final Set<int> _savingIds = {};
  final Map<int, String> _markedStatus = {};

  @override
  void initState() {
    super.initState();
    _studentsFuture = ApiService.getStudents(widget.classId);
  }

  Future<void> _mark(int studentId, String status) async {
    setState(() => _savingIds.add(studentId));
    try {
      await ApiService.markManual(
        studentId: studentId,
        attendanceDate: widget.attendanceDate,
        status: status,
      );
      setState(() => _markedStatus[studentId] = status);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to save: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _savingIds.remove(studentId));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('Manual Attendance — ${widget.className}')),
      body: FutureBuilder<List<Map<String, dynamic>>>(
        future: _studentsFuture,
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return Center(child: Text('Error: ${snapshot.error}'));
          }

          final students = snapshot.data ?? [];

          if (students.isEmpty) {
            return const Center(child: Text('No students in this class.'));
          }

          return ListView.builder(
            itemCount: students.length,
            itemBuilder: (context, index) {
              final student = students[index];
              final id = student['id'] as int;
              final saving = _savingIds.contains(id);
              final marked = _markedStatus[id];

              return ListTile(
                title: Text(student['name'] ?? ''),
                subtitle: Text(
                  (student['face_enrolled'] == 1)
                      ? 'Face enrolled'
                      : 'No face enrolled — register a photo on the admin site',
                ),
                trailing: saving
                    ? const SizedBox(
                        width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                    : Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          IconButton(
                            icon: Icon(
                              Icons.check_circle,
                              color: marked == 'Present' ? Colors.green : Colors.grey,
                            ),
                            onPressed: () => _mark(id, 'Present'),
                          ),
                          IconButton(
                            icon: Icon(
                              Icons.cancel,
                              color: marked == 'Absent' ? Colors.red : Colors.grey,
                            ),
                            onPressed: () => _mark(id, 'Absent'),
                          ),
                        ],
                      ),
              );
            },
          );
        },
      ),
    );
  }
}
