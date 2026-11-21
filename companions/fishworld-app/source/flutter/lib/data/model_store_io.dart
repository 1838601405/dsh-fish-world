import 'dart:convert';
import 'dart:io';

Map<String, dynamic>? _cache;
Directory? _dirForTest;

void useModelDirForTest(String path) {
  _dirForTest = Directory(path);
  _cache = null;
}

File _file() {
  final appData = Platform.environment['APPDATA'];
  final home = Platform.environment['HOME'] ??
      Platform.environment['USERPROFILE'] ??
      '.';
  final base = (appData != null && appData.isNotEmpty) ? appData : home;
  final dir = _dirForTest ?? Directory(base + Platform.pathSeparator + '大肥鱼');
  return File(dir.path + Platform.pathSeparator + 'model.json');
}

Map<String, dynamic> _read() {
  if (_cache != null) return _cache!;
  try {
    final f = _file();
    if (f.existsSync()) {
      final raw = jsonDecode(f.readAsStringSync());
      if (raw is Map) {
        _cache = Map<String, dynamic>.from(raw);
        return _cache!;
      }
    }
  } catch (_) {}
  _cache = <String, dynamic>{};
  return _cache!;
}

void _restrict(File f) {
  if (Platform.isWindows) {
    try {
      final user = Platform.environment['USERNAME'] ?? '';
      if (user.isEmpty) return;
      Process.runSync(
          'icacls', [f.path, '/inheritance:r', '/grant:r', '$user:(R,W)']);
    } catch (_) {}
  } else {
    try {
      Process.runSync('chmod', ['600', f.path]);
    } catch (_) {}
  }
}

void _write(Map<String, dynamic> data) {
  final f = _file();
  f.parent.createSync(recursive: true);
  f.writeAsStringSync(const JsonEncoder.withIndent('  ').convert(data),
      flush: true);
  _restrict(f);
  _cache = Map<String, dynamic>.from(data);
}

Future<Map<String, dynamic>?> loadModelConfig() async {
  final c = _read();
  return {
    'baseUrl': (c['baseUrl'] ?? '').toString(),
    'model': (c['model'] ?? '').toString(),
    'hasKey': (c['apiKey'] ?? '').toString().isNotEmpty,
  };
}

Future<Map<String, dynamic>?> saveModelConfig(
    {String? baseUrl, String? model, String? apiKey}) async {
  final c = Map<String, dynamic>.from(_read());
  if (baseUrl != null) c['baseUrl'] = baseUrl.trim();
  if (model != null) c['model'] = model.trim();
  if (apiKey != null && apiKey.trim().isNotEmpty) c['apiKey'] = apiKey.trim();
  _write(c);
  return {'ok': true, 'hasKey': (c['apiKey'] ?? '').toString().isNotEmpty};
}

Future<Map<String, dynamic>?> readModelRaw() async =>
    Map<String, dynamic>.from(_read());
