import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../data/fish_data.dart';
import '../data/bridge_web.dart' if (dart.library.io) '../data/bridge_stub.dart' as bridge;
import '../data/image_pick_web.dart' if (dart.library.io) '../data/image_pick_stub.dart' as picker;
import '../data/qq_gateway.dart';
import '../fish_nav.dart';
import '../sidebar.dart';
import '../theme/whale_tokens.dart';
import 'fish_common.dart';

// ignore_for_file: prefer_interpolation_to_compose_strings

/// 鱼的设定：形象 / 信息 / 角色卡 / 人设 / 主人绑定 / 存储位置（可写）。
class FishProfilePage extends StatefulWidget {
  const FishProfilePage({super.key});
  @override
  State<FishProfilePage> createState() => _FishProfilePageState();
}

/// 绑定状态**只有两种**：未绑定 / 已绑定。
///
/// ★ 2026-11-21 主人定的：以前是 failed / bound / unbound 三态，
///   外加「已保存」临时态，界面会在这几个之间来回跳。
///   现在「保存失败」不是状态，是**一次操作的反馈** —— 它不改变「绑没绑上」这件事，
///   所以单独用一个 `_ownerFailMsg` 表达，不占状态位。
enum _OwnerHint { unbound, bound }

/// 回读配置时，该不该把 server 上的值填进输入框？
///
/// ★ 为什么抽成顶层纯函数（2026-11-21）：
///   「保存后输入框内容不变」这条要能被**真测**。
///   如果只写在 State 私有方法里，判据只能对源码做字符串匹配 ——
///   那是在验"写了没"，不是验"对不对"（改了逻辑照样绿）。
///   抽出来后判据能直接喂参数、断言结果，改坏必红。
///
/// 规则：**只在输入框为空时才填**。有内容就保留 ——
/// 那是用户正在打的草稿，或者刚保存成功的那个号，都不该被回读值冲掉。
bool shouldFillInputFromServer(String current, String fromServer) {
  return current.trim().isEmpty && fromServer.trim().isNotEmpty;
}

class _FishProfilePageState extends State<FishProfilePage> {
  Future<FishSnapshot> _future = FishWorld.load();
  Map<String, dynamic>? _live;
  bool _bridge = false;
  /// 三态：**null = 还不知道**（`_load()` 还没跑完）。
  ///
  /// 为什么不能直接 `bool _desktop = false`：初值 false 会让页面先按
  /// 「面板版」渲染主人卡，而面板分支读的是 `bridgeFishProfileGet()`，
  /// 桌面版这个函数恒返回 null（bridge_stub.dart）⇒ 冷启动会闪出一帧**空输入框**
  /// 且按钮写着「保存绑定」。用户看到的就是「重启后主人 QQ 没了，得重填」。
  /// 所以：不知道就**别渲染**这块，等知道再画。
  bool? _desktop;
  String _name = '';
  String _title = '';
  String _persona = '';
  String _roleId = '';
  String _personaErr = '';
  String _actionMsg = '';
  bool _actionErr = false;
  final _qqCtl = TextEditingController();
  final _sessionFocus = FocusNode();
  String _ownerSession = '';
  /// 回复路径：'session' 投会话 / 'api' 直接调模型。由后端返回，界面只照写。
  String _replyMode = '';
  String _localName = '';
  String _localTitle = '';
  String _localOwnerQQ = '';
  bool _binding = false;
  String _ownerFailMsg = '';
  String _boundQQ = '';
  String _boundAt = '';
  final _qqFocus = FocusNode();

  @override
  void initState() {
    super.initState();
    // 让「鱼与世界」那边点「去绑主人会话」能把焦点落到这个输入框。
    FishNav.registerField('pf-owner-qq', _qqFocus);
    // 会话下拉也注册上：保存报「请选一个 DSH 会话」时，「去选会话」能直接跳过来。
    FishNav.registerField('pf-owner-session', _sessionFocus);
    _load();
  }

  @override
  void dispose() {
    _qqCtl.dispose();
    _qqFocus.dispose();
    _sessionFocus.dispose();
    FishNav.fields.remove('pf-owner-qq');
    FishNav.fields.remove('pf-owner-session');
    super.dispose();
  }

