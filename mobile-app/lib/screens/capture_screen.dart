import 'dart:io';
import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import '../services/api_service.dart';
import 'manual_attendance_screen.dart';

class CaptureScreen extends StatefulWidget {
  final int classId;
  final String className;

  const CaptureScreen({super.key, required this.classId, required this.className});

  @override
  State<CaptureScreen> createState() => _CaptureScreenState();
}

class _CaptureScreenState extends State<CaptureScreen> {
  CameraController? _controller;
  Future<void>? _initFuture;
  bool _busy = false;
  String? _lastResultMessage;
  bool? _lastResultOk;

  @override
  void initState() {
    super.initState();
    _initCamera();
  }

  Future<void> _initCamera() async {
    try {
      final cameras = await availableCameras();
      // Prefer the front camera since this is used to photograph the student
      // standing in front of the device (e.g. tablet mounted at the entrance).
      final camera = cameras.firstWhere(
        (c) => c.lensDirection == CameraLensDirection.front,
        orElse: () => cameras.first,
      );
      _controller = CameraController(camera, ResolutionPreset.medium, enableAudio: false);
      _initFuture = _controller!.initialize();
      setState(() {});
    } catch (e) {
      setState(() {
        _lastResultOk = false;
        _lastResultMessage = 'Could not access the camera: $e';
      });
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  String get _today {
    final now = DateTime.now();
    return '${now.year.toString().padLeft(4, '0')}-'
        '${now.month.toString().padLeft(2, '0')}-'
        '${now.day.toString().padLeft(2, '0')}';
  }

  Future<void> _captureAndMark() async {
    if (_controller == null || !_controller!.value.isInitialized || _busy) return;

    setState(() {
      _busy = true;
      _lastResultMessage = null;
    });

    try {
      final picture = await _controller!.takePicture();
      final result = await ApiService.markAttendanceByFace(
        imageFile: File(picture.path),
        classId: widget.classId,
        attendanceDate: _today,
      );

      final ok = result['ok'] == true;

      setState(() {
        _lastResultOk = ok;
        if (ok) {
          final student = result['student'] as Map<String, dynamic>;
          final confidence = result['confidence'];
          _lastResultMessage =
              'Marked present: ${student['name']} (confidence ${(confidence * 100).toStringAsFixed(0)}%)';
        } else {
          _lastResultMessage = _friendlyError(result['error'] as String?);
        }
      });
    } catch (e) {
      setState(() {
        _lastResultOk = false;
        _lastResultMessage = 'Something went wrong: $e';
      });
    } finally {
      setState(() => _busy = false);
    }
  }

  String _friendlyError(String? error) {
    switch (error) {
      case 'no_face_detected':
        return 'No face detected. Ask the student to face the camera and try again.';
      case 'multiple_faces':
        return 'More than one face detected. Please capture one student at a time.';
      case 'no_match':
        return 'No matching student found. Use manual attendance instead.';
      case 'no_enrolled_faces_in_class':
        return 'No students in this class have an enrolled photo yet.';
      case 'face_service_unreachable':
        return 'The face-recognition service is not running on the server.';
      default:
        return 'Could not mark attendance (${error ?? "unknown error"}).';
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('Attendance — ${widget.className}'),
        actions: [
          IconButton(
            icon: const Icon(Icons.list_alt),
            tooltip: 'Manual attendance',
            onPressed: () {
              Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => ManualAttendanceScreen(
                    classId: widget.classId,
                    className: widget.className,
                    attendanceDate: _today,
                  ),
                ),
              );
            },
          ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: _initFuture == null
                ? const Center(child: CircularProgressIndicator())
                : FutureBuilder<void>(
                    future: _initFuture,
                    builder: (context, snapshot) {
                      if (snapshot.connectionState != ConnectionState.done) {
                        return const Center(child: CircularProgressIndicator());
                      }
                      if (_controller == null) {
                        return const Center(child: Text('Camera unavailable'));
                      }
                      return CameraPreview(_controller!);
                    },
                  ),
          ),
          if (_lastResultMessage != null)
            Container(
              width: double.infinity,
              color: _lastResultOk == true ? Colors.green.shade100 : Colors.red.shade100,
              padding: const EdgeInsets.all(12),
              child: Text(
                _lastResultMessage!,
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: _lastResultOk == true ? Colors.green.shade900 : Colors.red.shade900,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ),
          Padding(
            padding: const EdgeInsets.all(16),
            child: ElevatedButton.icon(
              onPressed: _busy ? null : _captureAndMark,
              icon: _busy
                  ? const SizedBox(
                      width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.camera_alt),
              label: Text(_busy ? 'Checking...' : 'Capture & Mark Attendance'),
              style: ElevatedButton.styleFrom(minimumSize: const Size.fromHeight(50)),
            ),
          ),
        ],
      ),
    );
  }
}
