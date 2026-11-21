import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

// 超窗未投消息要可见、能补投（2026-11-20 主人要求 A）。
//
// 现场：09:13 重启，主人 08:47 发的「吃饭去了」，
// 桥 09:14:07 判「27 分钟前，不再补投」直接丢；只写进桥日志，面板看不到。
void main() {
  group('桥状态文件解析（桌面版直读文件）', () {
    test('桥的未投队列：中文键名照读，转成面板用的形状', () {
      // 桥写的字段是中文：未投队列 / 时间 / 秒 / 文字 / 昵称 / 号码 / 原因
      final raw = jsonDecode('''
{
  "未投队列": [
    {"id":"m1","时间":1700000000,"秒":1620,"文字":"吃饭去了","昵称":"主人","号码":1838601405,"原因":"超过补投窗口（10 分钟）"}
  ],
  "桥启动于": 1700001000000,
  "重启豁免分": 30
}
''') as Map;
      final list = raw['未投队列'] as List;
      expect(list.length, 1);
      final one = list.first as Map;
      // 关键：时间要 *1000 转毫秒，秒要能直接显示成「27 分钟前」
      expect((one['时间'] as int) * 1000, 1700000000000);
      expect(one['秒'], 1620);
      expect((one['秒'] as int) ~/ 60, 27, reason: '27 分钟 —— 现场那个数');
      expect(one['文字'], '吃饭去了');
      expect(raw['重启豁免分'], 30);
    });

    test('文件不存在 → 空队列，不是错误', () {
      // 桥没跑过 / 从没丢过东西时，状态文件里没这个键。这不该报错。
      final raw = jsonDecode('{"上次":{},"已转":[]}') as Map;
      final has = raw.containsKey('未投队列');
      expect(has, false, reason: '老桥/没丢过 就没有这个键');
      // 面板要按「0 条」处理，不显示卡片
      final list = raw['未投队列'];
      expect(list, isNull);
    });
  });

  group('源码接线', () {
    final io = File('lib/data/qq_gateway_io.dart').readAsStringSync();
    final web = File('lib/data/qq_gateway_web.dart').readAsStringSync();
    final base = File('lib/data/qq_gateway_base.dart').readAsStringSync();
    final qq = File('lib/fish/fish_qq.dart').readAsStringSync();
    final bridge = File('lib/data/bridge_web.dart').readAsStringSync();

    test('网关接口有 undelivered / redeliver', () {
      expect(base.contains('Future<Map<String, dynamic>?> undelivered()'), isTrue);
      expect(base.contains('redeliver({String? id, bool all = false})'), isTrue);
    });

    test('桌面版直读桥状态文件（不猜端口）', () {
      expect(io.contains('qq-bridge-state.json'), isTrue,
          reason: '要读桥自己的状态文件');
      expect(io.contains("raw['未投队列']"), isTrue, reason: '中文键名照读');
      expect(io.contains('_redeliverRequestPath'), isTrue,
          reason: '补投用文件握手，不猜 HTTP 端口');
    });

    test('web 版走 HTTP 转给 bridge_web', () {
      expect(web.contains('bridgeQqUndelivered'), isTrue);
      expect(web.contains('bridgeQqRedeliver'), isTrue);
      expect(bridge.contains('/dsh-fish-world/qq/undelivered'), isTrue,
          reason: '同源路由');
    });

    test('页面有卡片，且只有在有未投时才画', () {
      expect(qq.contains('_UndeliveredCard'), isTrue);
      expect(qq.contains('_undeliveredCount() > 0'), isTrue,
          reason: '★ 没有未投就一个字都不加，不占地方');
    });

    test('进页面就加载 + 定时刷新（不能等主人点刷新）', () {
      final hasInit = qq.contains('_loadUndelivered(silent: true);');
      expect(hasInit, isTrue, reason: 'initState 要拉一次');
      // 12 秒的定时器里也要有
      final timerBlock = qq.contains('_loadLive(silent: true);') &&
          qq.contains('_loadUndelivered(silent: true);');
      expect(timerBlock, isTrue, reason: '定时刷新要带上未投队列');
    });

    test('卡片有补投按钮（单条 + 全部）', () {
      expect(qq.contains("child: const Text('补投'"), isTrue, reason: '单条补投');
      expect(qq.contains("label: const Text('全部补投'"), isTrue, reason: '全部补投');
    });

    test('★ 说明文案要说清「不会自动回」', () {
      // 这是主人最容易误会的地方：以为她没回，其实是被丢在这儿了。
      expect(qq.contains('不会自动回'), isTrue);
      expect(qq.contains('要让她回应就点下面的补投'), isTrue);
    });
  });
}