  Future<void> _load() async {
    setState(() { _future = FishWorld.reload(); });
    // 先确定模式，再决定画什么：`_desktop = null` 期间 _cards 只画骨架。
    // ★ 必须走 setState 落这个值：骨架 → 真实卡片的切换靠它触发重绘。
    final isDesktop = qqGateway.isDesktop;
    if (mounted) {
      setState(() => _desktop = isDesktop);
    } else {
      _desktop = isDesktop;
    }
    if (isDesktop) {
      final cfgR = await qqGateway.loadConfig();
      final cfg = (cfgR?['config'] as Map?) ?? const {};
      if (!mounted) return;
      setState(() {
        _bridge = false;
        _localName = (cfg['fishName'] ?? '').toString();
        _localTitle = (cfg['ownerTitle'] ?? '').toString();
        _localOwnerQQ = (cfg['ownerQQ'] ?? cfg['私聊QQ'] ?? '').toString();
        // ★ 2026-11-21 主人要求：加载/回读配置时**只在字段为空时才填默认值**，
        //   字段有值就保留 —— 以前每次加载都覆盖，用户刚打的号会被刷掉。
        if (shouldFillInputFromServer(_qqCtl.text, _localOwnerQQ)) _qqCtl.text = _localOwnerQQ;
        // 上次保存时间落盘，重启后仍然看得到“上次保存 HH:mm”。
        final at = (cfg['ownerQQSavedAt'] ?? '').toString();
        if (_localOwnerQQ.isNotEmpty) {
          _boundQQ = _localOwnerQQ;
          final short = _shortStamp(at);
          // 配置里没有时间戳（老数据/别处写的）时，别把刚保存时算出来的时间擦掉。
          if (short.isNotEmpty) _boundAt = short;
        }
      });
      return;
    }
    final r = await bridge.bridgeFishProfileGet();
    if (!mounted) return;
    if (r != null && r['ok'] == true) {
      final fish = (r['fish'] as Map?) ?? const {};
      final owner = (r['owner'] as Map?) ?? const {};
      final sessions = (r['sessions'] as List?) ?? const [];
      final savedSession = _sessionIdFromOwner(owner);
      // 后端直接告诉我们当前是哪条回复路径；老版本没这个字段就按会话有没有自己判。
      final mode = (r['replyMode'] ?? '').toString();
      setState(() {
        _live = Map<String, dynamic>.from(r);
        _bridge = true;
        _name = (fish['name'] ?? '').toString();
        _title = (fish['ownerTitle'] ?? r['ownerTitle'] ?? '主人').toString();
        // ★ 不再「没会话就默认塞第一条」：新规则下「没会话 = API 直回」是合法用法，
        //   强行塞一个会话等于替用户改了设置，反而让 api 模式永远选不上。
        //   只有后端明确说当前是 session 模式、但本地拿到的 id 在列表里找不到时，
        //   才退到第一条（那是「会话被 DSH 清掉」的兜底，不是无会话的情况）。
        final known = savedSession.isNotEmpty &&
            sessions.any((e) => e is Map && (e['id'] ?? '').toString() == savedSession);
        _ownerSession = savedSession.isNotEmpty && (known || mode != 'api')
            ? savedSession
            : '';
        if (!known && mode == 'session' && _ownerSession.isEmpty) {
          _ownerSession = _defaultSessionFrom(sessions);
        }
        _replyMode = mode.isNotEmpty
            ? mode
            : (_ownerSession.isNotEmpty ? 'session' : 'api');
        // ★ 2026-11-21 主人要求：同上，只在空的时候填。
        //   保存成功后会 `_load()` 回读，若这里无条件覆盖，
        //   用户输入的内容会被"回读值"替换掉（看起来像被清空/换掉）。
        //
        // ★★ 这里必须用 _qqIdFromOwner 而不是 owner['qqId']：
        //    后端返回的是嵌套结构 { qq: { bridge, config, relation } }，
        //    读顶层 qqId 永远是空 ⇒ 界面一直显示「未绑定」（真 bug，今天修的）。
        final qqFromServer = _qqIdFromOwner(owner);
        if (shouldFillInputFromServer(_qqCtl.text, qqFromServer)) _qqCtl.text = qqFromServer;
        // 服务端说绑了谁就是谁（这是"当前已保存的值"，和输入框里的草稿无关）
        _boundQQ = qqFromServer;
        _roleId = ((r['current'] as Map?)?['id'] ?? '').toString();
      });
      await _loadPersona(_roleId);
    }
  }

  /// 从 `owner` 里取主人会话 id。
  ///
  /// ★ 键名踩过坑：后端 `ownerBinding()` 返回 `{qq, session, qqAgree,
  /// sessionAgree, sessionAlive}`，其中 `session = {bridge, config, relation}`。
  /// **没有 `sessionId` 这个键**——之前读 `owner['sessionId']` 恒为空，
  /// 于是每次保存都被后端拒「请选一个 DSH 会话当主人会话」。
  /// 所以主路径读嵌套的 `session.bridge`，平的 `sessionId` 只作兜底（防以后改了形状）。
  String _sessionIdFromOwner(Map<dynamic, dynamic> owner) {
    final nested = owner['session'];
    if (nested is Map) {
      final v = (nested['bridge'] ?? '').toString().trim();
      if (v.isNotEmpty) return v;
    }
    return (owner['sessionId'] ?? '').toString().trim();
  }

  /// 从 `owner` 里取主人 QQ。
  ///
  /// ★ 2026-11-21 修的真 bug：以前读的是顶层 `owner['qqId']`，
  ///   但后端的结构是**嵌套对象**：
  ///     owner = { qq: { bridge, config, relation }, session: {...}, qqAgree, ... }
  ///   `owner['qqId']` 永远 undefined ⇒ 界面显示「未绑定」，
  ///   而后端其实三处都一致绑好了（qqAgree/sessionAgree 都是 true）。
  ///   主人看到「绑定是空的」就是这个原因，不是真没绑。
  ///
  ///   优先级和 _sessionIdFromOwner 一致：bridge 是桥里正在用的那个，
  ///   config 是面板存的，relation 是关系表 —— bridge 最能代表"现在实际生效的"。
  String _qqIdFromOwner(Map<dynamic, dynamic> owner) {
    final nested = owner['qq'];
    if (nested is Map) {
      for (final k in const ['bridge', 'config', 'relation']) {
        final v = (nested[k] ?? '').toString().trim();
        if (v.isNotEmpty) return v;
      }
    }
    // 老版本/兼容路径：有些返回会平铺成 qqId
    return (owner['qqId'] ?? '').toString().trim();
  }

  /// 默认主人会话：会话列表里第一条 id 非空的。
  /// 只返回列表里真实存在的 id——后端会校验存在性，编一个就是白填。
  String _defaultSessionFrom(List<dynamic> sessions) {
    for (final e in sessions) {
      if (e is Map) {
        final id = (e['id'] ?? '').toString().trim();
        if (id.isNotEmpty) return id;
      }
    }
    return '';
  }

  Future<void> _loadPersona(String roleId) async {
    final r = await bridge.bridgeFishPersonaGet(roleId);
    if (!mounted) return;
    if (r != null && r['ok'] == true) {
      setState(() {
        _persona = (r['text'] ?? '').toString();
        if (_roleId.isEmpty) _roleId = (r['roleId'] ?? '').toString();
        _personaErr = '';
      });
    } else {
      setState(() => _personaErr = r == null ? '没连上主程序（本地预览没有桥）' : (r['error'] ?? '读取失败').toString());
    }
  }

