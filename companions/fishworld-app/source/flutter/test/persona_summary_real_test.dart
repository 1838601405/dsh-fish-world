import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/fish/fish_common.dart';

// 用**真实快照里的人设正文**验摘要：不是自造样例，是用户实际看到的那份。
void main() {
  test('真实人设正文 → 摘要跳过标题与分隔线，取到【适用】那条', () {
    final raw = File('assets/data/fish_snapshot.json').readAsStringSync();
    final j = jsonDecode(raw) as Map<String, dynamic>;
    // 快照结构里 personaText 在 profile 段下面；递归找第一个非空。
    String? found;
    void walk(Object? node) {
      if (found != null) return;
      if (node is Map) {
        final v = node['personaText'];
        if (v is String && v.trim().isNotEmpty) {
          found = v;
          return;
        }
        for (final e in node.values) {
          walk(e);
        }
      } else if (node is List) {
        for (final e in node) {
          walk(e);
        }
      }
    }

    walk(j);
    expect(found, isNotNull, reason: '快照里必须有人设正文，否则这条判据没意义');
    final body = found!;
    print('=== 正文前 80 字：' + body.substring(0, 80).replaceAll('\n', '\\n'));

    final s = personaSummaryLine(body);
    print('=== 摘要：[$s]');
    expect(s.isNotEmpty, isTrue, reason: '真实正文里一定有一条能当摘要的行');
    expect(s.contains('═'), isFalse, reason: '摘要不许带分隔线');
    expect(s.contains('─'), isFalse);
    expect(s.startsWith('DeepSeek 小鲸鱼'), isFalse,
        reason: '第一行是 setext 标题，必须跳掉');
    expect(s.startsWith('【'), isTrue,
        reason: '真实正文的第一条内容行是【适用】那种方括号段');
  });
}
