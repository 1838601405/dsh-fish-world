import 'dart:io';

import 'package:flutter/widgets.dart';

/// 桌面：图库在 <root>/鱼之宝库/图库；返回文件图片并降采样。
ImageProvider<Object>? galleryProviderFor(String name, List<String> roots, {int width = 256}) {
  final path = galleryLocalPath(roots, name);
  if (path == null) return null;
  return ResizeImage(FileImage(File(path)), width: width, allowUpscaling: false);
}

String? galleryLocalPath(List<String> roots, String name) {
  if (!safeGalleryName(name)) return null;
  final candidates = <String>[...roots];
  final env = Platform.environment['FISH_WORLD_ROOT'];
  if (env != null && env.isNotEmpty) candidates.add(env);
  candidates.addAll([
    Platform.environment['APPDATA'] == null ? '' : Platform.environment['APPDATA']! + Platform.pathSeparator + '大肥鱼' + Platform.pathSeparator + '鱼的世界',
    'D:' + Platform.pathSeparator + '大肥鱼' + Platform.pathSeparator + '鱼的世界',
  ]);
  return _existing(candidates, name);
}

bool safeGalleryName(String name) {
  if (name.trim().isEmpty) return false;
  if (name.contains('/') || name.contains('\\') || name.contains('\u0000')) return false;
  if (name == '.' || name == '..') return false;
  if (RegExp(r'^[A-Za-z]:').hasMatch(name)) return false;
  return true;
}

String? _existing(List<String> roots, String name) {
  for (final root in roots) {
    if (root.trim().isEmpty) continue;
    var r = root;
    if (r.startsWith('%DSH_HOME%')) {
      final home = Platform.environment['DSH_HOME'];
      if (home == null || home.isEmpty) continue;
      r = r.replaceFirst('%DSH_HOME%', home);
    }
    final f = File(r + Platform.pathSeparator + '鱼之宝库' + Platform.pathSeparator + '图库' + Platform.pathSeparator + name);
    if (f.existsSync()) return f.path;
  }
  return null;
}

bool galleryItemAvailable(String name, List<String> roots) => galleryLocalPath(roots, name) != null;

bool get galleryCanUndo => true;

/// 桌面删除：移到 鱼之宝库/图库/回收站/<时间戳>-<name>，可撤销。
Future<Map<String, dynamic>?> galleryRemove(String name, List<String> roots) async {
  final path = galleryLocalPath(roots, name);
  if (path == null) return {'ok': false, 'error': '这张图不在本地图库里'};
  final file = File(path);
  final recycle = Directory(file.parent.path + Platform.pathSeparator + '回收站');
  await recycle.create(recursive: true);
  final stamp = DateTime.now().toIso8601String().replaceAll(':', '-');
  final target = File(recycle.path + Platform.pathSeparator + stamp + '-' + name);
  await file.rename(target.path);
  if (file.existsSync() || !target.existsSync()) {
    return {'ok': false, 'error': '移入回收站后回读不一致'};
  }
  return {'ok': true, 'recycled': target.path, 'name': name};
}

Future<Map<String, dynamic>?> galleryUndo(String recycled, String name) async {
  if (!safeGalleryName(name)) return {'ok': false, 'error': '文件名不合法'};
  final f = File(recycled);
  if (!f.existsSync()) return {'ok': false, 'error': '回收站里的文件不在了'};
  final gallery = f.parent.parent;
  final target = File(gallery.path + Platform.pathSeparator + name);
  if (target.existsSync()) return {'ok': false, 'error': '原位置已经有同名文件'};
  await f.rename(target.path);
  if (f.existsSync() || !target.existsSync()) return {'ok': false, 'error': '撤销后回读不一致'};
  return {'ok': true};
}