  void _setAction(String msg, {bool err = false}) => setState(() { _actionMsg = msg; _actionErr = err; });

  /// 状态未知（null）时不许保存：那时候连该走哪条写路径都不知道。
  bool get _canSaveOwner =>
      !_binding && _desktop != null && (_desktop! || _bridge);

  void _submitOwner() {
    if (!_canSaveOwner) return;
    _saveProfile(qq: _qqCtl.text.trim(), session: _desktop == true ? null : _ownerSession);
  }

  // 失败就地红字 + 原因 + 「重试」；输入内容不动，等待重试。
  Widget _ownerFailInline(ColorScheme scheme) {
    return Row(children: [
      Icon(Icons.error_outline, size: 14, color: scheme.error),
      const SizedBox(width: 6),
      Text('保存失败：' + (_ownerFailMsg.isEmpty ? _actionMsg.replaceFirst('保存失败：', '') : _ownerFailMsg),
          style: TextStyle(fontSize: 12, color: scheme.error)),
      const SizedBox(width: 12),
      TextButton(
        onPressed: _canSaveOwner ? _submitOwner : null,
        style: TextButton.styleFrom(
            minimumSize: const Size(48, 26),
            padding: const EdgeInsets.symmetric(horizontal: 8),
            textStyle: const TextStyle(fontSize: 12)),
        child: const Text('重试'),
      ),
    ]);
  }

  _OwnerHint get _ownerHintState =>
      _boundQQ.isNotEmpty ? _OwnerHint.bound : _OwnerHint.unbound;

  /// 这次保存失败了没有。
  ///
  /// ★ 失败不是一种「绑定状态」，是操作反馈：绑成功的那个号还在，
  ///   只是这次想换的没换成。所以它不参与 `_ownerHintState` 的计算，
  ///   也不会把 `_boundQQ` 清掉（清掉就等于「本来绑着，失败一次变成没绑」）。
  bool get _ownerFail => _ownerFailMsg.isNotEmpty;



  // 时间戳统一成「HH:mm」：卡片右上和已绑定行都只用这一个口径。
  String _shortStamp(String raw) {
    if (raw.isEmpty) return '';
    final t = DateTime.tryParse(raw);
    if (t == null) return '';
    final l = t.toLocal();
    return l.hour.toString().padLeft(2, '0') +
        ':' +
        l.minute.toString().padLeft(2, '0');
  }

  Future<void> _saveProfile({String? name, String? title, String? qq, String? session}) async {
    if (_desktop == true) {
      // 立刻进 loading：再快也要让手感觉到“点上了”。
      if (qq != null) {
        setState(() {
          _binding = true;
          _ownerFailMsg = '';
        });
      }
      final started = DateTime.now();
      var ok = true;
      if (name != null) ok = (await qqGateway.saveField('fishName', name))?['ok'] == true && ok;
      if (title != null) ok = (await qqGateway.saveField('ownerTitle', title))?['ok'] == true && ok;
      if (qq != null) ok = (await qqGateway.saveField('ownerQQ', qq))?['ok'] == true && ok;
      if (!mounted) return;
      // 太快完成会像“没反应”：补到至少 320ms 再收 loading。
      final spent = DateTime.now().difference(started).inMilliseconds;
      if (spent < 320) {
        await Future<void>.delayed(Duration(milliseconds: 320 - spent));
        if (!mounted) return;
      }
      setState(() => _binding = false);
      if (ok) {
        // 回读一遍再说话：只信本机文件里真的存下来的那个号。
        // 判据要能真红：不只看「存没存进去」，还要看**存的是不是你输入的那个号**——
        // 只判非空的话，写成别人的号也会显示成功（这条以前就是这么漏的）。
        final back = await qqGateway.loadConfig();
        final cfg = (back?['config'] as Map?) ?? const {};
        final saved = (cfg['ownerQQ'] ?? '').toString();
        final want = (qq ?? '').trim();
        if (!mounted) return;
        if (saved.isEmpty) {
          setState(() {
            // ★ 不清 _boundQQ：失败是「这次没换成」，不是「之前绑的没了」。
            //   清掉会让界面从「已绑定」跳成「未绑定」，看着像绑定丢了。
            _ownerFailMsg = '回读没有看到主人 QQ';
            _setAction('保存失败：回读没有看到主人 QQ', err: true);
          });
        } else if (want.isNotEmpty && saved != want) {
          // 存进去了但不是你输入的那个：不许算成功。
          setState(() {
            _ownerFailMsg = '回读是 ' + saved + '，和输入的 ' + want + ' 不一致';
            _setAction('保存失败：回读与输入不一致', err: true);
          });
        } else {
          final now = DateTime.now();
          final stamp = now.hour.toString().padLeft(2, '0') +
              ':' +
              now.minute.toString().padLeft(2, '0');
          setState(() {
            _boundQQ = saved;
            _boundAt = stamp;
            _ownerFailMsg = '';
            _actionErr = false;
            _actionMsg = '已保存 · ' + saved;
          });
          await _load();
          if (!mounted) return;
          setState(() => _boundQQ = saved);
        }
      } else {
        setState(() {
          // 同上：不清 _boundQQ（之前绑成功的号还在）
          _ownerFailMsg = '本机配置写不进';
          _setAction('保存失败：本机配置写不进', err: true);
        });
      }
      return;
    }
    final r = await bridge.bridgeFishProfile(name: name, ownerTitle: title, ownerQQ: qq, ownerSession: session);
    if (!mounted) return;
    if (r != null && r['ok'] == true) {
      // 后端告诉我们实际采用哪条回复路径，照它写卡片，别自己猜。
      final mode = (r['replyMode'] ?? '').toString();
      final applied = mode.isNotEmpty ? mode : (session != null && session.isNotEmpty ? 'session' : 'api');
      final now = DateTime.now();
      final stamp = now.hour.toString().padLeft(2, '0') + ':' + now.minute.toString().padLeft(2, '0');
      setState(() {
        _replyMode = applied;
        _actionErr = false;
        _ownerFailMsg = '';
        final q = (qq ?? '').trim();
        if (q.isNotEmpty) {
          _boundQQ = q;
          _boundAt = stamp;
          _actionMsg = '已保存 · ' + q + (applied == 'api' ? ' · API 直回' : ' · 投会话');
        } else {
          _actionMsg = '已保存';
        }
      });
      await _load();
      if (!mounted) return;
      // _load 会把 _replyMode 用后端真值刷新；这里再兜一次，防 GET 还没跟上。
      if (_replyMode.isEmpty) setState(() => _replyMode = applied);
    } else {
      // ★ 失败时也写 _ownerFailMsg —— 界面靠它判断「这次失败」，
      //   只设 _actionMsg 的话红字和重试按钮不会出现（以前就漏了这条）。
      final why = r == null ? '没连上主程序（本地预览没有桥）' : (r['error'] ?? '未知错误').toString();
      setState(() => _ownerFailMsg = why);
      _setAction('保存失败：' + why, err: true);
    }
  }

