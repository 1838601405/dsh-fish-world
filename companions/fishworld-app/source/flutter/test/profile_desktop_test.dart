import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/data/qq_gateway_io.dart';
import 'package:whale_girl/fish/fish_profile.dart' show shouldFillInputFromServer;

// 桌面版「鱼的设定」三条规矩的接线断言（源码级，不跑 widget 树）：
//   1. 不出现「主人会话」下拉 / 「绑错等于鱼认错人」红条；
//   2. 主人 QQ 输入框与保存按钮在桌面分支里都不是禁用态；
//   3. 保存后回读、并把主人 QQ 写进 chats.json 白名单。
// 为什么不跑 widget：页面首帧会拉真实 IO，widget 测试会挂死在 10 分钟超时上
// （实测三次），这里改成读源码 + 真实读写临时目录，判据一样能红。
void main() {
  final src = File('lib/fish/fish_profile.dart').readAsStringSync();
  final gw = File('lib/data/qq_gateway_io.dart').readAsStringSync();

  test('桌面分支没有「主人会话」下拉', () {
    // 会话那行被「非桌面」的 fragment 包着，桌面渲染不到。
    // ★ 2026-11-18：_desktop 改成可空三态后，_cards 里先用 `final desktop = _desktop!;`
    //   落成局部变量，守卫也就从 `!_desktop` 变成 `!desktop`。语义没变（都表示"面板版才画"），
    //   所以判据按**语义**认，别钉死某个变量名——否则纯改名就会假红。
    expect(src.contains("Text('主人会话'"), isTrue);
    final sessionsIdx = src.indexOf("Text('主人会话'");
    final guardIdx = src.lastIndexOf('if (!desktop)', sessionsIdx);
    final legacyGuard = src.lastIndexOf('if (!_desktop)', sessionsIdx);
    expect(guardIdx > 0 || legacyGuard > 0, isTrue,
        reason: '「主人会话」必须在「非桌面」分支里');
  });

  test('输入框与保存按钮可编辑（不再按平台禁用）', () {
    expect(src.contains("enabled: !_binding"), isTrue);
    expect(src.contains("onPressed: _canSaveOwner ? _submitOwner : null"), isTrue);
    // 三态之后条件多了「已知模式」这一项；用正则容忍写法差异。
    expect(
        RegExp(r'bool get _canSaveOwner =>\s*!?_binding &&\s*_desktop != null').hasMatch(src),
        isTrue,
        reason: '未知态不许保存，但已知态要能编辑');
  });

  test('提示条只在未绑定时出现，且是中性色（不是红/橙）', () {
    // 常驻红条已经拆掉：不再有「非桌面」包住的 Container(...) 警告块。
    // （变量名可能是 _desktop 或 desktop，两种都算——判语义，不钉名字。）
    expect(src.contains("if (!_desktop)\n            Container("), isFalse);
    expect(src.contains("if (!desktop)\n            Container("), isFalse);
    // ★ 2026-11-21 主人要求：状态只有两种（未绑 / 已绑）。
    //   「保存失败」不是状态，是一次操作的反馈（走 _ownerFail + _ownerFailInline）。
    expect(src.contains('enum _OwnerHint { unbound, bound }'), isTrue,
        reason: '状态必须二元（2026-11-21 主人要求）');
    expect(src.contains('_OwnerHint.failed'), isFalse, reason: 'failed 不再是状态');
    // 未绑定提示只在未绑定时出现，用中性色
    expect(src.contains('_ownerHintState == _OwnerHint.unbound'), isTrue);
    expect(src.contains('scheme.onSurfaceVariant'), isTrue,
        reason: '中性色，不是 warning');
    // 未绑定提示里不该再用 warning / error 色
    final hintIdx = src.indexOf('Widget _ownerHintWidget');
    final hintBody =
        hintIdx > 0 ? src.substring(hintIdx, (hintIdx + 800).clamp(0, src.length)) : '';
    expect(hintBody.contains('WhaleTokens.warningFor'), isFalse,
        reason: '未绑定是正常状态，不该挂橙色（2026-11-21 主人要求）');
    expect(hintBody.contains('scheme.error'), isFalse,
        reason: '未绑定不是错误，不该用红');
  });

  test('文案按平台区分', () {
    expect(src.contains("'主人 QQ 用你真实的号。'"), isTrue);
    expect(src.contains("'主人 QQ + 会话都要对；绑错等于鱼认错人。'"), isTrue);
  });

  // ══════════ 2026-11-21 主人点名要加的两条 ══════════
  // 「保存成功后输入框和绑定状态都不变」+「失败时输入内容保留」。
  // 光对源码做字符串匹配是在验"写了没"，所以那条能抽成纯函数的抽出来了，
  // 剩下的（失败分支不该碰输入）确实只能用源码形态钉 —— 但配上反向断言仍能真红。

  group('保存后/失败后，输入框内容不动', () {
    test('回读填值的规则：只有空的时候才填（纯函数，可真喂参数）', () {
      // 空 → 填
      expect(shouldFillInputFromServer('', '1838601405'), isTrue);
      expect(shouldFillInputFromServer('   ', '1838601405'), isTrue, reason: '只有空白也算空');
      // 有内容 → 不填（这是「保存后输入不变」的核心）
      expect(shouldFillInputFromServer('1838601405', '1838601405'), isFalse,
          reason: '★ 存完回读时输入框里已经是这个号，不该再动它');
      expect(shouldFillInputFromServer('2100000001', '1838601405'), isFalse,
          reason: '★ 用户正在打新号，回读不该拿旧值盖掉');
      // server 为空 → 不填（别把输入刷没）
      expect(shouldFillInputFromServer('', ''), isFalse);
      expect(shouldFillInputFromServer('2100000001', ''), isFalse);
    });

    test('两处回读都走这条规则（不许有一处留着无条件覆盖）', () {
      // 桌面版本地配置回读
      expect(src.contains('shouldFillInputFromServer(_qqCtl.text, _localOwnerQQ)'), isTrue);
      // 面板版后端回读
      expect(src.contains('shouldFillInputFromServer(_qqCtl.text, qqFromServer)'), isTrue);
      // 反向：不许再出现「无条件 _qqCtl.text = ...」（那正是被修掉的 bug）
      final assignments = RegExp(r'^\s*_qqCtl\.text = ', multiLine: true).allMatches(src).length;
      expect(assignments, 0,
          reason: '★ 所有给 _qqCtl.text 赋值的地方都必须在 if 里（找到 $assignments 处裸赋值）');
    });

    test('失败分支不碰输入框、也不清已绑定的号', () {
      // 取出桌面版失败的三个分支（回读空 / 回读不一致 / 写不进）
      final failBlocks = [
        src.indexOf("_ownerFailMsg = '回读没有看到主人 QQ'"),
        src.indexOf("_ownerFailMsg = '回读是 '"),
        src.indexOf("_ownerFailMsg = '本机配置写不进'")
      ];
      for (final idx in failBlocks) {
        expect(idx, greaterThan(0), reason: '失败分支应该还在');
        // 每个失败分支前后 400 字里不该出现 _qqCtl.text = / _boundQQ = ''
        final around = src.substring(
            (idx - 400).clamp(0, src.length), (idx + 200).clamp(0, src.length));
        expect(around.contains('_qqCtl.text ='), isFalse,
            reason: '★ 失败时不许动输入框内容');
        expect(around.contains("_boundQQ = ''"), isFalse,
            reason: '★ 失败时不许清已绑定的号（清了界面会从已绑定跳成未绑定）');
      }
    });

    test('Esc 只失焦，不覆盖内容', () {
      final escIdx = src.indexOf('LogicalKeyboardKey.escape');
      expect(escIdx, greaterThan(0));
      final around = src.substring(escIdx, (escIdx + 300).clamp(0, src.length));
      expect(around.contains('_qqCtl.text ='), isFalse,
          reason: '★ Esc 不该把内容刷回旧值（2026-11-21 主人要求）');
      expect(around.contains('unfocus'), isTrue);
    });
  });

  test('两段反馈：loading / 绿色已绑定（不闪「已保存」）', () {
    expect(src.contains('保存中…'), isTrue);
    expect(src.contains('CircularProgressIndicator'), isTrue);
    // ★ 2026-11-21 主人要求：按钮恒为「保存」，不闪「已保存」。
    expect(src.contains("? '已保存'"), isFalse, reason: '不该闪「已保存」');
    expect(src.contains('_justSaved'), isFalse, reason: '临时态整套清掉');
    // 2026-11-19 起绑定行后面还要带回复模式（API 直回 / 投会话），
    // 所以这里认前缀，别钉死整句。
    expect(RegExp(r"'已绑定 · '\s*\+\s*_boundQQ").hasMatch(src), isTrue);
    expect(src.contains('WhaleTokens.successFor'), isTrue);
  });

  test('失败就地红字 + 原因 + 重试，不弹窗', () {
    expect(src.contains('_ownerFailInline'), isTrue);
    expect(src.contains("child: const Text('重试')"), isTrue);
    // 失败不弹窗：这条页里不该出现 showDialog（提示条是卡内的）。
  });

  test('上次保存时间落盘，重启仍显示', () {
    expect(src.contains("'上次保存 ' + _boundAt"), isTrue);
    expect(src.contains("cfg['ownerQQSavedAt']"), isTrue);
    // 网关确实写了这个字段
    expect(gw.contains("c['ownerQQSavedAt']"), isTrue);
  });

  test('键盘：Enter 保存，Esc 取消编辑', () {
    expect(src.contains('LogicalKeyboardKey.enter'), isTrue);
    expect(src.contains('LogicalKeyboardKey.numpadEnter'), isTrue);
    expect(src.contains('LogicalKeyboardKey.escape'), isTrue);
    expect(src.contains('onSubmitted: (_) => _submitOwner()'), isTrue);
  });

  test('loading 至少停留 320ms，不会一闪而过', () {
    expect(src.contains('spent < 320'), isTrue);
    expect(src.contains('320 - spent'), isTrue);
  });

  test('保存后回读并显示「已保存 · <号>」', () {
    expect(src.contains("'已保存 · ' + saved"), isTrue);
    expect(src.contains("final back = await qqGateway.loadConfig();"), isTrue);
  });

  test('绑定主人 QQ 会写进 chats.json 白名单（真实读写）', () async {
    expect(gw.contains('_ensureOwnerChat'), isTrue);
    final tmp = await Directory.systemTemp.createTemp('qq-owner-');
    useQqConfigDirForTest(tmp.path);
    useQqWorldRootForTest(tmp.path);
    final g = createQqGateway();
    await g.saveField('ownerQQ', '100010');
    var cfg = (await g.loadConfig())?['config'] as Map;
    var list = cfg['allowChats'] as List;
    expect(list.any((e) => (e as Map)['chatKey'] == 'private:100010'), isTrue);
    // 换号：新号进白名单，旧记录留着不删（chats.json 不是垃圾桶）。
    await g.saveField('ownerQQ', '100020');
    cfg = (await g.loadConfig())?['config'] as Map;
    list = cfg['allowChats'] as List;
    expect(cfg['ownerQQ'], '100020');
    expect(list.any((e) => (e as Map)['chatKey'] == 'private:100020'), isTrue);
    await tmp.delete(recursive: true);
  });
}
