import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

// 跨平台心跳：插件版也写同一个文件（2026-11-20 主人定）。
//
// 面板侧要能回答两件事：
//   ① 她在活着吗（按 at 判 stale）
//   ② 是谁在跑（plugin / desktop）—— 两者同时跑会双回消息，必须一眼看出来
void main() {
  test('心跳文件：插件写的（有 source）能被读出 plugin', () {
    final raw = jsonDecode('{"at":"2026-11-20T06:13:34.221Z","source":"plugin"}') as Map;
    final atMs = DateTime.tryParse((raw['at'] ?? '').toString())?.millisecondsSinceEpoch ?? 0;
    final src = (raw['source'] ?? '').toString().trim();
    expect(atMs, greaterThan(0), reason: 'at 必须能解析');
    expect(src.isEmpty ? 'desktop' : src, 'plugin');
  });

  test('心跳文件：桌面版写的（没有 source）按 desktop 算', () {
    final raw = jsonDecode('{"at":"2026-11-20T06:13:34.221Z"}') as Map;
    final src = (raw['source'] ?? '').toString().trim();
    expect(src.isEmpty ? 'desktop' : src, 'desktop',
        reason: '旧桌面版没有 source 字段，不能因此显示「未知」');
  });

  test('心跳新鲜度：60 秒前写的不算 stale', () {
    const staleMs = 15 * 60 * 1000;
    final at = DateTime.now().subtract(const Duration(seconds: 60));
    final age = DateTime.now().difference(at).inMilliseconds;
    expect(age < staleMs, isTrue);
  });

  test('心跳新鲜度：16 分钟前写的算 stale', () {
    const staleMs = 15 * 60 * 1000;
    final at = DateTime.now().subtract(const Duration(minutes: 16));
    final age = DateTime.now().difference(at).inMilliseconds;
    expect(age > staleMs, isTrue);
  });

  group('源码接线', () {
    final gw = File('lib/data/qq_gateway_io.dart').readAsStringSync();
    final qq = File('lib/fish/fish_qq.dart').readAsStringSync();

    test('网关读 source 并透出 heartbeatSource', () {
      expect(gw.contains('_heartbeatFile()'), isTrue,
          reason: '要有一个同时返回 at 与 source 的读取点');
      expect(gw.contains("'heartbeatSource'"), isTrue, reason: '要透出给界面');
      expect(gw.contains("src.isEmpty ? 'desktop' : src"), isTrue,
          reason: '没有 source 的旧文件按 desktop 算');
    });

    test('界面把来源翻成人话', () {
      expect(qq.contains('String _heartbeatSource()'), isTrue);
      expect(qq.contains("'插件在跑'"), isTrue);
      expect(qq.contains("'桌面版在跑'"), isTrue);
      // 要真的显示在「最后心跳」那一行
      expect(qq.contains("text + ' · ' + src"), isTrue,
          reason: '来源要跟在时间后面，不能只存不用');
    });

    test('不许退回「没有心跳就假装 now」（只看代码，不看注释）', () {
      // ★ 这条判据踩过一次坑：旧写法被**注释**记着（就在它旁边写着「旧写法是…」），
      //   直接 contains 会一直红。所以先剥掉注释行再判。
      final code = gw
          .split('\n')
          .where((line) {
            final t = line.trimLeft();
            return !t.startsWith('//') && !t.startsWith('///');
          })
          .join('\n');
      expect(code.contains('running ? DateTime.now()'), isFalse,
          reason: '端口在听不等于她在跑，这条 2026-11-19 已修，不许退回去');
    });
  });
}