  Future<void> _roles(String action, {String id = '', String name = ''}) async {
    final r = await bridge.bridgeFishRoles(action, id: id, name: name);
    if (!mounted) return;
    if (r != null && r['ok'] == true) { await _load(); }
    else { _setAction('操作失败：' + (r == null ? '没连上主程序' : (r['error'] ?? '未知错误').toString()), err: true); }
  }

  Future<void> _changeAvatar() async {
    if (!_bridge) { _setAction('换图需要桥（打开 DSH 面板）', err: true); return; }
    final b64 = await picker.pickImageBase64();
    if (b64.isEmpty) return;
    final r = await bridge.bridgeFishRoleImage(_roleId, b64);
    if (!mounted) return;
    if (r != null && r['ok'] == true) { _setAction('形象已更新'); await _load(); }
    else { _setAction('换图失败：' + (r == null ? '没连上主程序' : (r['error'] ?? '未知错误').toString()), err: true); }
  }

  @override
  Widget build(BuildContext context) {
    return FishPageLayout(pageKey: 'profile', future: _future, buildCards: _cards);
  }

  List<Widget> _cards(BuildContext context, FishSnapshot data) {
    final scheme = Theme.of(context).colorScheme;
    if (!data.ok && !_bridge) return [_empty('还没读到鱼的设定。确认桌面端在跑，或先导出快照。')];
    // ★ 还不知道自己是桌面版还是面板版时，**先别画主人卡**。
    // 画了就会按「面板分支」渲染：桌面版 bridge 恒返回 null ⇒ 空输入框 +
    // 按钮写「保存绑定」，用户以为绑定丢了。等 _load() 回来再画，宁可多一帧骨架。
    if (_desktop == null) {
      return [
        FishCard(
          id: 'pf-owner-wait',
          title: '主人绑定',
          note: '读取中',
          width: 1400,
          height: 120,
          child: Row(children: [
            const SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(strokeWidth: 1.6)),
            const SizedBox(width: 10),
            Text('正在读本机配置…',
                style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
          ]),
        ),
      ];
    }
    final desktop = _desktop!;
    final profile = data.profile;
    final storage = <FishStorage>[
      ...profile.storage,
      if (data.roots.isNotEmpty) FishStorage(label: '当前实际使用的 root', path: data.roots.first),
    ];
    final roles = _bridge ? [for (final e in ((_live?['roles'] as List?) ?? const [])) FishPersona.fromJson(e)] : profile.roles;
    final activeId = _roleId.isNotEmpty ? _roleId : profile.active;
    final sessions = (_live?['sessions'] as List?) ?? const [];
    return [
      FishCard(
        id: 'pf-hero',
        title: '鱼的样子',
        note: '当前角色',
        width: 1400,
        height: 250,
        child: Row(children: [
          Expanded(child: _ProfileHero(profile: profile, current: profile.currentRole)),
          Column(mainAxisAlignment: MainAxisAlignment.center, children: [
            FilledButton.tonal(onPressed: _changeAvatar, child: const Text('换图')),
            const SizedBox(height: 8),
            Text('本地图片 → 当前角色', style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant)),
          ]),
          const SizedBox(width: 8),
        ]),
      ),
      if (_actionMsg.isNotEmpty)
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(color: scheme.surface, borderRadius: BorderRadius.circular(9), border: Border.all(color: (_actionErr ? scheme.error : scheme.primary).withValues(alpha: .45))),
            child: Row(children: [
              Icon(_actionErr ? Icons.error_outline : Icons.check_circle_outline, size: 14, color: _actionErr ? scheme.error : WhaleTokens.successFor(scheme.brightness)),
              const SizedBox(width: 7),
              Expanded(child: Text(_actionMsg, style: TextStyle(fontSize: 12, color: _actionErr ? scheme.error : WhaleTokens.successFor(scheme.brightness)))),
            ]),
          ),
        ),
      FishCard(
        id: 'pf-info',
        title: '鱼的信息',
        note: _bridge ? '点击即可改' : (desktop ? '存本机' : '需插件版'),
        width: 700,
        height: 260,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          _EditableLine(label: '鱼的名字', value: _bridge ? _name : (desktop && _localName.isNotEmpty ? _localName : profile.name), enabled: _bridge || desktop, onSave: (v) { setState(() => _localName = v); _saveProfile(name: v); }),
          _EditableLine(label: '对主人的称呼', value: _bridge ? _title : (desktop && _localTitle.isNotEmpty ? _localTitle : profile.ownerTitle), enabled: _bridge || desktop, onSave: (v) { setState(() => _localTitle = v); _saveProfile(title: v); }),
          _kv('人设文件', profile.personaFile.isEmpty ? '—' : profile.personaFile),
          _kv('当前角色', activeId.isEmpty ? '—' : activeId),
        ]),
      ),
      FishCard(
        id: 'pf-roles',
        title: '角色卡',
        note: roles.length.toString() + ' 张',
        width: 700,
        height: 300,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final role in roles) _RoleTile(role: role, active: role.id == activeId, onTap: _bridge ? () => _roles('current', id: role.id) : null),
          ]),
          const Spacer(),
          if (_bridge)
            Row(children: [
              TextButton(onPressed: () => _roleDialog(), child: const Text('＋ 新建角色')),
              TextButton(onPressed: activeId.isEmpty ? null : () => _renameDialog(activeId), child: const Text('重命名')),
              TextButton(onPressed: activeId.isEmpty ? null : () => _deleteDialog(activeId), child: const Text('删除')),
            ])
          else
            Text(desktop ? '角色卡编辑需插件版，桌面可看。' : '连接桌面端后可新建 / 重命名 / 删除。', style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant)),
        ]),
      ),
      FishCard(
        id: 'pf-persona',
        title: '人设卡',
        note: (_persona.isNotEmpty ? _persona.characters.length.toString() : profile.personaLength.toString()) + ' 字',
        width: 1400,
        height: 420,
        maxHeight: 420,
        resizable: false,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (_personaErr.isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_personaErr, style: TextStyle(fontSize: 11, color: scheme.error))),
          Expanded(child: SingleChildScrollView(child: SelectableText(_persona.isNotEmpty ? _persona : profile.personaText, style: TextStyle(fontSize: WhaleTokens.fsSub, height: 1.7, color: scheme.onSurface)))),
          Align(
            alignment: Alignment.centerRight,
            child: FilledButton.tonalIcon(
              onPressed: _bridge ? () => _openEditor(_persona.isNotEmpty ? _persona : profile.personaText) : null,
              icon: const Icon(Icons.edit_outlined, size: 15),
              label: Text(desktop ? '编辑（需插件版）' : '编辑'),
            ),
          ),
        ]),
      ),
      // 主人卡要能被「去绑主人会话」定位到：用 FishCard 自带的 anchor 参数
      // （在 buildPanel 里包 FishAnchor），★ 不能在外面套一层——那会换掉类型，
      // 让 fishPageBody 认不出它是 FishCard，宽度从 1400 掉到 460 并溢出。
      FishCard(
        id: 'pf-owner',
        anchor: 'pf-owner',
        title: desktop ? '主人 QQ' : '主人绑定',
        // ★ 2026-11-21 主人要求：卡片右上角只显示「上次保存 HH:mm」，没有就不显示。
        //   以前桌面版没保存过会写「存本机」、面板版写「改动等于鱼认谁」——
        //   那是**别处的信息**塞进 note 里，和"上次保存时间"不是一个含义。
        note: _boundAt.isEmpty ? '' : '上次保存 ' + _boundAt,
        width: 1400,
        height: desktop ? 190 : 300,
        child: CallbackShortcuts(
          bindings: <ShortcutActivator, VoidCallback>{
            // ★ 2026-11-21 主人要求：Esc 只取消编辑焦点，**不覆盖内容**。
            //   以前会把输入框刷回旧值，等于替用户撤销了他刚打的字。
            //   真要回到上次保存的值，用户自己重新打就是了 —— 输入框不该抢这个决定。
            const SingleActivator(LogicalKeyboardKey.escape): () {
              _qqFocus.unfocus();
            },
            const SingleActivator(LogicalKeyboardKey.enter): _submitOwner,
            const SingleActivator(LogicalKeyboardKey.numpadEnter): _submitOwner,
          },
          child: Focus(
            autofocus: false,
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          // 提示条只在**未绑定**时出现，用中性色。
          // ★ 2026-11-21 主人要求：未绑定是正常状态，不是错误 —— 不用红/橙。
          //   红只留给保存失败，那条走下面的 _ownerFailInline。
          if (_ownerHintState == _OwnerHint.unbound) ...[
            _ownerHintWidget(context, scheme, desktop: desktop),
            const SizedBox(height: 12),
          ],
          Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
            SizedBox(width: 110, child: Text('主人 QQ', style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant))),
            SizedBox(
              width: 240,
              child: TextField(
                controller: _qqCtl,
                focusNode: _qqFocus,
                enabled: !_binding,
                onSubmitted: (_) => _submitOwner(),
                onChanged: (_) => setState(() {}),
                onTapOutside: (_) => _qqFocus.unfocus(),
                textInputAction: TextInputAction.done,
                decoration: const InputDecoration(isDense: true, border: OutlineInputBorder()),
                style: const TextStyle(fontSize: 13),
              ),
            ),
            const SizedBox(width: 12),
            SizedBox(
              width: 136,
              child: FilledButton(
                onPressed: _canSaveOwner ? _submitOwner : null,
                child: _binding
                    ? Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                        const SizedBox(
                            width: 12,
                            height: 12,
                            child: CircularProgressIndicator(strokeWidth: 1.6)),
                        const SizedBox(width: 6),
                        Text(desktop ? '保存中…' : '保存中…',
                            style: const TextStyle(fontSize: 12)),
                      ])
                    // ★ 2026-11-21 主人要求：按钮**恒为「保存」**，不闪「已保存」。
                    //   状态已经由右边的「已绑定 · …」说清楚了，
                    //   按钮再变身一次只会让界面跳。
                    : const Text('保存', maxLines: 1, softWrap: false),
              ),
            ),
            // ★ 2026-11-21 主人要求：绑定信息不再挤在按钮旁边，
            //   挪到输入框下方独立一行（见本 Row 之后）。
          ]),
          // ── 已绑定：独立一行（绿字），信息给全 ──
          //   只写「已绑定」看不出走哪条路；只写在按钮旁边又太挤。
          if (_ownerHintState == _OwnerHint.bound) ...[
            const SizedBox(height: 10),
            Row(children: [
              Icon(Icons.check_circle_outline,
                  size: 14, color: WhaleTokens.successFor(scheme.brightness)),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                    '已绑定 · ' +
                        _boundQQ +
                        (_boundAt.isEmpty ? '' : ' · ' + _boundAt) +
                        ' · ' +
                        (_replyMode == 'api' ? 'API 直回' : '投会话'),
                    style: TextStyle(
                        fontSize: 12,
                        color: WhaleTokens.successFor(scheme.brightness))),
              ),
            ]),
          ],
          if (_ownerFail) ...[
            const SizedBox(height: 8),
            _ownerFailInline(scheme),
          ],
          if (!desktop) ...[
            const SizedBox(height: 10),
            Row(children: [
              SizedBox(width: 110, child: Text('主人会话', style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant))),
              SizedBox(
                width: 420,
                child: DropdownButtonFormField<String>(
                  focusNode: _sessionFocus,
                  // 空串是**合法选项**（「不用会话 · API 直接回复」），不是「没选」。
                  value: _ownerSession,
                  onChanged: _bridge ? (v) => setState(() => _ownerSession = v ?? '') : null,
                  decoration: const InputDecoration(
                    isDense: true,
                    border: OutlineInputBorder(),
                  ),
                  items: [
                    // 默认项放最前：不选会话也能保存，走 API 直回。
                    const DropdownMenuItem(
                      value: '',
                      child: Text('不用会话 · API 直接回复',
                          style: TextStyle(fontSize: 12)),
                    ),
                    for (final s in sessions)
                      DropdownMenuItem(value: (((s as Map)['id']) ?? '').toString(), child: Text((((s['title']) ?? (s['id'])) ?? '').toString(), style: const TextStyle(fontSize: 12))),
                  ],
                ),
              ),
            ]),
            const SizedBox(height: 6),
            // 把「这条路径现在怎么走」写明白：不选会话不是错，是另一种模式。
            Padding(
              padding: const EdgeInsets.only(left: 110),
              child: Text(
                _ownerSession.isEmpty
                    ? '没选会话：鱼自己调模型、自己发 QQ（不经过 DSH 会话）。'
                    : '选了会话：消息投到那个 DSH 会话，由里面的 agent 回。',
                style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant),
              ),
            ),
          ],
            ]),
          ),
        ),
      ),
      FishCard(
        id: 'pf-storage',
        title: '存储位置',
        note: profile.storage.length.toString() + ' 处',
        width: 1400,
        height: 220,
        child: storage.isEmpty
            ? const FishEmpty(text: '没有读到存储位置。')
            : FishScrollList(children: [
                Wrap(spacing: 18, runSpacing: 0, children: [
                  for (final s in storage)
                    SizedBox(width: 660, child: FishRow(label: s.label.isEmpty ? '未命名' : s.label, value: s.path.isEmpty ? '—' : s.path)),
                ]),
              ]),
      ),
    ];
  }

  Widget _kv(String label, String value) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 9),
        child: Row(children: [
          SizedBox(width: 110, child: Text(label, style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.onSurfaceVariant))),
          Expanded(child: Text(value, style: TextStyle(fontSize: 13, color: Theme.of(context).colorScheme.onSurface))),
        ]),
      );

  Future<void> _openEditor(String initial) async {
    final ctl = TextEditingController(text: initial);
    String err = '';
    var saving = false;
    final saved = await showDialog<String>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => StatefulBuilder(builder: (ctx, setD) {
        Future<void> commit() async {
          setD(() { saving = true; err = ''; });
          final r = await bridge.bridgeFishPersonaSave(_roleId, ctl.text);
          if (!ctx.mounted) return;
          if (r != null && r['ok'] == true) { Navigator.pop(ctx, ctl.text); return; }
          setD(() { saving = false; err = r == null ? '没连上主程序' : (r['error'] ?? '保存失败').toString(); });
        }
        final count = ctl.text.characters.length.toString() + ' 字';
        return CallbackShortcuts(
          bindings: {
            const SingleActivator(LogicalKeyboardKey.keyS, control: true): commit,
            const SingleActivator(LogicalKeyboardKey.escape): () => Navigator.pop(ctx),
          },
          child: Focus(
            autofocus: true,
            child: Dialog(
              insetPadding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
              child: SizedBox(
                width: 900,
                height: MediaQuery.of(ctx).size.height * 0.8,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(18, 16, 18, 12),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    Row(children: [
                      const Text('编辑人设卡', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                      const SizedBox(width: 10),
                      Text('Ctrl+S 保存 · Esc 取消', style: TextStyle(fontSize: 11, color: Theme.of(ctx).colorScheme.onSurfaceVariant)),
                      const Spacer(),
                      Text(count, style: TextStyle(fontSize: 11, color: Theme.of(ctx).colorScheme.onSurfaceVariant)),
                    ]),
                    if (err.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text(err, style: TextStyle(fontSize: 11, color: Theme.of(ctx).colorScheme.error))),
                    const SizedBox(height: 8),
                    Expanded(child: TextField(controller: ctl, maxLines: null, expands: true, onChanged: (_) => setD(() {}), style: const TextStyle(fontSize: 13, height: 1.6), decoration: const InputDecoration(border: OutlineInputBorder(), isDense: true))),
                    const SizedBox(height: 8),
                    Row(children: [
                      Text(saving ? '保存中…' : '未保存的修改不会自动落盘', style: TextStyle(fontSize: 11, color: Theme.of(ctx).colorScheme.onSurfaceVariant)),
                      const Spacer(),
                      TextButton(onPressed: saving ? null : () => Navigator.pop(ctx), child: const Text('取消')),
                      const SizedBox(width: 8),
                      FilledButton(onPressed: saving ? null : commit, child: const Text('保存')),
                    ]),
                  ]),
                ),
              ),
            ),
          ),
        );
      }),
    );
    ctl.dispose();
    if (saved != null && mounted) { setState(() => _persona = saved); _setAction('人设已保存（已备份，回读一致）'); await _loadPersona(_roleId); }
  }

  Future<void> _roleDialog() async {
    final ctl = TextEditingController();
    final name = await showDialog<String>(context: context, builder: (ctx) => AlertDialog(
      title: const Text('新建角色'),
      content: TextField(controller: ctl, autofocus: true, decoration: const InputDecoration(labelText: '角色名（≤16 字）')),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')), FilledButton(onPressed: () => Navigator.pop(ctx, ctl.text.trim()), child: const Text('创建'))],
    ));
    ctl.dispose();
    if (name != null && name.isNotEmpty) await _roles('create', name: name);
  }

  Future<void> _renameDialog(String id) async {
    final ctl = TextEditingController();
    final name = await showDialog<String>(context: context, builder: (ctx) => AlertDialog(
      title: const Text('重命名角色'),
      content: TextField(controller: ctl, autofocus: true, decoration: const InputDecoration(labelText: '新名字（≤16 字）')),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')), FilledButton(onPressed: () => Navigator.pop(ctx, ctl.text.trim()), child: const Text('改名'))],
    ));
    ctl.dispose();
    if (name != null && name.isNotEmpty) await _roles('rename', id: id, name: name);
  }

  Future<void> _deleteDialog(String id) async {
    final ok = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: const Text('删除角色'),
      content: const Text('删掉这张角色卡？不可撤销。', style: TextStyle(fontSize: 13)),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')), FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('删除'))],
    ));
    if (ok == true) await _roles('remove', id: id);
  }

  Widget _empty(String text) => FishCard(id: 'profile-empty', title: '鱼的设定', width: 460, height: 150, child: FishScrollText(text: '', emptyText: text));
}

