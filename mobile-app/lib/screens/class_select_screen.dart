import 'package:flutter/material.dart';
import '../services/api_service.dart';
import 'capture_screen.dart';
import 'login_screen.dart';
import 'settings_screen.dart';

class ClassSelectScreen extends StatefulWidget {
  const ClassSelectScreen({super.key});

  @override
  State<ClassSelectScreen> createState() => _ClassSelectScreenState();
}

class _ClassSelectScreenState extends State<ClassSelectScreen> {
  late Future<List<Map<String, dynamic>>> _classesFuture;

  @override
  void initState() {
    super.initState();
    _classesFuture = ApiService.getClasses();
  }

  void _refresh() {
    setState(() {
      _classesFuture = ApiService.getClasses();
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Select Class'),
        actions: [
          IconButton(
            icon: const Icon(Icons.settings),
            onPressed: () {
              Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const SettingsScreen()),
              );
            },
          ),
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: 'Log out',
            onPressed: () async {
              await ApiService.logout();
              if (!context.mounted) return;
              Navigator.of(context).pushReplacement(
                MaterialPageRoute(builder: (_) => const LoginScreen()),
              );
            },
          ),
        ],
      ),
      body: FutureBuilder<List<Map<String, dynamic>>>(
        future: _classesFuture,
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }

          if (snapshot.hasError) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(20),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.error_outline, size: 48, color: Colors.red),
                    const SizedBox(height: 12),
                    Text(
                      'Could not reach the school server.\n${snapshot.error}',
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 16),
                    ElevatedButton(onPressed: _refresh, child: const Text('Retry')),
                    TextButton(
                      onPressed: () {
                        Navigator.of(context).push(
                          MaterialPageRoute(builder: (_) => const SettingsScreen()),
                        );
                      },
                      child: const Text('Check Server Settings'),
                    ),
                  ],
                ),
              ),
            );
          }

          final classes = snapshot.data ?? [];

          if (classes.isEmpty) {
            return const Center(child: Text('No classes found on the server yet.'));
          }

          return ListView.builder(
            itemCount: classes.length,
            itemBuilder: (context, index) {
              final cls = classes[index];
              return ListTile(
                leading: const Icon(Icons.class_),
                title: Text(cls['class_name'] ?? ''),
                trailing: const Icon(Icons.chevron_right),
                onTap: () {
                  Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (_) => CaptureScreen(
                        classId: cls['id'] as int,
                        className: cls['class_name'] as String,
                      ),
                    ),
                  );
                },
              );
            },
          );
        },
      ),
    );
  }
}
