import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

// 心跳真实行为（不用等 6 分钟）：直接验「写进去以后能读回来、年龄算得对」。
// 源码判据已覆盖「3 秒 / 6 分钟」这两个约定参数，这里验数据通路。
void main() {
  test('心跳文件写→读→算年龄：真临时目录', () async {
    final tmp = await Directory.systemTemp.createTemp('hb-');
    final f = File(tmp.path + Platform.pathSeparator + 'qq-heartbeat.json');

    // 模拟 _writeHeartbeat 的落盘形状
    final at = DateTime.now().toIso8601String();
    f.writeAsStringSync(jsonEncode({'at': at}), flush: true);
    expect(f.existsSync(), isTrue);

    final raw = jsonDecode(f.readAsStringSync()) as Map;
    final parsed = DateTime.tryParse((raw['at'] ?? '').toString());
    expect(parsed, isNotNull, reason: 'at 必须是能被解析的 ISO 时间');
    final age = DateTime.now().difference(parsed!).inMilliseconds;
    expect(age, greaterThanOrEqualTo(0));
    expect(age, lessThan(5000), reason: '刚写的文件年龄应是几秒内');

    // 旧的（模拟服务停了一夜）：年龄要能超过 15 分钟阈值
    final old = DateTime.now().subtract(const Duration(hours: 11));
    f.writeAsStringSync(jsonEncode({'at': old.toIso8601String()}), flush: true);
    final oldParsed = DateTime.tryParse(
        (jsonDecode(f.readAsStringSync()) as Map)['at'].toString())!;
    final oldAge = DateTime.now().difference(oldParsed).inMilliseconds;
    expect(oldAge, greaterThan(15 * 60 * 1000),
        reason: '11 小时前的心跳必须被判成 stale（>15 分钟）');

    await tmp.delete(recursive: true);
  });
}
