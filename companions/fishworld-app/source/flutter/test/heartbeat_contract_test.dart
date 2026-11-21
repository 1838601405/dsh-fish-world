import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

// 心跳契约（主人 2026-11-19 明确）：
//   · 重启应用后 3 秒内必须写一次 qq-heartbeat.json；
//   · 之后每 6 分钟再变一次；
//   · 停掉服务后界面显示「心跳停了」。
//
// 源码级判据（这一层靠真实计时器验要等 6 分钟，不划算；约定参数在源码里钉住）。
void main() {
  final svc = File('lib/desktop/qq_service_io.dart').readAsStringSync();
  final gw = File('lib/data/qq_gateway_io.dart').readAsStringSync();
  final qq = File('lib/fish/fish_qq.dart').readAsStringSync();

  group('① 启动 3 秒内写一次', () {
    test('有启动兜底计时器，且是 3 秒', () {
      expect(svc.contains('_heartbeatBootTimer'), isTrue);
      expect(svc.contains('Timer(const Duration(seconds: 3), _writeHeartbeat)'), isTrue,
          reason: '约定是重启后 3 秒内必须有一次心跳');
    });

    test('启动时立刻也写一次（不等 3 秒）', () {
      // 只在**启动函数体内**比较顺序：文件里别处也有 `_loadConfig()` 调用
      // （模型为空时的懒加载），全局 indexOf 会撞上它，判据就假红了。
      final startFn = svc.indexOf('Future<void> startDesktopQqService(');
      expect(startFn, greaterThan(0), reason: '要能找到启动函数');
      final body = svc.substring(startFn);
      final endIdx = body.indexOf('\n}\n');
      final fn = endIdx > 0 ? body.substring(0, endIdx) : body;
      final callIdx = fn.indexOf('_writeHeartbeat();');
      final loadIdx = fn.indexOf('await _loadConfig();');
      expect(callIdx, greaterThan(0), reason: '启动流程里要真调一次');
      expect(loadIdx, greaterThan(0));
      expect(callIdx < loadIdx, isTrue,
          reason: '心跳不能排在读配置之后（读失败也不能让它不写）');
    });
  });

  group('② 之后每 6 分钟变一次', () {
    test('周期是 6 分钟，不是旧的 5 分钟', () {
      expect(svc.contains('Duration(minutes: 6)'), isTrue);
      expect(svc.contains('Duration(minutes: 5)'), isFalse,
          reason: '旧实现是 5 分钟，和约定的 6 分钟不一致');
    });
  });

  group('③ 停了要显示「心跳停了」，不许谎报', () {
    test('网关不再「没心跳就假装 now」', () {
      // 旧写法：`_heartbeatMs() > 0 ? ... : (running ? DateTime.now()... : '0')`
      expect(
          gw.contains("running ? DateTime.now().millisecondsSinceEpoch.toString() : '0'"),
          isFalse,
          reason: '端口一在听就显示「刚刚」，服务停一夜也看不出来');
      expect(gw.contains("'lastTickAt': hb > 0 ? hb.toString() : '0'"), isTrue);
    });

    test('网关给出心跳年龄，界面不用自己猜', () {
      expect(gw.contains("'heartbeatAgeMs'"), isTrue);
      expect(gw.contains('DateTime.now().millisecondsSinceEpoch - hb'), isTrue);
    });

    test('界面有 stale 判定，阈值基于 6 分钟周期', () {
      expect(qq.contains('_heartbeatStaleMs'), isTrue);
      expect(qq.contains('String _heartbeatState()'), isTrue);
      expect(qq.contains("return 'none';"), isTrue);
      expect(qq.contains("return age > _heartbeatStaleMs ? 'stale' : 'ok';"), isTrue);
      // 阈值要容两拍（15 分钟），比 6 分钟周期大
      expect(qq.contains('15 * 60 * 1000'), isTrue);
    });

    test('文案真的写「心跳停了」', () {
      expect(qq.contains("'心跳停了（没有记录）'"), isTrue);
      expect(qq.contains("'心跳停了 · '"), isTrue);
      // 旧文案「—」在没心跳时不许再用（它不说明任何事）
      expect(qq.contains("if (ms <= 0) return '—';"), isFalse);
    });

    test('异常态用警示色，和普通只读属性分开', () {
      expect(qq.contains('valueColor: state =='), isTrue);
      expect(qq.contains('WhaleTokens.warningFor'), isTrue);
      // _PropertyRow 真的支持这个参数
      expect(qq.contains('final Color? valueColor;'), isTrue);
    });
  });

  group('④ 写心跳本身不许静默失败', () {
    test('写失败至少留日志（不吞）', () {
      final idx = svc.indexOf('void _writeHeartbeat()');
      final body = svc.substring(idx, idx + 400);
      // 旧实现是 catch (_) {} 完全吞掉；现在至少要记一笔
      expect(body.contains('_log('), isTrue,
          reason: '心跳写失败要留痕，否则「停了」查不出原因');
    });
  });
}