class _EditableLine extends StatefulWidget {
  final String label;
  final String value;
  final bool enabled;
  final ValueChanged<String> onSave;
  const _EditableLine({required this.label, required this.value, required this.enabled, required this.onSave});
  @override
  State<_EditableLine> createState() => _EditableLineState();
}

class _EditableLineState extends State<_EditableLine> {
  bool _editing = false;
  bool _committing = false;
  late final TextEditingController _ctl = TextEditingController(text: widget.value);
  @override
  void didUpdateWidget(covariant _EditableLine old) { super.didUpdateWidget(old); if (!_editing && widget.value != _ctl.text) _ctl.text = widget.value; }
  @override
  void dispose() { _ctl.dispose(); super.dispose(); }
  void _commit() {
    if (!_editing || _committing) return;
    _committing = true;
    setState(() => _editing = false);
    final v = _ctl.text.trim();
    if (v.isNotEmpty && v != widget.value) widget.onSave(v);
    _committing = false;
  }
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 9),
      child: Row(children: [
        SizedBox(width: 110, child: Text(widget.label, style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant))),
        Expanded(
          child: _editing
              ? Focus(
                  onFocusChange: (f) { if (!f) _commit(); },
                  child: CallbackShortcuts(
                    bindings: {const SingleActivator(LogicalKeyboardKey.escape): () { setState(() { _ctl.text = widget.value; _editing = false; }); }},
                    child: Focus(autofocus: true, child: TextField(controller: _ctl, onSubmitted: (_) => _commit(), style: const TextStyle(fontSize: 13), decoration: const InputDecoration(isDense: true, border: OutlineInputBorder()))),
                  ),
                )
              : InkWell(
                  onTap: widget.enabled ? () => setState(() => _editing = true) : null,
                  child: Row(children: [
                    Text(widget.value.isEmpty ? '—' : widget.value, style: TextStyle(fontSize: 13, color: scheme.onSurface)),
                    if (widget.enabled) Padding(padding: const EdgeInsets.only(left: 6), child: Icon(Icons.edit_outlined, size: 12, color: scheme.onSurfaceVariant)),
                  ]),
                ),
        ),
      ]),
    );
  }
}

