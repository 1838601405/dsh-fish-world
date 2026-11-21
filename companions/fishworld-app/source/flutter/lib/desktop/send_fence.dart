// 出站闸：桌面端「发出去之前」的最后一道判据（纯函数，无 IO、无副作用）。
//
// 为什么要单独一份：鱼的回复有三条出口（插件侧 JS、桌面端自己收自己回、
// 本地聊天窗）。插件那条另有 JS 版闸，两边判据必须同口径——同一条回复
// 在桌面端放行、在插件侧被拦，就是两边说的不是一套规矩。
// 所以这里只放判据，一个 import 都不引：谁能调它，谁就得到同一份结果。
//
// 判据只管「这条能不能原样发出去」，不管怎么发、发几次、发失败怎么办——
// 连发合并 / 去重 / 重试都在 qq_service_io 里，别搬进来。
//
// 套话清单只写在这个文件里：代码不进提示词，模型看不到自己正在被筛什么，
// 才不会学着绕。禁词表 / 坏例句一律不许写进人设卡、README、任何提示词。

/// 判据代号。日志里只打代号，不打被拦下的原文——原文进日志等于把
/// 「哪些句子会被拦」抄了一份到磁盘上。
class FenceReason {
  /// 模型把工具调用语法漏进正文了。
  static const String toolMarkup = 'tool-markup';

  /// markdown 标题行 / 列表行：QQ 里不渲染，发出去就是一串 `##` `- `。
  static const String markdown = 'markdown';

  /// 客服腔：敬语套话堆在一起，像工单回复不像人说话。
  static const String serviceTone = 'service-tone';

  /// 自我介绍式声明：把「我是一个 AI 助手」这类身份说明直接念出来。
  static const String selfIntro = 'self-intro';
}

/// 一次判定结果。
/// ok=false 时调用方必须整条不发（不是截断、不是改写）；reason 是代号。
/// ok=true 时 text 才是要发的那份（行内 **加粗** / `代码` 标记已清掉）。
class SendFenceResult {
  final bool ok;
  final String reason;
  final String text;

  const SendFenceResult({
    required this.ok,
    required this.reason,
    required this.text,
  });

  @override
  String toString() => 'SendFenceResult(ok: $ok, reason: $reason)';
}

// ── 判据表（只在这份文件里）──────────────────────────────────────────

/// 工具调用语法：漏进正文说明模型把「要调用工具」写成了文字。
final RegExp _toolInvoke = RegExp(r'<invoke\b');
final RegExp _toolSectionBegin = RegExp(r'<\|tool_calls_section_begin\|>');
const String _toolCallLine = 'to=functions.';

/// markdown 标题行：`# ` 到 `###### `。
final RegExp _mdHeading = RegExp(r'^#{1,6}\s', multiLine: true);

/// markdown 列表行：`- ` `* ` `+ ` `1. ` `1) `。
final RegExp _mdList = RegExp(r'^\s*([-*+]|\d+[.)])\s', multiLine: true);

/// 强特征：单独出现一次就够判客服腔。
const List<String> _strongServicePhrases = <String>[
  '有什么可以帮到您',
  '有什么可以帮您',
  '还有什么可以帮您',
  '请问还有什么',
  '感谢您的咨询',
  '感谢您的支持与理解',
  '如有任何疑问',
  '如有疑问请随时',
  '欢迎随时联系',
  '竭诚为您服务',
  '很高兴为您服务',
  '希望以上回答对您有帮助',
  '希望对您有所帮助',
  '希望能帮到你',
  '如果还有其他问题',
  '您可以尝试以下',
  '以下是一些建议',
  '祝您生活愉快',
  '祝您一切顺利',
  '请您谅解',
  '敬请谅解',
];

