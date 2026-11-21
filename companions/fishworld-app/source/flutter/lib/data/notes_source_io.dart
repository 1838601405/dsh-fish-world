import 'notes_local_io.dart' as local;
import 'notes_source_common.dart';

export 'notes_source_common.dart';

/// 桌面版：永远本地，不碰桥（构建期 dart.library.io）。
class NotesSource {
  static Future<NotesLoad> load() async {
    try {
      final items = await local.readLocalNotes();
      return NotesLoad(items, 'local', readOnly: !local.canWrite, notice: local.readOnlyReason);
    } catch (_) {
      return const NotesLoad([], 'empty', notice: '本地还没有笔记数据');
    }
  }

  static Future<Map<String, dynamic>?> save({String? id, required String title, required String body, required String folder, double? x, double? y}) =>
      local.saveLocalNote(id: id, title: title, body: body, folder: folder, x: x, y: y);

  static Future<Map<String, dynamic>?> remove(String id) => local.deleteLocalNote(id);

  static Future<Map<String, dynamic>?> move(String id, String folder) => local.moveLocalNote(id, folder);
}
