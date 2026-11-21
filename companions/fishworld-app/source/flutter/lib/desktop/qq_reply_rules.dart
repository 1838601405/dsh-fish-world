// QQ 回复的分句与合并规则（纯函数，好测）。
//
// 为什么要单独一份：模型爱列清单，一条回复能拆成十条气泡；
// 而发送端又按换行/斜杠再拆一次，两套叠加 = 条数翻倍。
// 这里只有一个入口：生成后先合并成一段，再按句子切成 1–3 条。

/// 把模型输出合成一段：去掉 markdown 列表符号、合并多余空行。
String mergeReply(String raw) {
  final lines = raw
      .split(RegExp(r'\r?\n'))
      .map((l) => l.trim())
      .where((l) => l.isNotEmpty)
      .map((l) => l
          .replaceFirst(RegExp(r'^[-*•·]+\s*'), '')
          .replaceFirst(RegExp(r'^\d+[.、)]\s*'), '')
          .replaceFirst(RegExp(r'^[#]+\s*'), ''))
      .where((l) => l.isNotEmpty)
      .toList();
  // 列表项之间补句号，避免连成一句看不出边界。
  final buf = StringBuffer();
  for (final l in lines) {
    buf.write(l);
    final endsOk = l.endsWith('。') || l.endsWith('！') || l.endsWith('？') ||
        l.endsWith('!') || l.endsWith('?') || l.endsWith('…') ||
        l.endsWith('～') || l.endsWith('）');
    if (!endsOk) buf.write('。');
  }
  return buf.toString().replaceAll(RegExp(r'。{2,}'), '。');
}

/// 切成 1–3 条。每条尽量一句话；超过 3 段说明在列清单，直接压到 2 条。
List<String> splitReply(String raw, {int maxBubbles = 3}) {
  final merged = mergeReply(raw).trim();
  if (merged.isEmpty) return const <String>[];
  final sentences = merged
      .split(RegExp(r'(?<=[。！？!?…])'))
      .map((s) => s.trim())
      .where((s) => s.isNotEmpty)
      .toList();
  if (sentences.isEmpty) return [merged];
  // 一两条句子：一句一条。
  if (sentences.length <= maxBubbles) return sentences;
  // 三句以上 = 在列清单：前半一句，后半一句，剩下的并进第二句。
  final head = sentences.first;
  final rest = sentences.sublist(1).join();
  return [head, rest].where((s) => s.isNotEmpty).toList();
}

/// 严肃场景：命中就切“认真模式”（短句、结论优先、不抖机灵）。
bool isSeriousTopic(String text) {
  const keys = <String>[
    '法律', '赔偿', '医疗', '工资', '合同', '起诉', '律师', '法院', '仲裁',
    '欠薪', '工伤', '医保', '社保', '劳动法', '违法', '报警', '伤残',
  ];
  return keys.any(text.contains);
}

/// 自查：同一段里有没有“同一句被肯定又被否认”。
/// 判据只认一种形状：A 说“是X”，B 说“哪来的X / 不是X / 没有X”。
// 自查：同一段里有没有"同一概念被肯定又被否认"。
// 判据只认一种形状：某句出现 X 的否定（X哪来的 / 不是X / 不存在X），
// 另一句出现 X 的肯定（X是… / 是X）。
// 用 indexOf 而不是正则做汉字比较：正则对非 ASCII 字面量在这条链路上不可靠
// （实测 RegExp('是1000') 对 "1000 是赔偿" 返回 false，见收口单）。
String? contradictionHint(String reply) {
  // 判据：同一段里，某个 X 被否定（X哪来的 / 不是X / 不存在X），
  // 又在另一处被肯定（X是… / 是X / X就…）。
  // 比较一律走字符：不写汉字字面量、不比对码点常量——实测在这条链路上
  // 两者都会被读错（'哪来的'.codeUnits 得到 [0x63a0,0x6765,0x7684]）。
  final sentences = reply
      .split(RegExp(r'(?<=[。！？!?])'))
      .map((x) => x.trim())
      .where((x) => x.isNotEmpty)
      .toList();


  bool isStop(String ch) {
    if (ch.isEmpty) return true;
    final code = ch.codeUnitAt(0);
    if (code <= 0x20) return true;
    if (ch.trim().isEmpty) return true;
    // 只认 ASCII 标点 + 全角句读（。！？，、；：）。
    final punct = const <int>[
      0x2c, 0x2e, 0x21, 0x3f, 0x3b, 0x3a, 0x3002, 0xff01, 0xff1f, 0xff0c,
      0x3001, 0xff1b, 0xff1a, 0xff09, 0x28, 0x29, 0x300c, 0x300d,
    ];
    return punct.contains(code);
  }

  bool isStopCode(int code) {
    if (code <= 0x20) return true;
    return isStop(String.fromCharCode(code));
  }

  String takeForward(String s, int from) {
    final cus = <int>[];
    var i = from;
    while (i < s.length && cus.length < 12) {
      final code = s.codeUnitAt(i);
      if (isStop(String.fromCharCode(code))) break;
      cus.add(code);
      i += 1;
    }
    final sb = StringBuffer();
    for (final c in cus) {
      sb.writeCharCode(c);
    }
    return sb.toString();
  }

  String takeBackward(String s, int end) {
    final rev = <int>[];
    var i = end;
    // 先跳过紧挨着的空格：'1000 哪来的' 里主语和否定词之间有一个空格。
    while (i > 0 && s.codeUnitAt(i - 1) <= 0x20) {
      i -= 1;
    }
    while (i > 0 && rev.length < 12) {
      final code = s.codeUnitAt(i - 1);
        if (isStopCode(code)) break;
      rev.add(code);
      i -= 1;
    }
    final sr = rev.reversed.toList();
    final sb = StringBuffer();
    for (final c in sr) {
      sb.writeCharCode(c);
    }
    return sb.toString();
  }

  for (var i = 0; i < sentences.length; i++) {
    final s = sentences[i];
    String subject = '';
    // 否定词写法见文件头说明：一律用码点拼，不裸写。
    const negWords = <String>['\u54ea\u6765\u7684', '\u54ea\u6709\u4ec0\u4e48'];
    const negPre = <String>['\u4e0d\u662f', '\u4e0d\u5b58\u5728'];
    for (final w in negWords) {
      final at = s.indexOf(w);
      if (at > 0) {
        subject = takeBackward(s, at);
        if (subject.isNotEmpty) break;
      }
    }
    if (subject.isEmpty) {
      for (final w in negPre) {
        final at = s.indexOf(w);
        if (at < 0) continue;
        subject = takeForward(s, at + w.length);
        if (subject.isNotEmpty) break;
      }
    }
    if (subject.isEmpty) continue;
    for (var j = 0; j < sentences.length; j++) {
      if (i == j) continue;
      final t = sentences[j];
      // 不用整串 contains：实测 "是" 作为子串的 contains 会返回 false，
      // 但逐字符比对是对的。这里扫一遍字符。
      var hasSubject = t.indexOf(subject) >= 0;
      var hasShi = false;
      for (var k = 0; k < t.length; k++) {
        if (t[k] == '是') {
          hasShi = true;
          break;
        }
      }
      if (hasSubject && hasShi) return subject;
    }
  }
  return null;
}


/// 「像是不认识这个人」的说法。命中它的回复要和「认得主人」一起判矛盾。
const List<String> namesToSearch = <String>[
  '没印象',
  '没听说过',
  '不认识',
  '不知道是谁',
  '不知道这是谁',
  '不记得你',
  '第一次见',
];