class _RoleTile extends StatelessWidget {
  final FishPersona role;
  final bool active;
  final VoidCallback? onTap;
  const _RoleTile({required this.role, required this.active, this.onTap});
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(9),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(color: active ? scheme.primaryContainer.withValues(alpha: .4) : scheme.surface, borderRadius: BorderRadius.circular(9), border: Border.all(color: active ? scheme.primary.withValues(alpha: .5) : scheme.outlineVariant)),
        child: Text(role.name.isEmpty ? role.id : role.name, style: TextStyle(fontSize: 12, fontWeight: active ? FontWeight.w600 : FontWeight.w400, color: active ? scheme.primary : scheme.onSurface)),
      ),
    );
  }
}

class _ProfileHero extends StatelessWidget {
  final FishProfile profile;
  final FishPersona? current;
  const _ProfileHero({required this.profile, this.current});
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    // 角色名：有名字用名字，没名字退到 roleId，再没有就「当前角色」。
    final roleId = current?.id ?? '';
    final name = (current?.name ?? '').trim();
    final title = name.isNotEmpty
        ? name
        : (roleId.isNotEmpty ? roleId : '当前角色');
    return Row(children: [
      IgnorePointer(child: FishAvatar(profile: profile, size: 150)),
      const SizedBox(width: 18),
      Expanded(child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title, style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700, color: scheme.primary)),
        const SizedBox(height: 8),
        // ★ 这里**不再渲染人设正文**。
        //   正文开头是「标题 + ════ 分隔线 + 空行」，整段塞进来时那条分隔线
        //   在小卡片里看着就像一条空输入框的下划线（用户报「显示错乱」）。
        //   正文归「人设卡」；这里只留一行身份说明。
        Text(
          roleId.isEmpty ? '当前角色' : '当前角色 · ' + roleId,
          style: TextStyle(
              fontSize: WhaleTokens.fsSub,
              height: 1.6,
              color: scheme.onSurfaceVariant),
        ),
      ])),
    ]);
  }
}

