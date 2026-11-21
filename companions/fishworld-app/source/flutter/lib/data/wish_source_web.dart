import 'dart:async';

import 'package:flutter/widgets.dart';

import 'bridge_web.dart' as bridge;

Future<Map<String, dynamic>> stickerWishesLoad(List<String> roots) async {
  try {
    final r = await bridge.bridgeStickerWishes();
    if (r == null || r['ok'] != true) return {'ok': true, 'items': const [], 'soft': true};
    final items = (r['items'] as List?) ?? const [];
    return {'ok': true, 'items': [for (final e in items) if (e is Map) Map<String, dynamic>.from(e)]};
  } catch (_) {
    return {'ok': true, 'items': const [], 'soft': true};
  }
}

ImageProvider<Object>? wishImageProvider(String id, String file, List<String> roots) {
  final url = bridge.stickerWishImageUrl(id);
  if (url.isEmpty) return null;
  return ResizeImage(NetworkImage(url), width: 112, allowUpscaling: false);
}

bool get wishCanDecide => true;
