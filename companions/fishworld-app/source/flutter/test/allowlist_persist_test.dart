import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/data/qq_gateway_io.dart';

// 真行为判据（不是源码字符串）：手动加群 / 加好友之后，
// 落盘的两条 chatKey 前缀必须分别正确，且重启回读两类都在。
void main() {
  test('加一个群 + 一个好友 → 落盘 private:/group: 各一条，回读都在', () async {
    final tmp = await Directory.systemTemp.createTemp('qq-allow-');
    useQqConfigDirForTest(tmp.path);
    useQqWorldRootForTest(tmp.path);
    final gw = createQqGateway();

    // 模拟添加区两个动作的结果（与 _addGroupChat / _addFriendChat 同形）。
    await gw.saveField('allowChats', [
      {'chatKey': 'group:681145756', 'name': '肘击全世界', 'sessionId': '', 'enabled': true},
      {'chatKey': 'private:100010', 'name': '小明', 'sessionId': '', 'enabled': true},
    ]);

    // 回读（等价于重启）
    final cfg = (await gw.loadConfig())?['config'] as Map;
    final list = (cfg['allowChats'] as List).cast<Map>();
    expect(list.length, 2, reason: '两类都要在');

    final groupKeys = list
        .where((e) => e['chatKey'].toString().startsWith('group:'))
        .map((e) => e['chatKey'])
        .toList();
    final friendKeys = list
        .where((e) => e['chatKey'].toString().startsWith('private:'))
        .map((e) => e['chatKey'])
        .toList();

    expect(groupKeys, ['group:681145756']);
    expect(friendKeys, ['private:100010']);
    // 计数就是验收里说的「N 个群 / M 个好友」
    expect(groupKeys.length, 1);
    expect(friendKeys.length, 1);

    await tmp.delete(recursive: true);
    useQqConfigDirForTest(Directory.systemTemp.path);
    useQqWorldRootForTest(Directory.systemTemp.path);
  });

  test('好友的名字（备注）也落盘，重启后还在', () async {
    final tmp = await Directory.systemTemp.createTemp('qq-allow2-');
    useQqConfigDirForTest(tmp.path);
    useQqWorldRootForTest(tmp.path);
    final gw = createQqGateway();
    await gw.saveField('allowChats', [
      {'chatKey': 'private:100010', 'name': '小明', 'sessionId': '', 'enabled': true},
    ]);
    final cfg = (await gw.loadConfig())?['config'] as Map;
    final list = (cfg['allowChats'] as List).cast<Map>();
    expect(list.first['name'], '小明', reason: '备注名要落盘，否则重启后只剩号');
    expect(list.first['enabled'], true);
    await tmp.delete(recursive: true);
    useQqConfigDirForTest(Directory.systemTemp.path);
    useQqWorldRootForTest(Directory.systemTemp.path);
  });
}
