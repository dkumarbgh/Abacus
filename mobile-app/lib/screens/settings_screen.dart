import 'package:flutter/material.dart';
import '../services/api_service.dart';
import 'login_screen.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final _controller = TextEditingController();
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final url = await ApiService.getBaseUrl();
    setState(() {
      _controller.text = url;
      _loading = false;
    });
  }

  Future<void> _continue() async {
    await ApiService.setBaseUrl(_controller.text.trim());
    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (_) => const LoginScreen()),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('School Server')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text(
                    'Enter your school server address. This is the SimpleSchool '
                    'Node app running on your school network, e.g.:\n'
                    'http://192.168.1.5:3000',
                  ),
                  const SizedBox(height: 16),
                  TextField(
                    controller: _controller,
                    decoration: const InputDecoration(
                      labelText: 'Server URL',
                      border: OutlineInputBorder(),
                      hintText: 'http://192.168.1.5:3000',
                    ),
                    keyboardType: TextInputType.url,
                  ),
                  const SizedBox(height: 20),
                  ElevatedButton(
                    onPressed: _continue,
                    child: const Padding(
                      padding: EdgeInsets.all(12),
                      child: Text('Continue'),
                    ),
                  ),
                ],
              ),
            ),
    );
  }
}
