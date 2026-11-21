import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/desktop/qq_reply_rules.dart';

void main() {
  test('列清单的回复被压到 1–2 条，不是十条', () {
    const raw = '''鲸歌是这样的：
- 座头鲸：有旋律，能唱十几分钟。
- 蓝鲸：低频，传几百公里。
- 抹香鲸：咔嗒声，回声定位。
- 虎鲸：哨音，像聊天。
- 海豚：也爱叫。''';
    final parts = splitReply(raw);
    expect(parts.length, lessThanOrEqualTo(3));
    expect(parts.length, 2);
    // 不能把 markdown 符号漏到消息里
    for (final p in parts) {
      expect(p.contains('- '), isFalse);
      expect(p.contains('**'), isFalse);
    }
  });

  test('一句话的回复就是一条', () {
    expect(splitReply('听过 就是那种呜呜的。'), ['听过 就是那种呜呜的。']);
  });

  test('两句话就是两条，句号不重复', () {
    final parts = splitReply('听过。低频的。');
    expect(parts.length, 2);
  });

  test('换行/斜杠不会再多拆一次（条数上限 3）', () {
    final parts = splitReply('第一句。第二句。/ 第三句。\n第四句。第五句。');
    expect(parts.length, lessThanOrEqualTo(3));
  });

  test('严肃场景判定', () {
    expect(isSeriousTopic('赔偿要怎么算'), isTrue);
    expect(isSeriousTopic('合同没签工资还欠着'), isTrue);
    expect(isSeriousTopic('今天吃什么'), isFalse);
    expect(isSeriousTopic('你听过鲸鱼叫吗'), isFalse);
  });

  test('自我矛盾能被抓出来', () {
    // 顺序两种都要抓：先肯定后否定 / 先否定后肯定。
    expect(contradictionHint('1000 是赔偿。1000 哪来的？'), isNotNull);
    expect(contradictionHint('1000 哪来的？1000 是赔偿。'), isNotNull);
    expect(contradictionHint('听过 就是那种呜呜的。'), isNull);
    expect(contradictionHint('低频，像有人在很深的地方叹气。'), isNull);
  });
  test('“认识”说法清单里有“没印象”这类词', () {
    expect(namesToSearch.contains('没印象'), isTrue);
    expect(namesToSearch.contains('不认识'), isTrue);
  });
}
