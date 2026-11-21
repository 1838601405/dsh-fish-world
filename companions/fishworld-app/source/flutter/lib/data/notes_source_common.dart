/// 笔记加载结果：items + 来源 + 只读原因。
class NotesLoad {
  final List<Map<String, dynamic>> items;
  final String source;
  final bool readOnly;
  final String notice;
  const NotesLoad(this.items, this.source, {this.readOnly = false, this.notice = ''});
}

/// 插件版加载链：桥有数据 → 打包快照 → 空态。只给 BridgeSource 用。
Future<NotesLoad> loadNotesChain({
  required Future<Map<String, dynamic>?> Function() bridge,
  required Future<List<Map<String, dynamic>>?> Function() asset,
}) async {
  try {
    final r = await bridge();
    final list = (r != null && r['ok'] == true) ? (r['items'] as List?) : null;
    if (list != null && list.isNotEmpty) {
      return NotesLoad([for (final e in list) Map<String, dynamic>.from(e as Map)], 'bridge');
    }
  } catch (_) {}
  try {
    final list = await asset();
    if (list != null && list.isNotEmpty) return NotesLoad(list, 'asset');
  } catch (_) {}
  return const NotesLoad([], 'empty', notice: '本地还没有笔记数据');
}
