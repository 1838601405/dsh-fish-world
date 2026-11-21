import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/data/qq_gateway_io.dart';

void main() {
  test('桌面本地配置：白名单/档位/接收回读一致', () async {
    final tmp = await Directory.systemTemp.createTemp('qq-gw-');
    useQqConfigDirForTest(tmp.path);
    useQqWorldRootForTest(tmp.path);
    final gw = createQqGateway();
    await gw.saveField('allowChats', [
      {'chatKey': 'group:12345', 'name': '测试群', 'enabled': true, 'mode': ''},
    ]);
    await gw.saveField('groupReplyMode', 'quiet');
    await gw.setReceiving(true);
    await gw.saveField('ownerQQ', '1838601405');
    final cfg = (await gw.loadConfig())?['config'] as Map;
    final list = cfg['allowChats'] as List;
    // 绑主人 QQ 会顺手把他加进白名单：群 + 主人私聊 = 2 条。
    expect(list.length, 2);
    expect((list.first as Map)['chatKey'], 'group:12345');
    expect(
        list.any((e) => (e as Map)['chatKey'] == 'private:1838601405'),
        isTrue);
    expect(cfg['groupReplyMode'], 'quiet');
    expect(cfg['receive'], true);
    expect(cfg['ownerQQ'], '1838601405');
    // 删除/停用走同一条本地配置写读：空列表 + enabled=false。
    await gw.saveField('allowChats', []);
    await gw.saveField('enabled', false);
    final cfg2 = (await gw.loadConfig())?['config'] as Map;
    expect((cfg2['allowChats'] as List), isEmpty);
    expect(cfg2['enabled'], false);
    await tmp.delete(recursive: true);
  });

  test('面板白名单读真实 chats.json，不读幻影配置', () async {
    final tmp = await Directory.systemTemp.createTemp('qq-chats-');
    useQqConfigDirForTest(tmp.path);
    useQqWorldRootForTest(tmp.path);
    final dir = Directory(tmp.path + Platform.pathSeparator + '鱼的关系');
    await dir.create(recursive: true);
    await File(dir.path + Platform.pathSeparator + 'chats.json').writeAsString('{"version":1,"items":[{"chatKey":"group:681145756","kind":"group","id":"681145756","name":"真群","enabled":true,"sessionId":"session-x"}]}', flush: true);
    final gw = createQqGateway();
    final cfg = (await gw.loadConfig())?['config'] as Map;
    final list = cfg['allowChats'] as List;
    expect(list.length, 1);
    expect((list.first as Map)['chatKey'], 'group:681145756');
    await gw.saveField('allowChats', []);
    final after = jsonDecode(await File(dir.path + Platform.pathSeparator + 'chats.json').readAsString()) as Map;
    expect((after['items'] as List), isEmpty);
    await tmp.delete(recursive: true);
  });
}
