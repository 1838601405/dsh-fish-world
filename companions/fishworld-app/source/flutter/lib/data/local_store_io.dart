import 'dart:convert';
import 'dart:io';

Map<String, String>? _mem;
Directory? _dirForTest;

void useLocalStoreDirForTest(String path) {
  _dirForTest = Directory(path);
  _mem = null;
}

File _file() {
  final appData = Platform.environment['APPDATA'];
  final home = Platform.environment['HOME'] ??
      Platform.environment['USERPROFILE'] ??
      '.';
  final base = (appData != null && appData.isNotEmpty) ? appData : home;
  final dir = _dirForTest ?? Directory(base + Platform.pathSeparator + '大肥鱼');
  return File(dir.path + Platform.pathSeparator + 'local_store.json');
}

Map<String, String> _load() {
  if (_mem != null) return _mem!;
  if (_dirForTest == null && Platform.environment.containsKey('FLUTTER_TEST')) {
    _mem = <String, String>{};
    return _mem!;
  }
  final f = _file();
  try {
    if (f.existsSync()) {
      final raw = jsonDecode(f.readAsStringSync());
      if (raw is Map) {
        _mem = {
          for (final e in raw.entries) e.key.toString(): e.value.toString()
        };
        return _mem!;
      }
    }
  } catch (_) {}
  _mem = <String, String>{};
  return _mem!;
}

void _save() {
  final f = _file();
  try {
    f.parent.createSync(recursive: true);
    f.writeAsStringSync(jsonEncode(_mem ?? const {}), flush: true);
  } catch (_) {}
}

String? readLocal(String key) => _load()[key];

void writeLocal(String key, String value) {
  _load()[key] = value;
  _save();
}
