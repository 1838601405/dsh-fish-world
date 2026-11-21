import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';

List<String> _roots(List<String> roots) {
  final out = <String>[...roots];
  final env = Platform.environment['FISH_WORLD_ROOT'];
  if (env != null && env.isNotEmpty) out.add(env);
  out.addAll([
    Platform.environment['APPDATA'] == null ? '' : Platform.environment['APPDATA']! + Platform.pathSeparator + '大肥鱼' + Platform.pathSeparator + '鱼的世界',
    'D:' + Platform.pathSeparator + '大肥鱼' + Platform.pathSeparator + '鱼的世界',
  ]);
  return out;
}

String? _wishDir(List<String> roots) {
  for (final root in _roots(roots)) {
    if (root.trim().isEmpty) continue;
    var r = root;
    if (r.startsWith('%DSH_HOME%')) {
      final home = Platform.environment['DSH_HOME'];
      if (home == null || home.isEmpty) continue;
      r = r.replaceFirst('%DSH_HOME%', home);
    }
    final d = Directory(r + Platform.pathSeparator + '鱼的请求' + Platform.pathSeparator + '想收藏');
    if (d.existsSync()) return d.path;
  }
  return null;
}

Future<Map<String, dynamic>> stickerWishesLoad(List<String> roots) async {
  final dir = _wishDir(roots);
  if (dir == null) return {'ok': true, 'items': const [], 'soft': true};
  try {
    final raw = jsonDecode(await File(dir + Platform.pathSeparator + 'pending.json').readAsString());
    final list = (raw is Map ? raw['items'] : raw) as List? ?? const [];
    final items = <Map<String, dynamic>>[];
    for (final e in list) {
      if (e is! Map) continue;
      final file = (e['file'] ?? '').toString();
      if (file.isEmpty) continue;
      if (!File(dir + Platform.pathSeparator + file).existsSync()) continue;
      items.add(Map<String, dynamic>.from(e));
    }
    return {'ok': true, 'items': items, 'dir': dir};
  } catch (_) {
    return {'ok': true, 'items': const [], 'soft': true};
  }
}

ImageProvider<Object>? wishImageProvider(String id, String file, List<String> roots) {
  final dir = _wishDir(roots);
  if (dir == null || file.isEmpty) return null;
  final f = File(dir + Platform.pathSeparator + file);
  if (!f.existsSync()) return null;
  return ResizeImage(FileImage(f), width: 112, allowUpscaling: false);
}

bool get wishCanDecide => false;
