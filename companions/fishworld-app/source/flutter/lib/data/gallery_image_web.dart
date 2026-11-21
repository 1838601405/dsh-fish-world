import 'bridge_web.dart' as bridge;
import 'package:flutter/widgets.dart';

/// 插件版：走现有 /gallery/file 桥 URL。
ImageProvider<Object>? galleryProviderFor(String name, List<String> roots, {int width = 256}) {
  if (name.trim().isEmpty) return null;
  final url = '/dsh-fish-world/gallery/file?name=' + Uri.encodeComponent(name);
  return ResizeImage(NetworkImage(url), width: width, allowUpscaling: false);
}

bool galleryItemAvailable(String name, List<String> roots) => name.trim().isNotEmpty;

bool get galleryCanUndo => false;

Future<Map<String, dynamic>?> galleryRemove(String name, List<String> roots) async {
  return bridge.bridgeFishGalleryRemove(name);
}

Future<Map<String, dynamic>?> galleryUndo(String recycled, String name) async =>
    {'ok': false, 'error': '插件版请从图库索引恢复'};
