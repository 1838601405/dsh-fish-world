import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/data/qq_gateway_io.dart';

// 主人 QQ 持久化三修：
//   ① 桌面版冷启动不再闪一帧空输入框（_desktop 三态，未知态不画主人卡）
//   ② 读写 qq_config.json 时把**绝对路径与实际值**打进 qq_config.log
//   ③ 写盘失败如实返回 ok=false（旧版 catch(_){} 会假成功）
//
// 为什么是源码级 + 真实临时目录：整页第一帧会拉真实 IO，widget 测试会挂死
// （既有约定，见 profile_desktop_test.dart 顶部）。这里判「接线在不在」
// 加上真实读写，一样能真红。
void main() {
  final profileSrc = File('lib/fish/fish_profile.dart').readAsStringSync();
  final gwSrc = File('lib/data/qq_gateway_io.dart').readAsStringSync();

  group('① 冷启动不再闪空的主人 QQ', () {
    test('_desktop 是三态，初值不再是 false', () {
      expect(profileSrc.contains('bool? _desktop;'), isTrue,
          reason: '_desktop 必须是可空三态，初值 false 会让首帧按面板分支渲染');
      expect(profileSrc.contains('bool _desktop = false;'), isFalse);
    });

    test('状态未知时不画主人卡，画骨架且不进任何分支', () {
      expect(profileSrc.contains('if (_desktop == null) {'), isTrue);
      expect(profileSrc.contains("id: 'pf-owner-wait'"), isTrue,
          reason: '未知态要有独立骨架卡，不能借用面板分支的主人卡');
      expect(profileSrc.contains('正在读本机配置…'), isTrue);
      // 骨架必须早于 final desktop = _desktop! 之前返回
      final waitIdx = profileSrc.indexOf('if (_desktop == null) {');
      final deskIdx = profileSrc.indexOf('final desktop = _desktop!;');
      expect(waitIdx, greaterThan(0));
      expect(deskIdx, greaterThan(waitIdx), reason: '骨架分支必须先 return，才能拦住空值渲染');
    });

    test('模式确定要走 setState，骨架能切回真实卡', () {
      // 用正则容忍空格差异：判据不该因为一个空格就假红。
      expect(RegExp(r'setState\(\(\)\s*=>\s*_desktop\s*=\s*isDesktop\)').hasMatch(profileSrc), isTrue,
          reason: '不 setState 的话骨架永远停在那儿');
    });

    test('未知态不许保存（连写哪条路径都不知道）', () {
      expect(profileSrc.contains('_desktop != null && (_desktop! || _bridge)'), isTrue);
    });
  });

  group('② 读写都打绝对路径与值', () {
    test('有审计函数，且落在与配置同目录的日志文件', () {
      expect(gwSrc.contains('void _audit(String line)'), isTrue);
      expect(gwSrc.contains("'qq_config.log'"), isTrue);
    });

    test('读的时候打路径 + ownerQQ', () {
      expect(gwSrc.contains("_audit('READ  '"), isTrue);
      expect(gwSrc.contains('f.path'), isTrue);
      expect(gwSrc.contains("_auditValue('ownerQQ', m['ownerQQ'])"), isTrue);
    });

    test('写的时候打路径 + ownerQQ + ownerQQSavedAt', () {
      expect(gwSrc.contains("_audit('WRITE '"), isTrue);
      expect(gwSrc.contains("_auditValue('ownerQQ', c['ownerQQ'])"), isTrue);
      expect(gwSrc.contains("_auditValue('ownerQQSavedAt', c['ownerQQSavedAt'])"), isTrue);
    });

    test('真实跑一遍：日志里出现绝对路径和写入的值', () async {
      final tmp = await Directory.systemTemp.createTemp('qq-audit-');
      useQqConfigDirForTest(tmp.path);
      useQqWorldRootForTest(tmp.path);
      final gw = createQqGateway();
      await gw.saveField('ownerQQ', '1838601405');
      final log = File(tmp.path + Platform.pathSeparator + 'qq_config.log');
      expect(log.existsSync(), isTrue, reason: '应当生成审计日志');
      final text = log.readAsStringSync();
      final cfgPath = tmp.path + Platform.pathSeparator + 'qq_config.json';
      expect(text.contains(cfgPath), isTrue, reason: '日志必须带配置文件的绝对路径');
      expect(text.contains('WRITE'), isTrue);
      expect(text.contains('1838601405'), isTrue, reason: '日志要带写入的值');
      expect(text.contains('ownerQQSavedAt'), isTrue);
      await tmp.delete(recursive: true);

      useQqConfigDirForTest(Directory.systemTemp.path);
      useQqWorldRootForTest(Directory.systemTemp.path);
    });
  });

  group('③ 写盘失败如实报错，不假成功', () {
    test('_saveCfg 返回 bool，不再静默吞', () {
      expect(gwSrc.contains('bool _saveCfg(Map<String, dynamic> c)'), isTrue,
          reason: '旧版 void + catch(_){} 会假成功');
      expect(gwSrc.contains("_audit('WRITE ' + f.path + '  <失败：'"), isTrue);
      expect(gwSrc.contains('return false;'), isTrue);
    });

    test('saveField 写失败回 ok=false 且带 error', () {
      expect(gwSrc.contains("return {'ok': false, 'error': '写不进本机配置"), isTrue);
      expect(gwSrc.contains("'SAVE-FAIL key='"), isTrue);
    });

    test('setReceiving / saveConfig 也不再假装成功', () {
      expect(gwSrc.contains("if (!ok) return {'ok': false, 'running': running"), isTrue);
      expect(gwSrc.contains("if (!ok) return {'ok': false, 'error': '写不进本机配置'"), isTrue);
    });

    test('界面侧真的消费这个 ok（失败会走到红字分支）', () {
      // 网关报了 false，界面必须跟着失败——否则前面那些都白搭。
      expect(
          profileSrc.contains("if (qq != null) ok = (await qqGateway.saveField('ownerQQ', qq))?['ok'] == true && ok;"),
          isTrue,
          reason: '界面必须读 saveField 的 ok，不能假定成功');
      expect(profileSrc.contains('_ownerFailMsg = '), isTrue);
      expect(profileSrc.contains('_ownerFailInline'), isTrue);
    });

    test('真把目录变成不可写，saveField 必须回 ok=false（真红判据）', () async {
      final tmp = await Directory.systemTemp.createTemp('qq-ro-');
      useQqConfigDirForTest(tmp.path);
      useQqWorldRootForTest(tmp.path);
      final gw = createQqGateway();
      // 先删掉临时目录并让父路径不可用：用一个「父路径是文件」的假目录，
      // createSync(recursive:true) 会失败（Windows 上比 icacls 稳）。
      final blocker = File(tmp.path + Platform.pathSeparator + 'blocked');
      blocker.writeAsStringSync('x');
      final bad = Directory(blocker.path + Platform.pathSeparator + 'cfg');
      useQqConfigDirForTest(bad.path);
      final gw2 = createQqGateway();
      final r = await gw2.saveField('ownerQQ', '123456789');
      expect(r?['ok'], isFalse, reason: '写不进必须回 ok=false，不能假装保存成功');
      expect((r?['error'] ?? '').toString(), isNotEmpty, reason: '要给出原因');

      useQqConfigDirForTest(Directory.systemTemp.path);
      useQqWorldRootForTest(Directory.systemTemp.path);
      await tmp.delete(recursive: true);
    });
  });

  group('连带：ownerQQ 与时间戳一次写盘', () {
    test('不再「先写号、再补时间戳、再写一次」', () {
      // 旧写法中间那次失败会被吞，结果磁盘上有号没时间戳（现场就是这样）。
      // 判据：时间戳赋值必须出现在**saveField 里那次唯一的** _saveCfg 之前。
      // （源码里有两处 `final ok = _saveCfg(c)`，要取 saveField 那一处，
      //  取 indexOf 会撞上前面 setReceiving/saveConfig 的，导致假红。）
      expect(gwSrc.contains("c['ownerQQSavedAt'] = qq.isEmpty ? '' : DateTime.now()"), isTrue);
      final stampIdx = gwSrc.indexOf("c['ownerQQSavedAt'] = qq.isEmpty");
      final ownerKeyIdx = gwSrc.indexOf("if (key == 'ownerQQ') {");
      final saveInSaveField = gwSrc.indexOf('final ok = _saveCfg(c);', ownerKeyIdx);
      expect(stampIdx, greaterThan(0));
      expect(ownerKeyIdx, greaterThan(0));
      expect(saveInSaveField, greaterThan(stampIdx),
          reason: '时间戳要先放进去，再一次写盘（中间不要有第二次 _saveCfg）');
      // 且 saveField 里不该出现第二次写盘
      final second = gwSrc.indexOf('final ok = _saveCfg(c);', saveInSaveField + 1);
      final nextMethod = gwSrc.indexOf('void _ensureOwnerChat', saveInSaveField);
      expect(second < 0 || second > nextMethod, isTrue,
          reason: 'saveField 里只能写一次盘，写两次就等于把「先号后时间戳」的问题带回来');
    });

    test('真实读写：号和时间戳都落盘', () async {
      final tmp = await Directory.systemTemp.createTemp('qq-stamp-');
      useQqConfigDirForTest(tmp.path);
      useQqWorldRootForTest(tmp.path);
      final gw = createQqGateway();
      await gw.saveField('ownerQQ', '1838601405');
      final raw = jsonDecode(
              File(tmp.path + Platform.pathSeparator + 'qq_config.json').readAsStringSync())
          as Map;
      expect(raw['ownerQQ'], '1838601405');
      expect((raw['ownerQQSavedAt'] ?? '').toString(), isNotEmpty,
          reason: '时间戳必须和号一起落盘，否则重启后看不到「上次保存」');
      await tmp.delete(recursive: true);

      useQqConfigDirForTest(Directory.systemTemp.path);
      useQqWorldRootForTest(Directory.systemTemp.path);
    });
  });
}
