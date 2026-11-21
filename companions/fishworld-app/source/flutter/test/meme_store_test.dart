import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/desktop/meme_store.dart';

// 梗识别 + 落库：与插件 lib/meme-capture.mjs / meme-store.mjs 同一套口径。
void main() {
  File kb(List items) {
    final dir = Directory.systemTemp.createTempSync('meme-');
    final f = File(dir.path + Platform.pathSeparator + '知识库.json');
    f.writeAsStringSync(jsonEncode({'version': 1, 'items': items}));
    return f;
  }

  test('梗句式抽成候选', () {
    expect(extractCandidate('v我50')!['name'], 'v我50');
    expect(extractCandidate('这也太抽象了吧是什么鬼')!['name'], '是什么鬼');
  });

  test('引号里的新词抽出来', () {
    expect(extractCandidate('他说这叫「赛博上坟」')!['name'], '赛博上坟');
  });

  test('普通长句不是候选', () {
    expect(extractCandidate('今天天气不错，我去楼下买了个西瓜顺便看了会儿猫'), isNull);
  });

  test('长文本 / 段子抽成 quote 候选：首句摘要 + 关键句', () {
    final text = 'AI文案三大定律：不是而是定律、主语不动定律、化简为繁定律。以后靠这个简单分辨AI文案。';
    final q = extractQuote(text);
    expect(q, isNotNull);
    expect(q!['kind'], 'quote');
    expect(q['name']!.length <= 24, isTrue);
    expect(q['name'], contains('AI文案三大定律'));
    expect(q['meaning'], contains('不是而是定律'));
    expect(q['sentence'], text);
  });

  test('引用体 / 多人对话也算语录', () {
    expect(extractQuote('甲「这是什么」\n乙「不知道」\n甲「典中典」'), isNotNull);
    expect(extractQuote('「赛博上坟」：给已停更的号留言'), isNotNull);
  });

  test('短句不会误判成语录', () {
    expect(extractQuote('白饭'), isNull);
    expect(extractQuote('今天天气不错，我下楼买了杯咖啡'), isNull);
  });

  test('语录落库 meaning 用关键句不是待确认', () {
    final f = kb([]);
    final r = addMemeCandidate(
        kbFile: f,
        candidate: extractQuote('AI文案三大定律：不是而是定律。转折永远最重要。')!,
        source: 'private:123 · 11-17 · 主人：转发语录');
    expect(r['action'], 'new');
    final it = ((jsonDecode(f.readAsStringSync()) as Map)['items'] as List).first as Map;
    expect(it['type'], 'quote');
    expect(it['status'], 'pending');
    expect(it['meaning'], contains('不是而是定律'));
  });

  test('新梗写进去是 pending，带原句和来源', () {
    final f = kb([]);
    final r = addMemeCandidate(
        kbFile: f,
        candidate: {'name': '赛博上坟', 'kind': 'meme', 'why': '引号新词'},
        source: 'group:681145756 · 11-17 23:40 · 墨墨：他说这叫「赛博上坟」');
    expect(r['action'], 'new');
    final raw = jsonDecode(f.readAsStringSync()) as Map;
    final it = (raw['items'] as List).first as Map;
    expect(it['status'], 'pending');
    expect(it['type'], 'meme');
    expect(it['meaning'], '待确认');
    expect(it['source'].toString().contains('681145756'), isTrue);
  });

  test('重复出现只加别名，不产生第二条', () {
    final f = kb([
      {'id': 'x', 'name': 'v我50', 'aliases': <String>[], 'type': 'meme', 'status': 'confirmed'}
    ]);
    final r = addMemeCandidate(
        kbFile: f, candidate: {'name': 'v我50', 'kind': 'meme'}, source: 's');
    expect(r['action'], 'alias');
    final raw = jsonDecode(f.readAsStringSync()) as Map;
    expect((raw['items'] as List).length, 1);
  });

  test('别名命中也不新建', () {
    final f = kb([
      {'id': 'x', 'name': '疯狂星期四', 'aliases': ['v我50']}
    ]);
    final r = addMemeCandidate(
        kbFile: f, candidate: {'name': 'v我50', 'kind': 'meme'}, source: 's');
    expect(r['action'], 'alias');
    expect((jsonDecode(f.readAsStringSync()) as Map)['items'].length, 1);
  });

  test('confirmed 才喂给模型，pending 只拿来问', () {
    final items = [
      {'name': 'v我50', 'meaning': '疯狂星期四', 'status': 'confirmed'},
      {'name': '赛博上坟', 'meaning': '待确认', 'status': 'pending'},
      {'name': '老的没写状态', 'meaning': ''},
    ];
    expect(confirmedMemeLines(items).length, 2);
    expect(pendingMemeNames(items), ['赛博上坟']);
  });
}