// 测试钩子：只渲染主人绑定卡，不跑整页（整页首帧会拉真实 IO）。
//
// ★ 2026-11-21 同步过：主卡片的绑定 UI 改了（状态二元、输入不被重置、
//   绑定信息独立一行、按钮恒「保存」），这里必须跟着改 ——
//   否则 widget 判据看到的是旧界面，等于在验一个已经不存在的东西。
List<Widget> buildOwnerBindingCardsForTest({
  required bool desktop,
  required String ownerQQ,
  required bool binding,
  required String boundQQ,
  required String boundAt,
  required bool failed,
  String failMsg = '本机配置写不进',
  String replyMode = 'api',
}) {
  return [
    Builder(builder: (context) {
      final scheme = Theme.of(context).colorScheme;
      final ctl = TextEditingController(text: ownerQQ);
      final ok = WhaleTokens.successFor(scheme.brightness);
      final neutral = scheme.onSurfaceVariant;
      final bound = boundQQ.isNotEmpty;
      return FishCard(
        id: 'pf-owner-test',
        title: desktop ? '主人 QQ' : '主人绑定',
        // 只显示上次保存时间，没有就不显示（和主卡片一致）
        note: boundAt.isEmpty ? '' : '上次保存 ' + boundAt,
        width: 1400,
        height: desktop ? 190 : 300,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          // 未绑定：中性提示（不是红/橙）
          if (!bound) ...[
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                  color: neutral.withValues(alpha: .07),
                  borderRadius: BorderRadius.circular(8)),
              child: Row(children: [
                Icon(Icons.info_outline, size: 15, color: neutral),
                const SizedBox(width: 6),
                Expanded(
                    child: Text(
                        desktop ? '主人 QQ 用你真实的号。' : '主人 QQ + 会话都要对；绑错等于鱼认错人。',
                        style: TextStyle(fontSize: 11, color: neutral))),
              ]),
            ),
            const SizedBox(height: 12),
          ],
          Row(children: [
            SizedBox(width: 110, child: Text('主人 QQ', style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant))),
            SizedBox(
                width: 240,
                child: TextField(
                    controller: ctl,
                    enabled: !binding,
                    decoration: const InputDecoration(isDense: true, border: OutlineInputBorder()),
                    style: const TextStyle(fontSize: 13))),
            const SizedBox(width: 12),
            SizedBox(
              width: 136,
              child: FilledButton(
                onPressed: binding ? null : () {},
                child: binding
                    ? const Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                        SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.6)),
                        SizedBox(width: 6),
                        Text('保存中…', style: TextStyle(fontSize: 12)),
                      ])
                    // 按钮恒为「保存」
                    : const Text('保存', maxLines: 1, softWrap: false),
              ),
            ),
          ]),
          // 已绑定：独立一行
          if (bound) ...[
            const SizedBox(height: 10),
            Row(children: [
              Icon(Icons.check_circle_outline, size: 14, color: ok),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                    '已绑定 · ' +
                        boundQQ +
                        (boundAt.isEmpty ? '' : ' · ' + boundAt) +
                        ' · ' +
                        (replyMode == 'api' ? 'API 直回' : '投会话'),
                    style: TextStyle(fontSize: 12, color: ok)),
              ),
            ]),
          ],
          // 失败：红字 + 原因 + 重试（不动输入框内容）
          if (failed) ...[
            const SizedBox(height: 8),
            Row(children: [
              Icon(Icons.error_outline, size: 14, color: scheme.error),
              const SizedBox(width: 6),
              Text('保存失败：' + failMsg, style: TextStyle(fontSize: 12, color: scheme.error)),
              const SizedBox(width: 12),
              TextButton(onPressed: () {}, child: const Text('重试')),
            ]),
          ],
        ]),
      );
    }),
  ];
}

// 主人绑定提示条：只在**未绑定**时出现。中性色 —— 未绑定是正常状态，不是错误。
  /// 未绑定时的提示。
  ///
  /// ★ 2026-11-21 主人要求：**中性提示，不是红/橙**。
  ///   「未绑定」是正常状态（刚装好、还没填），不是错误 ——
  ///   拿 warning 色挂着等于一直暗示"你出问题了"。
  ///   红只留给保存失败，而且那时走的是 _ownerFailInline，不走这里。
  Widget _ownerHintWidget(BuildContext context, ColorScheme scheme,
      {required bool desktop}) {
    final color = scheme.onSurfaceVariant; // 中性：和普通说明文字同色，不抢注意力
    final text = desktop
        ? '主人 QQ 用你真实的号。'
        : '主人 QQ + 会话都要对；绑错等于鱼认错人。';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
          color: scheme.onSurfaceVariant.withValues(alpha: .07),
          borderRadius: BorderRadius.circular(8)),
      child: Row(children: [
        Icon(Icons.info_outline, size: 15, color: color),
        const SizedBox(width: 6),
        Expanded(child: Text(text, style: TextStyle(fontSize: 11, color: color))),
      ]),
    );
  }
