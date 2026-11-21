import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter/foundation.dart' show kIsWeb;

import '../../data/bridge_web.dart' if (dart.library.io) '../../data/bridge_stub.dart' as bridge;
import '../../data/open_url_web.dart' if (dart.library.io) '../../data/open_url_stub.dart' as opener;
import '../../fish_nav.dart';
import '../../sidebar.dart';
import '../../theme/whale_tokens.dart';
import '../../data/ui_store.dart';
import '../../data/qq_gateway.dart';

/// 首次设置清单：6 步，全部用现有接口判定；每步一个可执行动作。
class FishSetupChecklist extends StatefulWidget {
  const FishSetupChecklist({super.key});
  @override
  State<FishSetupChecklist> createState() => _FishSetupChecklistState();
}

enum _StepState { done, active, todo, error }

class _Step {
  final String title;
  final String desc;
  final _StepState state;
  final String actionLabel;
  final Future<void> Function()? action;
  final String? error;
  const _Step({required this.title, required this.desc, required this.state, required this.actionLabel, this.action, this.error});
}

class _FishSetupChecklistState extends State<FishSetupChecklist> {
  bool _loading = true;
  bool _collapsed = UiStore.get('fw.setup.collapsed') == '1';
  final Set<int> _openSteps = <int>{};
  List<_Step> _steps = const [];
  final Map<int, String> _err = {};
  final Map<int, String> _okMsg = {};
  final Set<int> _busy = {};
  String _webui = 'http://127.0.0.1:5099';

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    if (!kIsWeb) { await _loadDesktop(); return; }
    final p = await bridge.bridgeFishProfileGet();
    final model = await bridge.bridgeModelConfig();
    final snap = await bridge.bridgeFishSnapshot();
    final proto = await bridge.bridgeProtocolStatus();
    final st = await bridge.bridgeQqState() ?? await bridge.bridgeQqStatus();
    final targets = await bridge.bridgeQqTargets();
    if (!mounted) return;
    final owner = (p?['owner'] as Map?) ?? const {};
    final os = (owner['session'] as Map?) ?? const {};
    final ownerSession = [os['bridge'], os['config'], os['relation']].map((e) => (e ?? '').toString()).firstWhere((e) => e.isNotEmpty, orElse: () => '');
    final sessions = (p?['sessions'] as List?) ?? const [];
    final sessionExists = ownerSession.isNotEmpty && sessions.any((e) => e is Map && (e['id'] ?? '').toString() == ownerSession);
    final ownerAlive = owner['sessionAlive'] == true || sessionExists;
    final modelOk = model != null && (model['baseUrl'] ?? '').toString().isNotEmpty && (model['model'] ?? '').toString().isNotEmpty && model['hasKey'] == true;
    var qqOn = false;
    var readOn = false;
    final qqMap = (snap?['qq'] as Map?) ?? const {};
    final platform = (qqMap['platform'] as Map?) ?? const {};
    for (final f in ((platform['fields'] as List?) ?? const [])) {
      if (f is Map && f['key'] == 'enabled') qqOn = f['value'] == true;
      if (f is Map && f['key'] == 'readHistory') readOn = f['value'] == true;
    }
    final qqCfg = (qqMap['config'] as Map?) ?? const {};
    final ownerBound = ownerAlive || ((qqCfg['私聊QQ'] ?? '').toString().isNotEmpty && (qqCfg['目标会话'] ?? '').toString().isNotEmpty);
    final protoStatus = (proto?['status'] as Map?) ?? const {};
    final protoEnabled = protoStatus['enabled'] == true;
    final w = (proto?['webui'] ?? '').toString();
    if (w.isNotEmpty) _webui = w;
    final login = (st?['login'] as Map?) ?? const {};
    final logged = login['ok'] == true;
    final list = ((targets?['targets'] as List?) ?? (targets?['items'] as List?) ?? const []);
    final wlOk = list.isNotEmpty && list.every((e) => e is Map && (e['sessionId'] ?? '').toString().isNotEmpty);

