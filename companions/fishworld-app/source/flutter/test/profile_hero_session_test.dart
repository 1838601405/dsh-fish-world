import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/fish/fish_common.dart';

// 「鱼的样子」卡显示错乱 + 红卡「请选一个 DSH 会话」两起。
//
// 1. _ProfileHero 不再整段渲染人设正文（正文开头是标题+════分隔线+空行，
//    分隔线在小卡里看着像空输入框下划线）。改成固定文案「当前角色 · <id>」。
// 2. 人设正文预览统一过滤 markdown 分隔线 → personaSummaryLine()。
// 3. 红卡是真报错，根因是读错了键：后端 ownerBinding() 返回
//    {qq, session:{bridge,config,relation}}，**没有 sessionId 键**；
//    之前读 owner['sessionId'] 恒为空 ⇒ 一保存就被后端拒。
void main() {
  final profileSrc = File('lib/fish/fish_profile.dart').readAsStringSync();

  group('① 鱼的样子卡不再渲染人设正文', () {
    test('_ProfileHero 不再引用 personaText', () {
      final idx = profileSrc.indexOf('class _ProfileHero');
      final end = profileSrc.indexOf('// 测试钩子', idx);
      final hero = profileSrc.substring(idx, end);
      expect(hero.contains('personaText'), isFalse,
          reason: '正文归「人设卡」，鱼的样子卡别再整段塞进来');
      expect(hero.contains('maxLines: 3'), isFalse,
          reason: '原来就是 maxLines:3 直接截正文前 3 行，把分隔线也截进来了');
    });

    test('改成固定文案「当前角色 · <roleId>」', () {
      final idx = profileSrc.indexOf('class _ProfileHero');
      final end = profileSrc.indexOf('// 测试钩子', idx);
      final hero = profileSrc.substring(idx, end);
      expect(hero.contains("'当前角色 · ' + roleId"), isTrue);
      expect(hero.contains("roleId.isEmpty ? '当前角色'"), isTrue);
    });

    test('没有重复的「DeepSeek 小鲸鱼 · 角色卡」标题行', () {
      // 卡片标题已是「鱼的样子」，正文第一行标题不该再出现一次。
      final idx = profileSrc.indexOf('class _ProfileHero');
      final end = profileSrc.indexOf('// 测试钩子', idx);
      final hero = profileSrc.substring(idx, end);
      expect(hero.contains('角色卡'), isFalse);
      expect(hero.contains('小鲸鱼'), isFalse);
    });
  });

  group('② personaSummaryLine 跳过标题/分隔线/空行', () {
    test('真实正文开头：跳过标题行和 ════ 分隔线', () {
      const body = 'DeepSeek 小鲸鱼 · 角色卡\n'
          '════════════════════════════════════════\n'
          '\n'
          '【适用】QQ 群、私聊、任何聊天平台都行';
      final s = personaSummaryLine(body);
      expect(s, startsWith('【适用】'), reason: '分隔线和标题都要跳掉');
      expect(s.contains('═'), isFalse, reason: '摘要里不许带分隔线');
    });

    test('各种分隔线都跳过（═ ─ = - _ * ·）', () {
      const body = '标题\n'
          '════════\n'
          '────────\n'
          '========\n'
          '--------\n'
          '________\n'
          '********\n'
          '········\n'
          '真正的内容行';
      expect(personaSummaryLine(body), '真正的内容行');
    });

    test('跳过 markdown 标题（# 开头）', () {
      const body = '# 一级标题\n## 二级标题\n正文在这里';
      expect(personaSummaryLine(body), '正文在这里');
    });

    test('超过 60 字截断并加省略号', () {
      final long = '啊' * 80;
      final s = personaSummaryLine(long);
      expect(s.endsWith('…'), isTrue);
      // 60 个字符 + 省略号
      expect(s.runes.length, 61);
    });

    test('中文按 runes 截断，不切坏多字节', () {
      final s = personaSummaryLine('测' * 100, maxChars: 10);
      expect(s, '测' * 10 + '…');
    });

    test('空正文 / 全分隔线 → 空串（调用方自己兜底文案）', () {
      expect(personaSummaryLine(''), '');
      expect(personaSummaryLine('   \n\n  '), '');
      expect(personaSummaryLine('────\n====\n'), '');
    });
  });

  group('③ 红卡：主人会话读对了键', () {
    test('从 owner.session.bridge 取会话 id（不是 owner[sessionId]）', () {
      expect(profileSrc.contains('String _sessionIdFromOwner(Map<dynamic, dynamic> owner)'),
          isTrue);
      final idx = profileSrc.indexOf('String _sessionIdFromOwner');
      final body = profileSrc.substring(idx, idx + 600);
      expect(body.contains("owner['session']"), isTrue,
          reason: '后端 ownerBinding() 把会话放在嵌套 session 段里');
      expect(body.contains("nested['bridge']"), isTrue);
      // 平的 sessionId 只作兜底，且必须在嵌套之后
      final nestedIdx = body.indexOf("nested['bridge']");
      final flatIdx = body.indexOf("owner['sessionId']");
      expect(flatIdx, greaterThan(nestedIdx),
          reason: '嵌套是真源，平的只兜底');
    });

    test('没有可用会话时默认落到会话列表第一条', () {
      expect(profileSrc.contains('String _defaultSessionFrom(List<dynamic> sessions)'),
          isTrue);
      final idx = profileSrc.indexOf('String _defaultSessionFrom');
      final body = profileSrc.substring(idx, idx + 400);
      expect(body.contains("(e['id'] ?? '').toString().trim()"), isTrue);
      expect(body.contains('if (id.isNotEmpty) return id;'), isTrue);
    });

    test('会话下拉有合法「不用会话」项，且空值不是错误态', () {
      // 2026-11-19 规则改：没会话 = API 直回，是**合法模式**不是错误。
      // 所以原来那条「去选会话」入口和「保存会被拒」红字都不该再存在。
      expect(profileSrc.contains("Text('不用会话 · API 直接回复'"), isTrue,
          reason: '下拉要有默认项，明确告诉用户不选会话也行');
      expect(profileSrc.contains('还没选会话，保存会被拒'), isFalse,
          reason: '没会话不再等于保存会被拒');
      expect(profileSrc.contains('errorText: _ownerSession.isEmpty'), isFalse,
          reason: '空会话不该画成错误态');
    });

    test('会话下拉仍可聚焦（键盘可达）', () {
      // 「去选会话」按钮没了，但下拉本身仍要能聚焦——这是键盘可达的底线。
      expect(profileSrc.contains('focusNode: _sessionFocus'), isTrue);
      expect(profileSrc.contains("FishNav.registerField('pf-owner-session', _sessionFocus)"),
          isTrue);
    });

    test('会话下拉的 focusNode 有注册与释放', () {
      expect(profileSrc.contains("FishNav.registerField('pf-owner-session', _sessionFocus)"),
          isTrue);
      expect(profileSrc.contains('_sessionFocus.dispose()'), isTrue);
      expect(profileSrc.contains("FishNav.fields.remove('pf-owner-session')"), isTrue);
    });
  });
}
