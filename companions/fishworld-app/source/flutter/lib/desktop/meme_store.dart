// 梗 / 语录识别与落库（桌面版）。
//
// 与插件 lib/meme-capture.mjs 同一套规则：桌面版独立收答时插件可能没跑，
// 但两边写的是同一个 知识库.json，字段与去重口径必须一致。
import 'dart:convert';
import 'dart:io';

/// 明显是梗的句式。命中就把整句当候选，名字取句式本身，方便查重。
const List<String> memeShapes = <String>[
  'v我50',
  'V我50',
  '是什么鬼',
  '难绷',
  '何意味',
  '绷不住',
  '乐死',
  '典中典',
  '好家伙',
  '笑死',
  '蚌埠住了',
  '真的假的',
  '笑不活了',
];

bool _looksLikeWord(String t) {
  final s = t.trim();
  if (s.length < 2 || s.length > 12) return false;
  if (RegExp(r'^[0-9]+$').hasMatch(s)) return false;
  if (RegExp(r'^[。！？，、…~～\-—]+$').hasMatch(s)) return false;
  return true;
}

/// 从一句话里抽候选词；抽不到返回 null。
Map<String, String>? extractCandidate(String sentence) {
  final s = sentence.trim();
  if (s.isEmpty) return null;
  final quoted = RegExp(r'[「『"“]([^」』"”]{2,12})[」』"」]').firstMatch(s);
  if (quoted != null) {
    final w = quoted.group(1)!.trim();
    if (_looksLikeWord(w)) {
      return <String, String>{'name': w, 'kind': 'meme', 'why': '被引号括起来的新词'};
    }
  }
  for (final shape in memeShapes) {
    if (!s.contains(shape)) continue;
    return <String, String>{'name': shape, 'kind': 'meme', 'why': '命中梗句式「' + shape + '」'};
  }
  if (s.length <= 12 && _looksLikeWord(s)) {
    return <String, String>{'name': s, 'kind': 'meme', 'why': '整句就是一个短词'};
  }
  return null;
}

/// 去重：name 或 aliases 命中已有条目就返回它。
Map<String, dynamic>? findDuplicate(List items, String name) {
  final key = name.trim().toLowerCase();
  if (key.isEmpty) return null;
  for (final e in items) {
    if (e is! Map) continue;
    final names = <String>[
      (e['name'] ?? '').toString(),
      ...((e['aliases'] as List?) ?? const []).map((x) => x.toString()),
    ].map((x) => x.trim().toLowerCase()).where((x) => x.isNotEmpty);
    if (names.contains(key)) return Map<String, dynamic>.from(e);
  }
  return null;
}

/// 长文本 / 引用体 / 段子 → 语录候选。
///
/// 与 extractCandidate（短梗）互补：那段只认 ≤12 字短词，转发的整段语录永远漏掉，
/// 于是「识别到语录 → 写库」在桌面端也从来没走过。判据要能红：够长、带引用、多人对话、
/// 或命中语录腔（定律/效应/最后才是…）；普通闲聊一句不能变成语录。
/// 返回 { name, kind:'quote', why, meaning, sentence }，命中规则才返回，否则 null。
Map<String, String>? extractQuote(String text,
    {String name = '', String meaning = '', String why = ''}) {
  final s = text.replaceAll('\r', '').trim();
  if (s.isEmpty) return null;
  final plain = s.replaceAll(RegExp(r'\[[^\]]{1,8}\]'), '').trim();
  final lines = plain.split('\n').map((x) => x.trim()).where((x) => x.isNotEmpty).toList();
  final longEnough = plain.length >= 45;
  final quoted = plain.contains(RegExp(r'[「『“"]')) && plain.contains(RegExp(r'[」』”"]'));
  final dialogue = lines.length >= 2 && lines.any((l) => l.contains(':') && l.length <= 60);
  final marked = _quoteMarker.hasMatch(plain) && plain.length >= 12;
  if (!longEnough && !quoted && !(dialogue && lines.length >= 3) && !marked) return null;

  final first = lines.isNotEmpty ? lines.first : plain;
  final pieces = first.split(RegExp(r'[。！？!?；;]')).where((x) => x.isNotEmpty).toList();
  final nameOut = name.trim().isNotEmpty ? name.trim() : _summarize(pieces.isNotEmpty ? pieces.first : first);
  var meaningOut = meaning.trim();
  if (meaningOut.isEmpty) {
    final hits = lines.where((l) => _quoteMarker.hasMatch(l)).toList();
    final picked = (hits.isNotEmpty ? hits : lines.take(2).toList()).join(' ');
    meaningOut = picked.length > 140 ? picked.substring(0, 140) + '…' : picked;
  }
  return <String, String>{
    'name': nameOut,
    'kind': 'quote',
    'why': why.isNotEmpty ? why : '长文本/引用体/段子',
    'meaning': meaningOut,
    'sentence': s,
  };
}

final RegExp _quoteMarker =
    RegExp(r'(定律|效应|法则|口诀|引力井|白熊|不是.{0,12}而是|最后才是|说到底|本视频|特别致谢)');