/// 弱特征：命中两种以上（互不相同的）才判客服腔。
/// 单个敬语在真人嘴里也说得出口，堆起来才是工单味。
const List<String> _weakServicePhrases = <String>[
  '您好',
  '感谢您',
  '十分抱歉',
  '抱歉让您',
  '为您',
  '建议您',
  '您可以',
  '请注意',
  '温馨提示',
  '辛苦您',
  '麻烦您',
  '如需',
  '敬请',
  '很高兴',
  '请问您',
  '非常感谢',
];

/// 自我介绍式声明。注意不拦「我是 DeepSeek」这种——那是鱼被问急了
/// 自己认账的说法，属于该说的；拦的是把身份说明整段念出来的模板句。
const List<String> _selfIntroPhrases = <String>[
  '作为一个人工智能',
  '作为人工智能',
  '作为一个ai',
  '作为ai',
  '作为语言模型',
  '作为一个语言模型',
  '作为一个大语言模型',
  '作为大语言模型',
  '我是一个ai',
  '我是一个人工智能',
  '我是一个语言模型',
  '我是一个ai助手',
  '我是人工智能助手',
  '我是ai助手',
  '我是ai语言模型',
  '我只是一个ai',
  '我只是ai',
  '我没有个人情感',
  '我没有真实的情感',
  '我不具备情感',
  '我没有身体',
  '我的训练数据',
  '我的知识截止',
  '由深度求索',
  '深度求索公司',
];

/// 行内 markdown：成对的 `**` 与反引号。只清标记，不动里面的字。
final RegExp _inlineBold = RegExp(r'\*\*');
const String _inlineCode = '`';

// ── 入口 ────────────────────────────────────────────────────────────

/// 判一条待发回复能不能原样发出去。
///
/// 顺序：工具语法 → markdown → 客服腔 → 自我介绍。
/// 顺序有意义：前两条是「根本不是人话」，先拦它们，日志才指得准病因；
/// 后两条是「像人但不像鱼」。
SendFenceResult fenceText(String text) {
  final raw = text;
  if (raw.trim().isEmpty) {
    return const SendFenceResult(ok: true, reason: '', text: '');
  }
  // ASCII 判据统一在 lowercase 上做；中文不受影响。
  final lower = raw.toLowerCase();

  if (_toolInvoke.hasMatch(raw) ||
      _toolSectionBegin.hasMatch(raw) ||
      lower.contains(_toolCallLine)) {
    return SendFenceResult(ok: false, reason: FenceReason.toolMarkup, text: raw);
  }

  if (_mdHeading.hasMatch(raw) || _mdList.hasMatch(raw)) {
    return SendFenceResult(ok: false, reason: FenceReason.markdown, text: raw);
  }

  if (_looksLikeServiceTone(lower)) {
    return SendFenceResult(ok: false, reason: FenceReason.serviceTone, text: raw);
  }

  if (_looksLikeSelfIntro(lower)) {
    return SendFenceResult(ok: false, reason: FenceReason.selfIntro, text: raw);
  }

  final cleaned = _stripInlineMarkup(raw);
  return SendFenceResult(ok: true, reason: '', text: cleaned);
}

/// 客服腔：1 条强特征，或 2 种以上不同的弱特征。
bool _looksLikeServiceTone(String lower) {
  for (final p in _strongServicePhrases) {
    if (lower.contains(p)) return true;
  }
  var hits = 0;
  for (final p in _weakServicePhrases) {
    if (lower.contains(p)) hits += 1;
    // 只判「够不够两种」，不需要精确计数。
    if (hits >= 2) return true;
  }
  return false;
}

bool _looksLikeSelfIntro(String lower) {
  for (final p in _selfIntroPhrases) {
    if (lower.contains(p)) return true;
  }
  return false;
}

/// 清掉行内标记。没标记时原样返回同一个字符串（正常话一个字都不动）。
String _stripInlineMarkup(String text) {
  if (!text.contains('**') && !text.contains(_inlineCode)) return text;
  return text.replaceAll(_inlineBold, '').replaceAll(_inlineCode, '');
}
