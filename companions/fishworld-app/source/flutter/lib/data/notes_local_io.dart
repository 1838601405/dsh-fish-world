import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';

Directory? _testDir;
RandomAccessFile? _lockHandle;
bool _lockTried = false;
String _readOnlyReason = '';

/// 测试用：临时笔记目录；正式运行时为 null，走 %APPDATA%/大肥鱼。
void useNotesDirForTest(String path) {
  _testDir = Directory(path);
  _lockHandle = null;
  _lockTried = false;
  _readOnlyReason = '';
}

void resetNotesDirForTest() {
  try { _lockHandle?.closeSync(); } catch (_) {}
  _lockHandle = null;
  _lockTried = false;
  _readOnlyReason = '';
  _testDir = null;
}

Directory _dir() {
  if (_testDir != null) return _testDir!;
  final appData = Platform.environment['APPDATA'];
  final home = Platform.environment['HOME'] ?? Platform.environment['USERPROFILE'] ?? '.';
  final base = (appData != null && appData.isNotEmpty) ? appData : home;
  return Directory(base + Platform.pathSeparator + '大肥鱼');
}

File _file() => File(_dir().path + Platform.pathSeparator + 'notes.json');
File _lockFile() => File(_dir().path + Platform.pathSeparator + 'notes.lock');
Directory _recycleDir() => Directory(_dir().path + Platform.pathSeparator + '回收站');
String get readOnlyReason => _readOnlyReason;
bool get canWrite => _readOnlyReason.isEmpty;

/// 单实例：拿不到排他锁就只读，不猜进程。
Future<void> _acquireLock() async {
  if (_lockTried) return;
  _lockTried = true;
  try {
    await _dir().create(recursive: true);
    final lockFile = _lockFile();
    if (!await lockFile.exists()) await lockFile.create();
    final raf = await lockFile.open(mode: FileMode.append);
    await raf.lock(FileLock.exclusive);
    _lockHandle = raf;
  } catch (_) {
    _readOnlyReason = '另一个窗口正在写，这份笔记只读';
  }
}

Future<Map<String, dynamic>> _readDoc() async {
  await _acquireLock();
  final f = _file();
  if (!await f.exists()) {
    final raw = await rootBundle.loadString('assets/data/notes.json');
    final j = jsonDecode(raw);
    final doc = j is Map ? Map<String, dynamic>.from(j) : <String, dynamic>{'version': 1, 'items': j is List ? j : const []};
    doc['version'] = 1;
    if (canWrite) await _writeDoc(doc);
    return doc;
  }
  final raw = await f.readAsString();
  final j = jsonDecode(raw);
  if (j is List) return {'version': 1, 'items': j};
  if (j is Map<String, dynamic>) {
    final version = (j['version'] as num?)?.toInt() ?? 1;
    if (version > 1) {
      _readOnlyReason = '笔记来自更新版本 v' + version.toString() + '，当前只读';
    }
    if (j['items'] is! List) j['items'] = const [];
    return j;
  }
  return {'version': 1, 'items': const []};
}

Future<void> _writeDoc(Map<String, dynamic> doc) async {
  if (!canWrite) throw StateError(_readOnlyReason);
  await _dir().create(recursive: true);
  final f = _file();
  final tmp = File(f.path + '.tmp');
  final data = const JsonEncoder.withIndent('  ').convert(doc);
  await tmp.writeAsString(data, flush: true);
  if (await f.exists()) {
    try { await f.copy(f.path + '.bak'); } catch (_) {}
  }
  await tmp.rename(f.path);
  final back = jsonDecode(await f.readAsString());
  if (back is! Map || back['items'] is! List) throw StateError('写入后回读失败');
}

String _now() => DateTime.now().toIso8601String();

Future<List<Map<String, dynamic>>> readLocalNotes() async {
  final doc = await _readDoc();
  return [for (final e in (doc['items'] as List)) Map<String, dynamic>.from(e as Map)];
}

Future<Map<String, dynamic>> saveLocalNote({String? id, required String title, required String body, required String folder, double? x, double? y}) async {
  final t = title.trim();
  final f = folder.trim();
  if (t.isEmpty) return {'ok': false, 'error': '标题不能为空'};
  if (f.isEmpty) return {'ok': false, 'error': '分组不能为空'};
  final doc = await _readDoc();
  if (!canWrite) return {'ok': false, 'error': _readOnlyReason};
  final items = (doc['items'] as List).map((e) => Map<String, dynamic>.from(e as Map)).toList();
  final at = _now();
  Map<String, dynamic>? item;
  final idx = id == null || id.isEmpty ? -1 : items.indexWhere((x) => x['id'] == id);
  if (idx >= 0) {
    item = items[idx];
    item['title'] = t;
    item['body'] = body;
    item['folder'] = f;
    item['updatedAt'] = at;
    if (x != null) item['x'] = x;
    if (y != null) item['y'] = y;
  } else {
    item = {
      'id': (id == null || id.isEmpty) ? DateTime.now().microsecondsSinceEpoch.toString() : id,
      'title': t, 'body': body, 'folder': f, 'parent': '', 'links': [], 'x': x ?? 0, 'y': y ?? 0, 'src': '',
      'createdAt': at, 'updatedAt': at,
    };
    items.add(item);
  }
  doc['version'] = 1;
  doc['items'] = items;
  await _writeDoc(doc);
  return {'ok': true, 'item': item, 'items': items};
}

Future<Map<String, dynamic>> deleteLocalNote(String id) async {
  final doc = await _readDoc();
  if (!canWrite) return {'ok': false, 'error': _readOnlyReason};
  final items = (doc['items'] as List).map((e) => Map<String, dynamic>.from(e as Map)).toList();
  final idx = items.indexWhere((x) => x['id'] == id);
  if (idx < 0) return {'ok': false, 'error': '没有这条笔记'};
  final item = items[idx];
  // 回收站：先落盘，再从主文件移除。
  final recycle = _recycleDir();
  await recycle.create(recursive: true);
  final stamp = DateTime.now().toIso8601String().replaceAll(':', '-');
  final target = File(recycle.path + Platform.pathSeparator + id + '-' + stamp + '.json');
  await target.writeAsString(const JsonEncoder.withIndent('  ').convert(item), flush: true);
  items.removeAt(idx);
  doc['items'] = items;
  await _writeDoc(doc);
  return {'ok': true, 'items': items, 'recycled': target.path};
}

Future<Map<String, dynamic>> moveLocalNote(String id, String folder) async {
  final f = folder.trim();
  if (f.isEmpty) return {'ok': false, 'error': '分组不能为空'};
  final doc = await _readDoc();
  if (!canWrite) return {'ok': false, 'error': _readOnlyReason};
  final items = (doc['items'] as List).map((e) => Map<String, dynamic>.from(e as Map)).toList();
  final i = items.indexWhere((x) => x['id'] == id);
  if (i < 0) return {'ok': false, 'error': '没有这条笔记'};
  items[i]['folder'] = f;
  items[i]['updatedAt'] = _now();
  doc['items'] = items;
  await _writeDoc(doc);
  return {'ok': true, 'items': items};
}
