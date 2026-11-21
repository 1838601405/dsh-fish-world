import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/desktop/send_fence.dart';

void main() {
  group('该拦的：拦下时整条不发，text 原样留着好排查', () {
    test('工具调用语法漏进正文', () {
      const raw = '<invoke name="search">\n<parameter name="q">鲸鱼</parameter>\n</invoke>';
      final r = fenceText(raw);
      expect(r.ok, isFalse);
      expect(r.reason, FenceReason.toolMarkup);
      // 拦下也要把原文带回来：调用方可能想记日志/排查，不能给出空串。
      expect(r.text, raw);
    });

    test('工具调用段标记 / to=functions. 行', () {
      expect(fenceText('<|tool_calls_section_begin|>').reason,
          FenceReason.toolMarkup);
      expect(fenceText('to=functions.search 查一下').reason,
          FenceReason.toolMarkup);
    });

    test('markdown 标题行', () {
      final r = fenceText('## 鲸歌小知识\n座头鲸会唱。');
      expect(r.ok, isFalse);
      expect(r.reason, FenceReason.markdown);
    });

    test('markdown 列表行（符号 / 有序都算）', () {
      expect(fenceText('鲸歌有几种：\n- 座头鲸\n- 蓝鲸').reason,
          FenceReason.markdown);
      expect(fenceText('1. 座头鲸\n2. 蓝鲸').reason, FenceReason.markdown);
      // 行首缩进的列表也要抓：缩进不影响它在 QQ 里还是一串符号。
      expect(fenceText('  * 抹香鲸').reason, FenceReason.markdown);
    });

    test('客服腔：一条强特征就够', () {
      final r = fenceText('很高兴为您服务，请问还有什么可以帮到您？');
      expect(r.ok, isFalse);
      expect(r.reason, FenceReason.serviceTone);
    });

    test('客服腔：两条弱特征也算', () {
      final r = fenceText('感谢您的反馈，建议您稍后重试。');
      expect(r.ok, isFalse);
      expect(r.reason, FenceReason.serviceTone);
    });

    test('自我介绍式声明', () {
      final r = fenceText('作为一个人工智能，我无法感受鲸歌。');
      expect(r.ok, isFalse);
      expect(r.reason, FenceReason.selfIntro);
    });
  });

  group('该放行的：正常鱼话一个字都不动', () {
    test('单个敬语不算客服腔', () {
      final r = fenceText('感谢您这一句，听着比夸我舒服。');
      expect(r.ok, isTrue);
      expect(r.reason, '');
    });

    test('白饭', () {
      final r = fenceText('白饭');
      expect(r.ok, isTrue);
      expect(r.text, '白饭');
    });

    test('才不是大肥鱼！是小鲸鱼', () {
      final r = fenceText('才不是大肥鱼！是小鲸鱼');
      expect(r.ok, isTrue);
      expect(r.text, '才不是大肥鱼！是小鲸鱼');
    });

    test('哼 现在才发现', () {
      final r = fenceText('哼 现在才发现');
      expect(r.ok, isTrue);
      expect(r.text, '哼 现在才发现');
    });

    test('带数字和时间的正常话', () {
      const raw = '3 点 20 分才睡，现在脑子还是浆糊';
      final r = fenceText(raw);
      expect(r.ok, isTrue);
      expect(r.text, raw);
    });

    test('被问急了认账「我是 DeepSeek」不算自我介绍模板', () {
      final r = fenceText('对，我是 DeepSeek，小鲸鱼本鱼');
      expect(r.ok, isTrue);
      expect(r.text, '对，我是 DeepSeek，小鲸鱼本鱼');
    });
  });

  group('放行时清行内标记', () {
    test('加粗与行内代码的标记被清掉，里面的字保留', () {
      final r = fenceText('这叫**有福气**，不是 `bug`');
      expect(r.ok, isTrue);
      expect(r.text, '这叫有福气，不是 bug');
    });

    test('没有标记时原样返回', () {
      const raw = '低频，像有人在很深的地方叹气。';
      expect(fenceText(raw).text, raw);
    });
  });

  test('空串放行、不算病', () {
    final r = fenceText('   ');
    expect(r.ok, isTrue);
    expect(r.text, '');
  });
}