    final todo = <_Step>[];
    var activeAssigned = false;
    void add(String title, String desc, bool done, String label, Future<void> Function() act, int idx, {bool gated = false}) {
      final blocked = gated && !ownerBound;
      _StepState st;
      if (_err.containsKey(idx)) { st = _StepState.error; }
      else if (done) { st = _StepState.done; }
      else if (blocked) { st = _StepState.todo; }
      else if (!activeAssigned) { st = _StepState.active; activeAssigned = true; }
      else { st = _StepState.todo; }
      todo.add(_Step(title: title, desc: (blocked && !done) ? '先完成第 1 步' : desc, state: st, actionLabel: label, action: blocked ? null : act, error: _err[idx]));
    }

    add('绑定主人会话', ownerBound ? '主人会话正常' : '把鱼的消息投到你的会话里', ownerBound, '去绑定', () async { FishNav.go(NavRoute.profile); }, 0);
    add('填模型 API', modelOk ? '模型配置完整' : '地址 / 模型 / Key 三样都要有', modelOk, '去设置', () async { FishNav.focus(NavRoute.settings, 'settings.model'); }, 1, gated: true);
    add('启用 QQ', (qqOn && readOn) ? 'QQ 主开关和读历史都开着' : '主开关 + 读历史一次开两个', qqOn && readOn, '启用', () async {
      setState(() => _busy.add(2));
      final a1 = await bridge.bridgeQqField('enabled', true);
      final b1 = await bridge.bridgeQqField('readHistory', true);
      if (!mounted) return;
      setState(() => _busy.remove(2));
      if (a1 == null || b1 == null || a1['ok'] != true || b1['ok'] != true) {
        setState(() => _err[2] = '启用失败：' + ((a1?['error'] ?? b1?['error'] ?? '没连上主程序').toString()));
      } else { setState(() => _err.remove(2)); }
      await _load();
    }, 2, gated: true);
    add('拉起协议端', protoEnabled ? '协议端目录已找到' : '找 SnowLuma 并拉起', protoEnabled, '启动并打开登录页', () async {
      final r = await bridge.bridgeProtocolStart();
      if (!mounted) return;
      if (r == null || r['ok'] != true) {
        setState(() => _err[3] = '启动失败：' + (r?['error'] ?? '没连上主程序').toString());
      } else {
        setState(() => _err.remove(3));
        final w2 = (r['webui'] ?? _webui).toString();
        await Future.delayed(const Duration(milliseconds: 1500));
        opener.openUrl(w2);
      }
      await _load();
    }, 3, gated: true);
    add('登录 QQ', logged ? '已登录' : '打开登录页扫码；首次要先设 WebUI 密码', logged, '去登录', () async { opener.openUrl(_webui); }, 4, gated: true);
    add('加白名单', wlOk ? '白名单已配好' : '每个群/好友都要选投到哪个会话', wlOk, '去添加', () async { FishNav.focus(NavRoute.platforms, 'qq.whitelist', field: 'qq.group'); }, 5, gated: true);
    final allDoneNow = todo.isNotEmpty && todo.every((x) => x.state == _StepState.done);
    var collapsed = _collapsed;
    if (allDoneNow && UiStore.get('fw.setup.collapsed') == null) { collapsed = true; UiStore.set('fw.setup.collapsed', '1'); }
    setState(() { _steps = todo; _loading = false; _collapsed = collapsed; });
  }

  Future<void> _loadDesktop() async {
    final st = await qqGateway.loginState();
    final cfgR = await qqGateway.loadConfig();
    final cfg = (cfgR?['config'] as Map?) ?? const {};
    final proto = (st?['protocol'] as Map?) ?? const {};
    final login = (st?['login'] as Map?) ?? const {};
    final protoRunning = proto['running'] == true;
    final logged = login['ok'] == true;
    final base = (cfg['baseUrl'] ?? '').toString();
    final allow = (cfg['allowChats'] as List?) ?? const [];
    final enabled = cfg['enabled'] == true;
    final w = (proto['webui'] ?? 'http://127.0.0.1:5099').toString();
    _webui = w;
    final todo = <_Step>[
      _Step(title: '配协议端地址', desc: base.isEmpty ? '默认 127.0.0.1:3000，可改' : '当前 ' + base, state: base.isNotEmpty ? _StepState.done : _StepState.active, actionLabel: '去填写', action: () async { FishNav.focus(NavRoute.platforms, 'qq.access'); }),
      _Step(title: '启动协议端', desc: protoRunning ? '协议端在跑' : '拉起本机 SnowLuma，等 5099 监听', state: protoRunning ? _StepState.done : _StepState.active, actionLabel: '启动', action: () async { await qqGateway.startProtocol(); await _load(); }),
      _Step(title: '登录 QQ', desc: logged ? '已登录' : '打开 5099 扫码登录', state: logged ? _StepState.done : _StepState.todo, actionLabel: '去登录', action: () async { opener.openUrl(_webui); }),
      _Step(title: '加白名单并启用', desc: allow.isNotEmpty && enabled ? '白名单已配好' : '加群/好友，并打开 QQ 主开关', state: allow.isNotEmpty && enabled ? _StepState.done : _StepState.todo, actionLabel: '去添加', action: () async { FishNav.focus(NavRoute.platforms, 'qq.whitelist', field: 'qq.group'); }),
    ];
    var activeAssigned = false;
    for (var i = 0; i < todo.length; i++) {
      if (todo[i].state == _StepState.done) continue;
      todo[i] = _Step(title: todo[i].title, desc: todo[i].desc, state: activeAssigned ? _StepState.todo : _StepState.active, actionLabel: todo[i].actionLabel, action: todo[i].action, error: _err[i]);
      activeAssigned = true;
    }
    setState(() { _steps = todo; _loading = false; });
  }

  Future<void> _saveDraftAndTest() async {
    final b = (UiStore.get('model.draft.baseUrl') ?? '').trim();
    final m = (UiStore.get('model.draft.model') ?? '').trim();
    final k = (UiStore.get('model.draft.key') ?? '').trim();
    setState(() => _busy.add(1));
    final r = await bridge.bridgeModelConfigSave(baseUrl: b, model: m, apiKey: k);
    if (!mounted) return;
    setState(() => _busy.remove(1));
    if (r == null || r['ok'] != true) {
      setState(() => _err[1] = '保存失败：' + (r == null ? '没连上主程序' : (r['error'] ?? '未知错误').toString()));
      return;
    }
    UiStore.set('model.draft.key', '');
    await _testModel();
  }

  Future<void> _testModel() async {
    // 先核对「已保存配置」和设置页当前输入，别拿旧配置测。
    final saved = await bridge.bridgeModelConfig();
    if (!mounted) return;
    final sb = (saved?['baseUrl'] ?? '').toString().trim();
    final sm = (saved?['model'] ?? '').toString().trim();
    final db = (UiStore.get('model.draft.baseUrl') ?? '').trim();
    final dm = (UiStore.get('model.draft.model') ?? '').trim();
    final dk = (UiStore.get('model.draft.key') ?? '').trim();
    if ((db.isNotEmpty && db != sb) || (dm.isNotEmpty && dm != sm) || dk.isNotEmpty) {
      setState(() { _okMsg.remove(1); _err[1] = '有未保存的修改，先保存再测'; });
      return;
    }
    setState(() => _busy.add(1));
    final r = await bridge.bridgeChat([{'role': 'user', 'content': '你好，用一句话回我'}], );
    if (!mounted) return;
    setState(() => _busy.remove(1));
    if (r != null && r['ok'] == true) {
      final reply = (r['reply'] ?? '').toString().trim();
      setState(() { _err.remove(1); _okMsg[1] = '连接成功' + (reply.isEmpty ? '' : '：' + (reply.length > 24 ? reply.substring(0, 24) + '…' : reply)); });
    } else {
      setState(() { _okMsg.remove(1); _err[1] = '测试失败：' + (r == null ? '没连上主程序' : (r['error'] ?? '未知错误').toString()); });
    }
  }

  static const Map<int, List<List<String>>> _docs = {
    0: [['为什么', '鱼在这个会话里说话，记忆也落在这个工作区。'], ['怎么做', '鱼的设定 → 主人 → 选会话保存。'], ['常见问题', '没绑时下面 5 步都会显示不可用。']],
    1: [['为什么', '独立运行时鱼靠它说话（DSH 里有宿主模型可跳过）。'], ['怎么做', '地址 + 模型名 + Key 三样都要填，点「测试连接」验证。'], ['常见问题', '只填 Key 不填地址会失败；401 是 Key 不对。']],
    2: [['为什么', '打开后鱼才会收发 QQ。'], ['怎么做', '一个主开关，同时打开「收发」和「读聊天历史」。'], ['常见问题', '只开一个不算启用。']],
    3: [['为什么', 'QQ 消息要经 SnowLuma 的 OneBot 接口进来。'], ['怎么做', '点「启动并打开登录页」，浏览器会弹 5099。'], ['常见问题', '找不到协议端目录 → 设环境变量 SNOWLUMA_DIR。']],
    4: [['为什么', '协议端没登录，OneBot 端口就不开，鱼收不到消息。'], ['怎么做', '在 5099 先设 WebUI 密码，再扫码登 QQ。'], ['常见问题', 'WebUI 密码不是 QQ 密码；登录态会过期，需重登。']],
    5: [['为什么', '决定鱼能在哪些群/私聊说话。'], ['怎么做', '从 QQ 选择群/好友 → 选「投到哪个会话」→ 启用。'], ['常见问题', '没选会话的条目不会收信；主人私聊不用加。']],
  };

  void _toggleCollapsed(bool value) {
    setState(() => _collapsed = value);
    UiStore.set('fw.setup.collapsed', value ? '1' : '0');
  }

  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    if (_loading) return const SizedBox.shrink();
    final doneCount = _steps.where((s) => s.state == _StepState.done).length;
    final allDone = doneCount == _steps.length && _steps.isNotEmpty;
    final progress = _steps.isEmpty ? 0.0 : doneCount / _steps.length;
    final header = Row(children: [
      Icon(allDone ? Icons.check_circle_outline : Icons.rocket_launch_outlined, size: 16, color: allDone ? WhaleTokens.successFor(scheme.brightness) : scheme.primary),
      const SizedBox(width: 8),
      Text(allDone && _collapsed ? '已就绪 · 收起看详情' : '开始使用鱼的世界', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: scheme.onSurface)),
      const SizedBox(width: 8),
      Text(doneCount.toString() + ' / ' + _steps.length.toString(), style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant)),
      const Spacer(),
      IconButton(
        visualDensity: VisualDensity.compact,
        tooltip: _collapsed ? '展开' : '收起',
        onPressed: () => _toggleCollapsed(!_collapsed),
        icon: Icon(_collapsed ? Icons.expand_more : Icons.expand_less, size: 18, color: scheme.onSurfaceVariant),
      ),
    ]);
    final bar = Padding(
      padding: const EdgeInsets.only(top: 6, bottom: 4),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(2),
        child: LinearProgressIndicator(value: progress, minHeight: 4, backgroundColor: scheme.onSurface.withValues(alpha: .08), color: scheme.primary),
      ),
    );
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.fromLTRB(16, 10, 10, 8),
      decoration: BoxDecoration(color: scheme.surface, borderRadius: BorderRadius.circular(WhaleTokens.rMd), border: Border.all(color: scheme.outlineVariant)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        header,
        bar,
        if (!_collapsed) ...[
          const SizedBox(height: 4),
          for (var i = 0; i < _steps.length; i++) _row(context, i, _steps[i]),
        ],
      ]),
    );
  }

  Widget _row(BuildContext context, int i, _Step s) {
    final scheme = Theme.of(context).colorScheme;
    final err = _err[i];
    final okMsg = _okMsg[i];
    final liveState = err != null ? _StepState.error : s.state;
    final (Color tone, Widget icon) = switch (liveState) {
      _StepState.done => (WhaleTokens.successFor(scheme.brightness), Icon(Icons.check_circle, size: 15, color: WhaleTokens.successFor(scheme.brightness))),
      _StepState.error => (scheme.error, Icon(Icons.error_outline, size: 15, color: scheme.error)),
      _StepState.active => (scheme.primary, Icon(Icons.play_circle_outline, size: 15, color: scheme.primary)),
      _StepState.todo => (scheme.onSurfaceVariant, Icon(Icons.circle_outlined, size: 15, color: scheme.onSurfaceVariant)),
    };
    final done = s.state == _StepState.done;
    final busy = _busy.contains(i);
    final open = _openSteps.contains(i);
    final desktop = !kIsWeb;
    final docs = desktop ? const <List<String>>[] : (_docs[i] ?? const []);
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Focus(
          onKeyEvent: (n, e) {
            if (e is KeyDownEvent && (e.logicalKey == LogicalKeyboardKey.enter || e.logicalKey == LogicalKeyboardKey.space)) {
              setState(() { if (open) { _openSteps.remove(i); } else { _openSteps.add(i); } });
              return KeyEventResult.handled;
            }
            if (e is KeyDownEvent && e.logicalKey == LogicalKeyboardKey.escape && open) {
              setState(() => _openSteps.remove(i));
              return KeyEventResult.handled;
            }
            return KeyEventResult.ignored;
          },
          child: InkWell(
            borderRadius: BorderRadius.circular(6),
            onTap: () => setState(() { if (open) { _openSteps.remove(i); } else { _openSteps.add(i); } }),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                SizedBox(width: 22, child: Text((i + 1).toString(), style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: tone))),
                Padding(padding: const EdgeInsets.only(top: 1), child: icon),
                const SizedBox(width: 8),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(s.title, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: done ? scheme.onSurfaceVariant : scheme.onSurface)),
                  const SizedBox(height: 2),
                  Text(err ?? okMsg ?? s.desc, style: TextStyle(fontSize: 11, color: err != null ? scheme.error : (okMsg != null ? WhaleTokens.successFor(scheme.brightness) : scheme.onSurfaceVariant))),
                ])),
                if (!desktop && i == 1 && (err ?? '').contains('先保存'))
                  TextButton(onPressed: busy ? null : _saveDraftAndTest, child: const Text('保存并测试', style: TextStyle(fontSize: 12))),
                if (!desktop && i == 1 && !(err ?? '').contains('先保存'))
                  TextButton(onPressed: busy ? null : _testModel, child: const Text('测试连接', style: TextStyle(fontSize: 12))),
                if (!done && s.action != null)
                  FilledButton.tonal(
                    style: FilledButton.styleFrom(visualDensity: VisualDensity.compact, padding: const EdgeInsets.symmetric(horizontal: 12)),
                    onPressed: busy ? null : () async { await s.action!(); },
                    child: Text(busy ? '处理中…' : s.actionLabel, style: const TextStyle(fontSize: 12)),
                  ),
                const SizedBox(width: 2),
                Icon(open ? Icons.expand_less : Icons.expand_more, size: 16, color: scheme.onSurfaceVariant),
              ]),
            ),
          ),
        ),
        if (open)
          Padding(
            padding: const EdgeInsets.fromLTRB(38, 2, 4, 6),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              if (err != null) Row(children: [
                Expanded(child: Text('错误：' + err, style: TextStyle(fontSize: 11, color: scheme.error))),
                if (s.action != null) TextButton(onPressed: busy ? null : () async { await s.action!(); }, child: const Text('重试')),
              ]),
              for (final block in docs)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Text.rich(TextSpan(children: [
                    TextSpan(text: block[0] + '：', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: scheme.onSurface)),
                    TextSpan(text: block[1], style: TextStyle(fontSize: 11, height: 1.5, color: scheme.onSurfaceVariant)),
                  ])),
                ),
            ]),
          ),
      ]),
    );
  }
}
