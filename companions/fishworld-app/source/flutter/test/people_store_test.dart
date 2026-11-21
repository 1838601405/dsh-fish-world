import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/data/qq_gateway_io.dart';
import 'package:whale_girl/desktop/people_store.dart';

// 按人记：同一个 QQ 号在私聊和群里是同一份档案。
void main() {
  test('首次见面建档，昵称进 names，seenIn 记会话', () async {
    final tmp = await Directory.systemTemp.createTemp('people-');
    final f = File(tmp.path + Platform.pathSeparator + 'people.json');
    final store = PeopleStore(f);
    store.seen(qqId: '10001', nickname: '墨墨', chatKey: 'group:681145756');
    final p = store.get('10001')!;
    expect(p.names, contains('墨墨'));
    expect(p.seenIn, contains('group:681145756'));
    expect(p.role, 'guest');
    await tmp.delete(recursive: true);
  });

  test('同一个人换个窗口：合并到同一份档案，不新建', () async {
    final tmp = await Directory.systemTemp.createTemp('people2-');
    final f = File(tmp.path + Platform.pathSeparator + 'people.json');
    final store = PeopleStore(f);
    store.seen(qqId: '10001', nickname: '墨墨', chatKey: 'group:681145756');
    store.seen(qqId: '10001', nickname: '墨墨', chatKey: 'private:10001');
    expect(store.all.length, 1);
    expect(store.get('10001')!.seenIn.length, 2);
    // 落盘后重新读也是同一份
    final again = PeopleStore(f);
    expect(again.all.length, 1);
    expect(again.get('10001')!.seenIn.length, 2);
    await tmp.delete(recursive: true);
  });

  test('主人条目：role=owner，displayName=大星，别名带主人', () async {
    final tmp = await Directory.systemTemp.createTemp('people3-');
    final f = File(tmp.path + Platform.pathSeparator + 'people.json');
    final store = PeopleStore(f);
    store.seen(
        qqId: '1838601405',
        nickname: '大星',
        chatKey: 'private:1838601405',
        isOwner: true);
    final owner = store.get('1838601405')!;
    expect(owner.role, 'owner');
    expect(owner.displayName, '大星');
    expect(owner.names, contains('大星'));
    final raw = jsonDecode(f.readAsStringSync()) as Map;
    final items = (raw['people'] as List).cast<Map>();
    expect(items.any((e) => e['role'] == 'owner'), isTrue);
    await tmp.delete(recursive: true);
  });

  test('promptFor 给主人写“就是本人”，不是第三人', () async {
    final tmp = await Directory.systemTemp.createTemp('people4-');
    final f = File(tmp.path + Platform.pathSeparator + 'people.json');
    final store = PeopleStore(f);
    store.seen(
        qqId: '1838601405',
        nickname: '大星',
        chatKey: 'private:1838601405',
        isOwner: true);
    // 新口径：身份行统一叫「主人(大星)」，不再写「主人本人」。
    final line = store.promptFor('1838601405', chatKey: 'private:1838601405');
    expect(line.contains('主人(大星)'), isTrue);
    expect(line.contains('你啊'), isTrue);
    await tmp.delete(recursive: true);
  });

  test('群友的 promptFor 带昵称和 QQ', () async {
    final tmp = await Directory.systemTemp.createTemp('people5-');
    final store = PeopleStore(File(tmp.path + Platform.pathSeparator + 'people.json'));
    store.seen(qqId: '10001', nickname: '墨墨', chatKey: 'group:681145756');
    store.addFact('10001', '他养了一只猫');
    final line = store.promptFor('10001');
    expect(line.contains('墨墨'), isTrue);
    expect(line.contains('10001'), isTrue);
    expect(line.contains('养了一只猫'), isTrue);
    await tmp.delete(recursive: true);
  });

  test('跨会话合并：群里说过的事，私聊里也检索得到', () async {
    final tmp = await Directory.systemTemp.createTemp('people7-');
    final store = PeopleStore(File(tmp.path + Platform.pathSeparator + 'people.json'));
    store.seen(qqId: '10001', nickname: '墨墨', chatKey: 'group:681145756');
    store.addFact('10001', '我上周去看了海');
    // 换到私聊窗口：同一个 qqId，事实还是那份
    store.seen(qqId: '10001', nickname: '墨墨', chatKey: 'private:10001');
    final line = store.promptFor('10001');
    expect(line.contains('看过海') || line.contains('看了海'), isTrue);
    expect(store.all.length, 1);
    await tmp.delete(recursive: true);
  });

  test('事实最多留 12 条，老的挤出去', () async {
    final tmp = await Directory.systemTemp.createTemp('people6-');
    final store = PeopleStore(File(tmp.path + Platform.pathSeparator + 'people.json'));
    store.seen(qqId: '10001', nickname: '墨墨', chatKey: 'group:1');
    for (var i = 0; i < 15; i++) {
      store.addFact('10001', '事实' + i.toString());
    }
    expect(store.get('10001')!.facts.length, 12);
    expect(store.get('10001')!.facts.last, '事实14');
    await tmp.delete(recursive: true);
  });

  test('发送者映射：主人写“主人本人”，不是主人要写“不是主人”', () async {
    final tmp = await Directory.systemTemp.createTemp('people8-');
    final store = PeopleStore(File(tmp.path + Platform.pathSeparator + 'people.json'));
    store.seen(
        qqId: '1838601405',
        nickname: '大星',
        chatKey: 'private:1838601405',
        isOwner: true);
    store.seen(qqId: '10001', nickname: '墨墨', chatKey: 'group:681145756');
    expect(store.ownerQQ, '1838601405');
    final asOwner =
        store.promptFor('1838601405', nickname: '大星', chatKey: 'private:1838601405');
    expect(asOwner.contains('主人(大星)'), isTrue);
    expect(asOwner.contains('你啊'), isTrue);
    final asGuest =
        store.promptFor('10001', nickname: '墨墨', chatKey: 'group:681145756');
    expect(asGuest.contains('群友(墨墨)'), isTrue);
    expect(asGuest.contains('别叫他主人'), isTrue);
    await tmp.delete(recursive: true);
  });

  test('没有档时也能判出主人（只有 owner 段也行）', () async {
    final tmp = await Directory.systemTemp.createTemp('people9-');
    final f = File(tmp.path + Platform.pathSeparator + 'people.json');
    await f.writeAsString('{"version":1,"owner":{"qqId":"1838601405","sessionId":"s"},"people":[]}');
    final store = PeopleStore(f);
    expect(store.ownerQQ, '1838601405');
    final line = store.promptFor('1838601405', chatKey: 'private:1838601405');
    expect(line.contains('主人('), isTrue);
    await tmp.delete(recursive: true);
  });

  test('actorOf：主人只在私聊算主人，群里同号不算', () async {
    final tmp = await Directory.systemTemp.createTemp('actor1-');
    final store = PeopleStore(File(tmp.path + Platform.pathSeparator + 'people.json'));
    store.seen(
        qqId: '1838601405',
        nickname: '大星',
        chatKey: 'private:1838601405',
        isOwner: true);
    final a = store.actorOf('1838601405', chatKey: 'private:1838601405');
    expect(a.isOwner, isTrue);
    expect(a.identityLine, contains('主人'));
    final b = store.actorOf('1838601405', chatKey: 'group:681145756');
    expect(b.isOwner, isFalse, reason: '群里同号不按主人私聊处理');
    expect(b.identityLine, contains('群友'));
    await tmp.delete(recursive: true);
  });

  test('陌生号在群里：身份行是群友，不是主人', () async {
    final tmp = await Directory.systemTemp.createTemp('actor2-');
    final store = PeopleStore(File(tmp.path + Platform.pathSeparator + 'people.json'));
    store.seen(
        qqId: '1838601405', nickname: '大星', chatKey: 'private:1838601405', isOwner: true);
    store.seen(qqId: '999', nickname: '路人', chatKey: 'group:681145756');
    final a = store.actorOf('999', chatKey: 'group:681145756', nickname: '路人');
    expect(a.isOwner, isFalse);
    expect(a.identityLine, '当前说话的是 群友(路人)');
    final line = store.promptFor('999', nickname: '路人', chatKey: 'group:681145756');
    expect(line.contains('别叫他主人'), isTrue);
    await tmp.delete(recursive: true);
  });

  test('会话冲突：群和主人私聊挂同一个 sessionId → 报冲突', () async {
    final tmp = await Directory.systemTemp.createTemp('actor3-');
    final store = PeopleStore(File(tmp.path + Platform.pathSeparator + 'people.json'));
    store.seen(
        qqId: '1838601405', nickname: '大星', chatKey: 'private:1838601405', isOwner: true);
    store.seen(qqId: '999', nickname: '路人', chatKey: 'group:681145756');
    store.useSessionResolver((k) =>
        k == 'private:1838601405' || k == 'group:681145756' ? 'session-x' : '');
    final c = store.sessionConflicts();
    expect(c.length, 1);
    expect(c.first.text.contains('会话冲突'), isTrue);
    expect(c.first.text.contains('session-x'), isTrue);
    await tmp.delete(recursive: true);
  });

  test('不同 sessionId 不算冲突', () async {
    final tmp = await Directory.systemTemp.createTemp('actor4-');
    final store = PeopleStore(File(tmp.path + Platform.pathSeparator + 'people.json'));
    store.seen(
        qqId: '1838601405', nickname: '大星', chatKey: 'private:1838601405', isOwner: true);
    store.seen(qqId: '999', nickname: '路人', chatKey: 'group:681145756');
    store.useSessionResolver((k) => k.startsWith('private') ? 's1' : 's2');
    expect(store.sessionConflicts(), isEmpty);
    await tmp.delete(recursive: true);
  });

  test('网关会话冲突文案：主人私聊和群共用 sessionId', () async {
    final tmp = await Directory.systemTemp.createTemp('conf1-');
    // 先确认世界根真的落在临时目录（前面几条测试改过全局单例）。
    final gw0 = createQqGateway();
    final st0 = await gw0.loginState();
    expect(st0, isNotNull);
    useQqConfigDirForTest(tmp.path);
    useQqWorldRootForTest(tmp.path);
    final dir = Directory(tmp.path + Platform.pathSeparator + '鱼的关系');
    await dir.create(recursive: true);
    await File(dir.path + Platform.pathSeparator + 'people.json').writeAsString(
        '{"version":1,"owner":{"qqId":"1838601405"},"people":[]}');
    await File(dir.path + Platform.pathSeparator + 'chats.json').writeAsString(
        '{"version":1,"items":['
        '{"chatKey":"private:1838601405","kind":"private","id":"1838601405","sessionId":"same"},'
        '{"chatKey":"group:681145756","kind":"group","id":"681145756","sessionId":"same","enabled":true}]}');
    final gw = createQqGateway();
    final st = await gw.loginState();
    final text = (st?['sessionConflict'] ?? '').toString();
    expect(text.contains('会话冲突'), isTrue);
    expect(text.contains('same'), isTrue);
    await tmp.delete(recursive: true);
  });

  test('网关：不同会话不报冲突', () async {
    final tmp = await Directory.systemTemp.createTemp('conf2-');
    useQqConfigDirForTest(tmp.path);
    useQqWorldRootForTest(tmp.path);
    final dir = Directory(tmp.path + Platform.pathSeparator + '鱼的关系');
    await dir.create(recursive: true);
    await File(dir.path + Platform.pathSeparator + 'people.json').writeAsString(
        '{"version":1,"owner":{"qqId":"1838601405"},"people":[]}');
    await File(dir.path + Platform.pathSeparator + 'chats.json').writeAsString(
        '{"version":1,"items":['
        '{"chatKey":"private:1838601405","kind":"private","id":"1838601405","sessionId":"a"},'
        '{"chatKey":"group:1","kind":"group","id":"1","sessionId":"b"}]}');
    final gw = createQqGateway();
    final st = await gw.loginState();
    expect((st?['sessionConflict'] ?? '').toString(), isEmpty);
    await tmp.delete(recursive: true);
  });
}
