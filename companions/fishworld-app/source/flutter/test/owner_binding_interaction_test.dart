import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/fish_nav.dart';
import 'package:whale_girl/sidebar.dart';

// 两处交互修的判据（源码级 + 导航单元级，不跑整页）：
//   A.「要改去绑主人会话」必须是**真控件**（可点 + Tab 可达 + Enter 触发），
//     并且它要跳到**真锚点**上——这条以前会假绿：FishCard 的 id 只是便当格坐标，
//     不注册 FishNav 锚点，写了 FishNav.focus('X') 也找不到东西。
//   B. 保存绑定的回读必须比对**输入值**，不是只判非空。
//
// 为什么读源码： fishes 整页首帧拉真实 IO，widget 测试会挂死（实测三次，
// 见 profile_desktop_test.dart 顶部说明）。这里判「接线在不在」，一样能真红。
void main() {
  final qqSrc = File('lib/fish/fish_qq.dart').readAsStringSync();
  final profileSrc = File('lib/fish/fish_profile.dart').readAsStringSync();

  group('问题 A：「去绑主人会话」是入口，不是蓝字', () {
    test('不再是塞在正文里的半句话', () {
      // 旧写法：字符串里带「要改去绑主人会话」——纯文字，不可点。
      expect(qqSrc.contains('要改去绑主人会话'), isFalse,
          reason: '入口不能还留在正文句子里');
      // 规则句保留（这是规则，不是补丁）。
      expect(qqSrc.contains('主人私聊由 QQ 桥直连，不用加白名单'), isTrue);
    });

    test('入口是真控件：TextButton 才能 Tab 聚焦 / Enter 触发', () {
      expect(qqSrc.contains('_goBindOwnerButton'), isTrue);
      expect(qqSrc.contains('TextButton.icon'), isTrue);
      // onPressed 非空 = 可聚焦可触发；纯文字没有这个入口。
      expect(qqSrc.contains('onPressed: go'), isTrue);
      expect(qqSrc.contains("label: Text('去绑主人会话'"), isTrue);
    });

    test('跳到真锚点，并且顺手聚焦 QQ 输入框', () {
      expect(
        qqSrc.contains("FishNav.focus(NavRoute.profile, 'pf-owner', field: 'pf-owner-qq')"),
        isTrue,
        reason: '跳转目标必须是 profile 页的 pf-owner，并聚焦输入框',
      );
      // 输入框真的注册了这个 field 名，否则 requestFocus 是空调用。
      expect(profileSrc.contains("FishNav.registerField('pf-owner-qq'"), isTrue);
    });

    test('pf-owner 必须注册成锚点（FishCard 的 id 不算）', () {
      // 这条是补的真窟窿：FishCard(id:'pf-owner') 不会注册 FishNav 锚点。
      // 现在用 FishCard 自带的 anchor 参数注册（在 buildPanel 里包 FishAnchor）。
      expect(profileSrc.contains("anchor: 'pf-owner'"), isTrue,
          reason: 'pf-owner 没注册锚点，跳转点会落空');
      // ★ 反面：不许在外面再套一层 FishAnchor —— 那会换掉类型，
      // 让 fishPageBody 认不出 FishCard，宽度从 1400 掉到 460 并溢出（真红过 203px）。
      expect(profileSrc.contains("FishAnchor(\n        anchor: 'pf-owner'"), isFalse,
          reason: '外层再包 FishAnchor 会让 FishCard 掉出便当格宽度，撑爆布局');
    });

    test('FishCard 的 anchor 参数真的把面板包进 FishAnchor', () {
      // 锚点长在 FishCard 自己身上，类型不变 —— 这是上面那条能成立的前提。
      final commonSrc = File('lib/fish/fish_common.dart').readAsStringSync();
      expect(commonSrc.contains('final String? anchor;'), isTrue);
      expect(commonSrc.contains('return FishAnchor(anchor: a, child: panel);'), isTrue);
      expect(commonSrc.contains('if (a.isEmpty) return panel;'), isTrue,
          reason: '没设 anchor 的卡必须原样返回，不能多包一层');
    });

    test('锚点确实落进 FishNav.anchors（真跑注册路径）', () {
      // 直接验 FishNav 的注册接口：包了 FishAnchor 就会走到这里。
      // 注意别去读 key.currentContext —— 那需要 WidgetsBinding 已初始化，
      // 这条是纯单元断言，读 context 会抛「Binding has not yet been initialized」。
      final key = GlobalKey();
      FishNav.registerAnchor('pf-owner', key);
      expect(FishNav.anchors['pf-owner'], same(key));
      FishNav.anchors.remove('pf-owner');
      expect(FishNav.anchors.containsKey('pf-owner'), isFalse);
    });
  });

  group('问题 B：保存绑定要有实感', () {
    test('点击瞬间进 loading（按钮禁用 + 转圈 + 保存中…）', () {
      expect(profileSrc.contains('_binding = true'), isTrue);
      expect(profileSrc.contains('enabled: !_binding'), isTrue);
      expect(profileSrc.contains('CircularProgressIndicator'), isTrue);
      expect(profileSrc.contains('保存中…'), isTrue);
      // 太快也要停一下，否则像没点上。
      expect(profileSrc.contains('spent < 320'), isTrue);
    });

    test('成功：直接进已绑定，按钮恒为「保存」，不闪「已保存」', () {
      // ★ 2026-11-21 主人改的口径：保存成功 = 直接进「已绑定」，
      //   按钮恢复「保存」，**不要**闪「已保存」——状态已经由右边那行说清楚了。
      //   旧判据要求必须有 `? '已保存'` 和 1.5s 定时器，那条现在反了。
      expect(profileSrc.contains("? '已保存'"), isFalse,
          reason: '按钮不该闪「已保存」（2026-11-21 主人要求）');
      expect(profileSrc.contains('_justSaved'), isFalse,
          reason: '临时态整套清掉了');
      // 绑定行仍是「已绑定 · 号 · 时间」；2026-11-19 起后面还要带回复模式。
      // 用正则认前缀，别钉死整句——加模式后缀不该让这条红。
      expect(RegExp(r"'已绑定 · '\s*\+\s*_boundQQ").hasMatch(profileSrc), isTrue);
      expect(profileSrc.contains("'上次保存 ' + _boundAt"), isTrue);
      expect(profileSrc.contains('WhaleTokens.successFor'), isTrue);
    });

    test('回读要比对输入值，不是只判非空（这条以前是漏的）', () {
      expect(profileSrc.contains('final want = (qq ?? \'\').trim();'), isTrue);
      expect(profileSrc.contains('saved != want'), isTrue,
          reason: '回读只判 isEmpty 会让「写错号也算成功」过关');
      expect(profileSrc.contains('回读与输入不一致'), isTrue);
    });

    test('失败就地红字 + 原因 + 重试，不吞错', () {
      expect(profileSrc.contains('_ownerFailInline'), isTrue);
      expect(profileSrc.contains("child: const Text('重试')"), isTrue);
      expect(profileSrc.contains('_ownerFailMsg = '), isTrue);
    });

    test('重启后仍显示上次保存的号与时间', () {
      expect(profileSrc.contains("cfg['ownerQQSavedAt']"), isTrue);
      expect(profileSrc.contains('_shortStamp'), isTrue);
    });
  });
}
