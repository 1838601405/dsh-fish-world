import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

// 主人绑定：会话不是前提（2026-11-19 主人定）
//   · 有会话 → 投会话；没会话 → API 直回。
//   · 不许因为「没选会话」拒绝保存。
//
// 这是**跨仓判据**：后端（E:\dsh_fish_world）与前端（本仓）都要对。
void main() {
  final pluginLib = Directory('E:/dsh_fish_world/lib');
  final hasPlugin = pluginLib.existsSync();
  final backendFiles = <String, String>{};
  if (hasPlugin) {
    for (final name in ['chat-api.mjs', 'world.mjs', 'http.mjs', 'index.js']) {
      final f = File('E:/dsh_fish_world/lib/' + name);
      if (f.existsSync()) backendFiles[name] = f.readAsStringSync();
    }
  }
  final profileSrc = File('lib/fish/fish_profile.dart').readAsStringSync();

  group('后端 · 保存不再要求会话', () {
    test('校验里没有「请选一个 DSH 会话」这句了', () {
      if (!hasPlugin) return;
      final world = backendFiles['world.mjs'] ?? '';
      expect(world.contains('请选一个 DSH 会话当主人会话'), isFalse,
          reason: '这句是旧规则的门禁，新规则下不许再出现');
      expect(world.contains('还没有主人会话：世界数据建不起来'), isFalse,
          reason: '没会话不再等于建不起来');
    });

    test('setOwner 空会话返回 mode=api，不抛错', () {
      if (!hasPlugin) return;
      final world = backendFiles['world.mjs'] ?? '';
      final idx = world.indexOf('function setOwner(');
      final body = world.substring(idx, idx + 2600);
      expect(body.contains("{ mode: 'api', workspace: false }"), isTrue,
          reason: '空会话要合法并明确告知走 api');
      expect(body.contains("mode: 'session'"), isTrue);
      // 空的 targetSession 不能再被当成「用户没传」
      expect(body.contains('if (wantSession)'), isTrue,
          reason: '只有「给了会话」才校验存在性');
    });

    test('ownerReplyMode：空 → api，有值 → session', () {
      if (!hasPlugin) return;
      final api = backendFiles['chat-api.mjs'] ?? '';
      expect(api.contains('export function ownerReplyMode(ownerSession)'), isTrue);
      final idx = api.indexOf('export function ownerReplyMode');
      final body = api.substring(idx, idx + 400);
      expect(body.contains("return sid ? 'session' : 'api'"), isTrue);
    });
  });

  group('后端 · 回复路径按模式分派', () {
    test('主人私聊不再被无条件钉死成「走会话」', () {
      if (!hasPlugin) return;
      final api = backendFiles['chat-api.mjs'] ?? '';
      final idx = api.indexOf('export function shouldUseChatApi');
      final body = api.substring(idx, idx + 900);
      expect(body.contains('ownerSession'), isTrue,
          reason: '路由必须看会话有没有绑');
      expect(body.contains("return ownerReplyMode(ownerSession) === 'api'"), isTrue);
      // 旧写法是 `if (k === 'private' && ... u === owner) return false` —— 无条件走会话
      expect(body.contains('if (k === \'private\' && owner && u === owner) return false'), isFalse,
          reason: '无条件把主人私聊钉成会话，就是这次要拆掉的东西');
    });

    test('index.js 把 ownerSession 传进路由', () {
      if (!hasPlugin) return;
      final idx = backendFiles['index.js'] ?? '';
      final pos = idx.indexOf('function shouldUseChatApi(message)');
      final body = idx.substring(pos, pos + 900);
      expect(body.contains('ownerSession'), isTrue);
      expect(body.contains('rel.sessionId'), isTrue);
    });

    test('API 路径与会话路径共用同一套人设 + 记忆', () {
      if (!hasPlugin) return;
      final idx = backendFiles['index.js'] ?? '';
      final pos = idx.indexOf('async function deliverViaChatApi');
      final body = idx.substring(pos, pos + 2600);
      expect(body.contains('personaForPrompt'), isTrue, reason: 'API 路径必须喂人设');
      expect(body.contains('systemMemoryBrief'), isTrue, reason: 'API 路径必须喂记忆');
      // 隐私隔离也要在：记忆按这条回复的场子筛
      expect(body.contains('audience'), isTrue);
    });
  });

  group('前端 · 下拉有「不用会话」且不是错误态', () {
    test('下拉有默认项「不用会话 · API 直接回复」', () {
      expect(profileSrc.contains("Text('不用会话 · API 直接回复'"), isTrue);
      // 空串必须是合法选项，不能再被当成「没选」
      expect(profileSrc.contains("value: _ownerSession,"), isTrue);
    });

    test('空会话不再显示「保存会被拒」这种错误提示', () {
      expect(profileSrc.contains('还没选会话，保存会被拒'), isFalse,
          reason: '新规则下没会话是合法模式，不是错误');
      expect(profileSrc.contains('errorText: _ownerSession.isEmpty'), isFalse);
    });

    test('两种模式都有解释文案', () {
      expect(profileSrc.contains('鱼自己调模型、自己发 QQ（不经过 DSH 会话）'), isTrue);
      expect(profileSrc.contains('消息投到那个 DSH 会话，由里面的 agent 回'), isTrue);
    });
  });

  group('前端 · 卡片写明当前模式', () {
    test('已绑定行带「API 直回」/「投会话」', () {
      expect(profileSrc.contains("(_replyMode == 'api' ? 'API 直回' : '投会话')"), isTrue);
    });

    test('_replyMode 从后端读，缺字段时按会话有无自判', () {
      expect(profileSrc.contains("final mode = (r['replyMode'] ?? '').toString();"), isTrue);
      expect(profileSrc.contains("_replyMode = mode.isNotEmpty"), isTrue);
      expect(profileSrc.contains("? mode\n            : (_ownerSession.isNotEmpty ? 'session' : 'api')"), isTrue);
    });

    test('保存成功时消费后端 replyMode（不自己猜）', () {
      final idx = profileSrc.indexOf('bridgeFishProfile(name: name');
      final body = profileSrc.substring(idx, idx + 1600);
      expect(body.contains("r['replyMode']"), isTrue);
      expect(body.contains("_actionMsg = '已保存 · '"), isTrue);
      expect(body.contains("applied == 'api' ? ' · API 直回' : ' · 投会话'"), isTrue);
    });

    test('保存成功不清输入', () {
      final idx = profileSrc.indexOf('bridgeFishProfile(name: name');
      final body = profileSrc.substring(idx, idx + 1600);
      expect(body.contains('_qqCtl.clear()'), isFalse,
          reason: '保存成功不该清掉主人 QQ 输入框');
    });
  });
}