/// 名字超过 24 字时按标点收口，别把词砍成半截（与插件 tidyName 同口径）。
String _tidyName(String value, [int limit = 24]) {
  final s = value.trim();
  if (s.length <= limit) return s;
  final cut = s.substring(0, limit);
  final marks = RegExp(r'[。！？!?；;，,、：:/／·]').allMatches(cut).toList();
  final at = marks.isNotEmpty ? marks.last.start : limit;
  final head = at >= 8 ? cut.substring(0, at) : cut;
  return head.replaceAll(RegExp(r'[\s/／·、，,：:；;]+$'), '') + '…';
}

String _summarize(String text, [int limit = 24]) {
  final s = text.trim();
  if (s.length <= limit) return s;
  final cut = s.substring(0, limit);
  final marks = RegExp(r'[。！？!?；;，,、：:]').allMatches(cut).toList();
  final at = marks.isNotEmpty ? marks.last.end : limit;
  return (at >= 6 ? cut.substring(0, at) : cut).replaceAll(RegExp(r'[，,、：:]$'), '') + '…';
}

/// 往知识库写一条候选：命中就只加别名，否则新建 pending。
Map<String, dynamic> addMemeCandidate({
  required File kbFile,
  required Map<String, String> candidate,
  required String source,
  DateTime? now,
}) {
  if (!kbFile.existsSync()) return <String, dynamic>{'ok': false, 'error': '知识库文件不在了'};
  final name = (candidate['name'] ?? '').trim();
  if (name.isEmpty) return <String, dynamic>{'ok': false, 'error': '候选没有名字'};
  Map<String, dynamic> raw;
  try {
    final j = jsonDecode(kbFile.readAsStringSync());
    if (j is! Map) throw const FormatException('不是对象');
    raw = Map<String, dynamic>.from(j);
  } catch (e) {
    return <String, dynamic>{'ok': false, 'error': '知识库读不动：' + e.toString()};
  }
  final items = (raw['items'] as List?) ?? <dynamic>[];
  final hit = findDuplicate(items, name);
  final at = (now ?? DateTime.now()).millisecondsSinceEpoch;
  raw['exportedAt'] = (now ?? DateTime.now()).toUtc().toIso8601String();
  if (hit != null) {
    final idx = items.indexWhere((e) => e is Map && (e['id'] ?? '') == hit['id']);
    if (idx >= 0) {
      final it = Map<String, dynamic>.from(items[idx] as Map);
      final aliases = <String>[
        ...((it['aliases'] as List?) ?? const []).map((x) => x.toString()),
      ];
      if (it['name'] != name && !aliases.contains(name)) aliases.add(name);
      it['aliases'] = aliases;
      items[idx] = it;
    }
    raw['items'] = items;
    _write(kbFile, raw);
    return <String, dynamic>{'ok': true, 'action': 'alias', 'id': hit['id'], 'name': hit['name']};
  }
  final item = <String, dynamic>{
    'id': 'pending-' + (candidate['kind'] ?? 'meme') + '-' + at.toString(),
    'type': (candidate['kind'] ?? 'meme') == 'quote' ? 'quote' : 'meme',
    'name': _tidyName(name),
    'aliases': <String>[],
    // 语录的 meaning 用关键句，不是「待确认」占位；写进去才对模型有用。
    'meaning': ((candidate['kind'] ?? 'meme') == 'quote'
            ? (candidate['meaning'] ?? candidate['sentence'] ?? '')
            : (candidate['meaning'] ?? '待确认'))
        .toString()
        .trim(),
    'usage': '',
    'avoid': '',
    'source': source,
    'status': 'pending',
    'why': candidate['why'] ?? '',
    'quote': candidate['sentence'] ?? '',
    'addedAt': at,
    'checkedAt': 0,
  };
  items.add(item);
  raw['items'] = items;
  _write(kbFile, raw);
  return <String, dynamic>{'ok': true, 'action': 'new', 'id': item['id'], 'name': item['name']};
}

void _write(File f, Map<String, dynamic> raw) {
  try {
    f.copySync(f.path + '.bak-meme');
  } catch (_) {}
  final tmp = File(f.path + '.tmp-' + pid.toString());
  tmp.writeAsStringSync(const JsonEncoder.withIndent('  ').convert(raw), flush: true);
  tmp.renameSync(f.path);
}

/// 只把 confirmed 的梗喂给模型。
List<String> confirmedMemeLines(List items) {
  final out = <String>[];
  for (final e in items) {
    if (e is! Map) continue;
    if ((e['status'] ?? 'confirmed').toString() != 'confirmed') continue;
    final name = (e['name'] ?? '').toString().trim();
    if (name.isEmpty) continue;
    final meaning = (e['meaning'] ?? '').toString().trim();
    out.add(meaning.isEmpty || meaning == '待确认' ? name : name + '：' + meaning);
  }
  return out;
}

/// pending 的梗只用来「问一句这是啥」。
List<String> pendingMemeNames(List items) {
  final out = <String>[];
  for (final e in items) {
    if (e is! Map) continue;
    if ((e['status'] ?? '').toString() != 'pending') continue;
    final name = (e['name'] ?? '').toString().trim();
    if (name.isNotEmpty) out.add(name);
  }
  return out;
}
