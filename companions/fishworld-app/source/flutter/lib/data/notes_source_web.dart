import 'dart:convert';

import 'package:flutter/services.dart';

import 'bridge_web.dart' as bridge;
import 'notes_source_common.dart';

export 'notes_source_common.dart';

/// 插件版：永远桥优先；桥无数据时读打包快照；都没有就是空态。
class NotesSource {
  static Future<NotesLoad> load() => loadNotesChain(
        bridge: () => bridge.bridgeNotes(),
        asset: () async {
          try {
            final raw = await rootBundle.loadString('assets/data/notes.json');
            final j = jsonDecode(raw);
            final list = j is Map ? (j['items'] as List?) : (j is List ? j : null);
            return list == null ? null : [for (final e in list) Map<String, dynamic>.from(e as Map)];
          } catch (_) {
            return null;
          }
        },
      );

  static Future<Map<String, dynamic>?> save({String? id, required String title, required String body, required String folder, double? x, double? y}) async {
    final r = await bridge.bridgeNoteSave(id: id, title: title, body: body, folder: folder, x: x, y: y);
    return r ?? {'ok': false, 'error': '插件没连上'};
  }

  static Future<Map<String, dynamic>?> remove(String id) async {
    final r = await bridge.bridgeNoteDelete(id);
    return r ?? {'ok': false, 'error': '插件没连上'};
  }

  static Future<Map<String, dynamic>?> move(String id, String folder) async {
    final r = await bridge.bridgeNoteMove(id, folder);
    return r ?? {'ok': false, 'error': '插件没连上'};
  }
}
