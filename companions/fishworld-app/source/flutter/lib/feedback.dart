import 'package:flutter/foundation.dart';
import 'data/bridge.dart';

final Map<String, List<Object>> _aiCache = {}; // key -> [line, epochMs]

/// 应用内操作反馈：谁想说一句就 sayFeedback('...')，侧栏底栏的气泡会显示 3.5 秒。
/// 只做「显示层」反馈，不参与任何业务判断。
final ValueNotifier<int> feedbackTick = ValueNotifier<int>(0);
String _last = '';
String get lastFeedback => _last;

void sayFeedback(String text) {
  final t = text.trim();
  if (t.isEmpty) return;
  _last = t;
  feedbackTick.value = feedbackTick.value + 1;
}

/// 只读缓存命中判断：缓存命中的重复戳不再记账。
bool feedbackCacheHit(String action, {String? detail}) {
  final hit = _aiCache['$action|${detail ?? ''}'];
  if (hit == null) return false;
  return DateTime.now().millisecondsSinceEpoch - (hit[1] as int) < 20000;
}

/// 让 AI 按当前状态生成一句（拿不到就保留传来的兜底模板）。
Future<String?> sayFeedbackAsync(String action, {String? detail, String? fallback}) async {
  var shown = fallback;
  if (fallback != null) sayFeedback(fallback);
  final key = '$action|${detail ?? ''}';
  final hit = _aiCache[key];
  final now = DateTime.now().millisecondsSinceEpoch;
  if (hit != null && now - (hit[1] as int) < 20000) {
    sayFeedback(hit[0] as String);
    return hit[0] as String;
  }
  final res = await bridgeFeedback(action, detail ?? '');
  if (res == null) return shown;
  final line = (res['line'] ?? '').toString().trim();
  if (line.isNotEmpty) {
    _aiCache[key] = [line, now];
    sayFeedback(line);
    return line;
  }
  return shown;
}