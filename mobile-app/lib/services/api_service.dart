import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

/// Talks to the SimpleSchool Node.js backend.
///
/// The server base URL is configurable at runtime (Settings screen) since
/// it'll usually be the school's local network IP, e.g. http://192.168.1.5:3000
class ApiService {
  static const _baseUrlKey = 'server_base_url';
  static const _tokenKey = 'auth_token';
  static const defaultBaseUrl = 'http://10.0.2.2:3000'; // Android emulator -> host machine

  static Future<String> getBaseUrl() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_baseUrlKey) ?? defaultBaseUrl;
  }

  static Future<void> setBaseUrl(String url) async {
    final prefs = await SharedPreferences.getInstance();
    // Trim trailing slash so we don't end up with "http://host//api/classes"
    final cleaned = url.endsWith('/') ? url.substring(0, url.length - 1) : url;
    await prefs.setString(_baseUrlKey, cleaned);
  }

  static Future<String?> getToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_tokenKey);
  }

  static Future<void> _setToken(String token) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_tokenKey, token);
  }

  static Future<void> logout() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_tokenKey);
  }

  static Future<Map<String, String>> _authHeaders() async {
    final token = await getToken();
    return {
      if (token != null) 'Authorization': 'Bearer $token',
      'Content-Type': 'application/json',
    };
  }

  /// Logs in with the same email/password as the web admin site.
  /// Throws on failure; on success the token is stored and used
  /// automatically by every other method in this class.
  static Future<Map<String, dynamic>> login({
    required String email,
    required String password,
  }) async {
    final base = await getBaseUrl();
    final response = await http.post(
      Uri.parse('$base/api/login'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'email': email, 'password': password}),
    );

    final body = jsonDecode(response.body) as Map<String, dynamic>;

    if (response.statusCode != 200) {
      throw Exception(body['error'] ?? 'Login failed (${response.statusCode})');
    }

    await _setToken(body['token'] as String);
    return body['user'] as Map<String, dynamic>;
  }

  static Future<List<Map<String, dynamic>>> getClasses() async {
    final base = await getBaseUrl();
    final response = await http.get(Uri.parse('$base/api/classes'), headers: await _authHeaders());
    if (response.statusCode != 200) {
      throw Exception('Failed to load classes (${response.statusCode})');
    }
    final List<dynamic> data = jsonDecode(response.body);
    return data.cast<Map<String, dynamic>>();
  }

  static Future<List<Map<String, dynamic>>> getStudents(int classId) async {
    final base = await getBaseUrl();
    final response = await http.get(
      Uri.parse('$base/api/classes/$classId/students'),
      headers: await _authHeaders(),
    );
    if (response.statusCode != 200) {
      throw Exception('Failed to load students (${response.statusCode})');
    }
    final List<dynamic> data = jsonDecode(response.body);
    return data.cast<Map<String, dynamic>>();
  }

  /// Sends a captured photo to the backend to be matched against enrolled
  /// students in [classId]. On a confident match, attendance is marked
  /// automatically. Returns the parsed JSON response either way.
  static Future<Map<String, dynamic>> markAttendanceByFace({
    required File imageFile,
    required int classId,
    required String attendanceDate,
  }) async {
    final base = await getBaseUrl();
    final uri = Uri.parse('$base/attendance/face-mark');
    final token = await getToken();

    final request = http.MultipartRequest('POST', uri)
      ..fields['class_id'] = classId.toString()
      ..fields['attendance_date'] = attendanceDate
      ..files.add(await http.MultipartFile.fromPath('image', imageFile.path));
    if (token != null) {
      request.headers['Authorization'] = 'Bearer $token';
    }

    final streamedResponse = await request.send();
    final response = await http.Response.fromStream(streamedResponse);

    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  /// Manual fallback: mark a specific student's attendance directly,
  /// used when face recognition can't find a confident match.
  static Future<void> markManual({
    required int studentId,
    required String attendanceDate,
    required String status,
  }) async {
    final base = await getBaseUrl();
    final response = await http.post(
      Uri.parse('$base/api/attendance/manual'),
      headers: await _authHeaders(),
      body: jsonEncode({
        'student_id': studentId,
        'attendance_date': attendanceDate,
        'status': status,
      }),
    );
    if (response.statusCode != 200) {
      throw Exception('Failed to save attendance (${response.statusCode})');
    }
  }
}
