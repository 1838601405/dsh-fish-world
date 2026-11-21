import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter/foundation.dart' show kIsWeb;

import '../data/bridge.dart';
import '../data/fish_data.dart';
import '../data/qq_gateway.dart';
import '../theme/whale_tokens.dart';
import '../ui_motion.dart';
import 'ui_kit/ui_kit.dart';
import '../fish_nav.dart';
import '../sidebar.dart';
import 'ui_kit/setup_checklist.dart';
import '../data/open_url_web.dart'
    if (dart.library.io) '../data/open_url_stub.dart' as opener;
import '../data/ui_store.dart';

// ignore_for_file: prefer_interpolation_to_compose_strings

// 本页调色板：在页面 build 时从 Theme 派生，子组件统一读这几个变量。
Color _canvas = Colors.transparent; // 画布用全局辉光，不在这里平涂
Color _card = Colors.transparent;
Color _line = Colors.transparent;
Color _text = Colors.transparent;
Color _muted = Colors.transparent;
Color _error = Colors.transparent;
Color _positive = Colors.transparent;
Color _success = Colors.transparent;
Color _onPrimary = Colors.transparent;

void qqApplyPaletteForTest(ColorScheme s) => _applyPalette(s);

void _applyPalette(ColorScheme s) {
  _canvas = Colors.transparent;
  _card = s.surfaceContainerHighest;
  _line = s.outlineVariant;
  _text = s.onSurface;
  _success = WhaleTokens.successFor(s.brightness);
  _muted = s.onSurfaceVariant;
  _error = s.error;
  _positive = s.primary;
  _onPrimary = s.onPrimary;
}

class FishPlatformsPage extends StatefulWidget {
  const FishPlatformsPage({super.key});
  @override
  State<FishPlatformsPage> createState() => _FishPlatformsPageState();
}

class _FishPlatformsPageState extends State<FishPlatformsPage> {
  Future<FishSnapshot> _future = FishWorld.load();
  final _groupCtl = TextEditingController();
  final _groupNameCtl = TextEditingController();
  // 好友单独一组：QQ 号 + 可选备注。和群分开，是因为 chatKey 前缀不同
  // （group: / private:），混在一个输入框里没法校验，也没法显示类型。
  final _friendCtl = TextEditingController();
  final _friendNameCtl = TextEditingController();
  final _baseCtl = TextEditingController();
  final _tokenCtl = TextEditingController();
  Map<String, dynamic>? _live;
  bool _busy = false;
  bool _protocolBusy = false;
  bool _protoRunning = false;
  bool _protoKnown = false;
  bool _advOpen = false;
  bool _needAuth = false;
  String _testMsg = '';
  bool _testErr = false;
  String _webui = 'http://127.0.0.1:5099';
  bool _autoOpened = false;
  String? _loginHintUrl;
  String _actionMsg = '';
  bool _actionErr = false;
  bool _actionBusy = false;
  VoidCallback? _retryAction;
  bool _preview = false;
  // ⭐ 2026-11-20（主人要求 A）：桥超窗未投的消息。
  //   以前「投不进去就丢掉」只写桥日志，主人看不到 —— 这里存下来给卡片显示。
  Map<String, dynamic>? _undelivered;
  bool _undeliveredBusy = false;
  bool _picking = false;

  int _tab = int.tryParse(UiStore.get('fw.platforms.tab') ?? '') ?? 0;
  final Map<String, Object?> _draft = {};
  Map<String, dynamic>? _config;
  List<Map<String, dynamic>> _localChats = const [];
  final Map<String, bool> _chatEnabledDraft = {};
  final FocusNode _groupFocus = FocusNode();
  String _ownerQQValue = '';
  void _rememberOwner(FishSnapshot data) {
    _ownerQQValue = data.qq.configText('私聊QQ');
  }

  Timer? _timer;

  @override
  void initState() {
    super.initState();
    final cached = UiStore.get('fw.platforms.live');
    if (cached != null) {
      try {
        final raw = jsonDecode(cached);
        if (raw is Map) _live = Map<String, dynamic>.from(raw);
      } catch (_) {}
    }
    FishNav.registerField('qq.group', _groupFocus);
    _loadLive();
    // ⭐ 2026-11-20：超窗未投的消息要在进页面时就拿到 ——
    //   这是「主人以为没回」的现场，不能等他自己点刷新才出现。
    _loadUndelivered(silent: true);
    _timer = Timer.periodic(const Duration(seconds: 12), (_) {
      _loadLive(silent: true);
      // 未投队列跟着一起刷：新丢的消息要在 12 秒内出现在卡上，
      // 否则主人还是会以为「发了没回」。silent 不转圈，不打扰。
      _loadUndelivered(silent: true);
    });
    _loadConfig();
    bridgeHealth().then((ok) {
      if (mounted) setState(() => _preview = !ok);
    }).catchError((_) {});
  }

  @override
  void dispose() {
    _timer?.cancel();
    _groupFocus.dispose();
    _baseCtl.dispose();
    _tokenCtl.dispose();
    _groupCtl.dispose();
    _groupNameCtl.dispose();
    _friendCtl.dispose();
    _friendNameCtl.dispose();
    super.dispose();
  }

  static const Map<String, String> _modeLabels = {
    'shy': '社恐',
    'quiet': '安静',
    'normal': '正常',
    'active': '活跃',
    'frenzy': '狂热',
  };

  /// 读桥的超窗未投队列。
  ///
  /// ★ 这是「丢弃要可见」的落点：桥投不进去的消息以前只写它自己的日志，
  ///   主人以为没回。现在拿上来显示，并给「补投」按钮由主人决定要不要让它回。
  Future<void> _loadUndelivered({bool silent = false}) async {
    if (!silent) setState(() => _undeliveredBusy = true);
    try {
      final r = await qqGateway.undelivered();
      if (!mounted) return;
      setState(() {
        _undelivered = r;
        _undeliveredBusy = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _undeliveredBusy = false);
    }
  }

  /// 未投条数（读不出来就算 0，不显示卡片）。
  int _undeliveredCount() {
    final d = _undelivered;
    if (d == null || d['ok'] != true) return 0;
    final n = d['count'];
    return n is int ? n : 0;
  }

  /// 补投：id 为空表示全部。
  Future<void> _redeliver(String? id) async {
    setState(() => _undeliveredBusy = true);
    final r = await qqGateway.redeliver(id: id, all: id == null);
    if (!mounted) return;
    final ok = r?['ok'] == true;
    setState(() {
      _undeliveredBusy = false;
      _actionMsg = ok
          ? (id == null ? '已提交全部补投' : '已提交补投')
          : '补投失败：' + ((r?['error'] ?? '未知原因').toString());
      _actionErr = !ok;
      _retryAction = ok ? null : () => _redeliver(id);
    });
    // 补投后队列会变，重新读一次（稍等桥处理）
    await Future.delayed(const Duration(milliseconds: 600));
    if (mounted) await _loadUndelivered(silent: true);
  }

  Future<void> _loadConfig() async {
    final r = await qqGateway.loadConfig();
    if (!mounted) return;
    if (r != null && r['ok'] == true && r['config'] is Map) {
      setState(() => _config = Map<String, dynamic>.from(r['config'] as Map));
    }
  }

  Future<void> _saveQzone(String key, num value) async {
    final before = _config == null
        ? null
        : Map<String, dynamic>.from((_config!['qzone'] as Map?) ?? {});
    setState(() {
      final q = Map<String, dynamic>.from((_config?['qzone'] as Map?) ?? {});
      q[key] = value;
      _config = {...?_config, 'qzone': q};
    });
    final r = await bridgeConfigSave({
      'qzone': {key: value}
    });
    if (!mounted) return;
    if (r != null && r['ok'] == true) {
      _clearAction();
      if (r['config'] is Map)
        setState(() => _config = Map<String, dynamic>.from(r['config'] as Map));
    } else {
      setState(() {
        if (before != null) _config = {...?_config, 'qzone': before};
      });
      final err =
          r == null ? '没连上主程序（本地预览没有桥）' : (r['error'] ?? '未知错误').toString();
      _setAction('保存失败：' + err, err: true, retry: () => _saveQzone(key, value));
    }
  }

  void _setAction(String msg, {bool err = false, VoidCallback? retry}) {
    _actionBusy = msg.endsWith('…');
    if (!mounted) return;
    setState(() {
      _actionMsg = msg;
      _actionErr = err;
      _retryAction = retry;
    });
  }

  void _clearAction() {
    if (!mounted) return;
    setState(() {
      _actionMsg = '';
      _actionErr = false;
      _retryAction = null;
    });
  }

  void _snack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(context)
        ?.showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _loadLive({bool silent = false}) async {
    // P7-3：优先读单一状态机；老后端没有 /qq/state 时退回旧两接口。
    final r = await qqGateway.loginState();
    var protoRunning = _protoRunning;
    var webui = _webui;
    var protoKnown = _protoKnown;
    var needAuth = _needAuth;
    if (r != null) {
      final proto = r['protocol'];
      if (proto is Map) {
        protoKnown = true;
        protoRunning = proto['running'] == true;
        final w = (proto['webui'] ?? '').toString();
        if (w.isNotEmpty) webui = w;
      }
      needAuth = r['needAuth'] == true;
    }
    if (!mounted) return;
    setState(() {
      if (r != null) {
        _live = r;
        _preview = false;
      }
      _needAuth = needAuth;
      if (needAuth) _advOpen = true;
      _protoRunning = protoRunning;
      _protoKnown = protoKnown;
      _webui = webui;
    });
    if (r != null) UiStore.set('fw.platforms.live', jsonEncode(r));
  }

  Future<void> _openLogin() async {
    final ok = opener.openUrl(_webui);
    if (!mounted) return;
    _setAction(ok
        ? '已打开登录页 ' + _webui + ' · 需要扫码登录 QQ（登录后 4 秒内自动刷新）'
        : '打不开浏览器，请手动访问 ' + _webui + ' 扫码登录');
  }

  Future<void> _saveConfig() async {
    _setAction('保存中…');
    try {
      final r = await qqGateway.saveConfig(
          baseUrl: _baseCtl.text, token: _tokenCtl.text);
      if (!mounted) return;
      if (r != null && r['ok'] == true) {
        _baseCtl.clear();
        _tokenCtl.clear();
        await _loadLive(silent: true);
        if (!mounted) return;
        _setAction('接入配置已保存（回读校验通过）');
      } else {
        final err =
            r == null ? '没连上主程序（本地预览没有桥）' : (r['error'] ?? '未知错误').toString();
        _setAction('保存失败：' + err, err: true, retry: _saveConfig);
      }
    } catch (e) {
      _setAction('保存失败：' + e.toString(), err: true, retry: _saveConfig);
    }
  }

  Future<void> _toggleLive() async {
    if (_busy) return;
    final running = _live?['running'] == true;
    setState(() => _busy = true);
    try {
      final r = await qqGateway.setReceiving(!running);
      if (!mounted) return;
      if (r != null && r['ok'] == true) {
        _clearAction();
        await _loadLive(silent: true);
        if (!mounted) return;
        _snack(running ? 'QQ 接收已停止' : 'QQ 接收已开启');
      } else {
        final err =
            r == null ? '没连上主程序（本地预览没有桥）' : (r['error'] ?? '未知').toString();
        _setAction((running ? '停止接收失败：' : '开始接收失败：') + err,
            err: true, retry: _toggleLive);
      }
    } catch (e) {
      _setAction('操作失败：' + e.toString(), err: true, retry: _toggleLive);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _stopProtocol({bool restart = false}) async {
    _setAction(restart ? '正在结束旧进程…' : '正在结束协议端…');
    final r = await qqGateway.stopProtocol();
    final res = r?['result'] as Map?;
    final ok = r != null && r['ok'] == true && (res?['ok'] != false);
    if (!mounted) return;
    if (!ok) {
      final err = r == null
          ? '没连上主程序'
          : (res?['error'] ?? r['error'] ?? '结束失败').toString();
      _setAction('结束失败：' + err,
          err: true, retry: () => _stopProtocol(restart: restart));
      return;
    }
    setState(() => _protoRunning = false);
    if (restart) {
      await Future.delayed(const Duration(seconds: 1));
      if (!mounted) return;
      await _startProtocol();
      return;
    }
    await _loadLive(silent: true);
    if (!mounted) return;
    _setAction('协议端已结束（剩余进程 ' + ((res?['remaining'] ?? 0).toString()) + '）');
  }

  Future<void> _confirmStopProtocol() async {
    final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
              title: const Text('结束协议端'),
              content: const Text(
                  '这是真关进程：关掉后鱼完全收发不了，QQ 会掉线；只不想收发请用右上角「停止接收」，那个不关进程。',
                  style: TextStyle(fontSize: 13)),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(ctx, false),
                    child: const Text('取消')),
                FilledButton(
                    onPressed: () => Navigator.pop(ctx, true),
                    child: const Text('结束进程'))
              ],
            ));
    if (ok == true) await _stopProtocol();
  }

  Future<void> _testConnection() async {
    setState(() {
      _testMsg = '测试中…';
      _testErr = false;
    });
    // 唯一真相：与顶部状态栏同读 /qq/status 的 login，避免同页两个结论。
    final st = _live ?? await qqGateway.loginState();
    if (!mounted) return;
    if (st == null) {
      setState(() {
        _testMsg = '没连上主程序';
        _testErr = true;
      });
      return;
    }
    final login = (st['login'] as Map?) ?? const {};
    if (login['ok'] == true) {
      final n = (login['nickname'] ?? '').toString();
      setState(() {
        _testMsg = '已连上' + (n.isEmpty ? '' : ' · ' + n);
        _testErr = false;
        _needAuth = false;
      });
      return;
    }
    final err = (login['error'] ?? '').toString();
    final low = err.toLowerCase();
    final down = low.contains('fetch') ||
        low.contains('econn') ||
        low.contains('abort') ||
        err.contains('连接失败') ||
        low.contains('http 0');
    final auth = err.contains('401') ||
        low.contains('unauthorized') ||
        err.contains('密钥');
    setState(() {
      if (auth) {
        _testMsg = '接口密钥不对';
        _needAuth = true;
        _advOpen = true;
      } else if (down) {
        _testMsg = '协议端没启动，先点启动';
      } else {
        _testMsg = '连接失败：' + (err.isEmpty ? '未知错误' : err);
      }
      _testErr = true;
    });
  }

  Future<void> _startProtocol() async {
    if (_protocolBusy) return;
    setState(() => _protocolBusy = true);
    _setAction('启动中…');
    try {
      final r = await qqGateway.startProtocol();
      if (!mounted) return;
      final ok = r != null && r['ok'] == true;
      if (!ok) {
        final err =
            r == null ? '没连上主程序（本地预览没有桥）' : (r['error'] ?? '未知错误').toString();
        _setAction('启动失败：' + err, err: true, retry: _startProtocol);
        return;
      }
      final result = r['result'] as Map?;
      final resultOk = result != null && result['ok'] == true;
      if (!resultOk) {
        final why =
            (result == null ? '响应里没有 result' : (result['error'] ?? '协议端没起来'))
                .toString();
        _setAction('启动失败：' + why, err: true, retry: _startProtocol);
        return;
      }
      final already = result['alreadyRunning'] == true;
      final webui = (r['webui'] ?? 'http://127.0.0.1:5099').toString();
      setState(() {
        _webui = webui;
        _protoRunning = true;
      });
      _setAction(already ? '协议端已经在跑' : '启动中…');
      // 拉起后自动打开登录页（只在这个动作里开一次；手动按钮随时可点）。
      if (!already && !_autoOpened) {
        _autoOpened = true;
        if (mounted) setState(() => _loginHintUrl = webui);
        // 5099 刚拉起时要几百毫秒才监听，等一会再开，避免弹 chrome-error。
        await Future.delayed(const Duration(milliseconds: 1500));
        opener.openUrl(webui);
      } else {
        if (mounted) setState(() => _loginHintUrl = webui);
      }
      // 协议端起来后要登录，不会立刻可答；等几秒再刷状态。
      await Future.delayed(const Duration(seconds: 4));
      await _loadLive(silent: true);
      if (!mounted) return;
      _setAction(already ? '协议端已经在跑 · 未登录' : '协议端已拉起 · 未登录');
    } catch (e) {
      _setAction('启动失败：' + e.toString(), err: true, retry: _startProtocol);
    } finally {
      if (mounted) {
        setState(() {
          _protocolBusy = false;
        });
      }
    }
  }

  Future<void> _setEnabled(bool v) async {
    final r = await qqGateway.saveField('enabled', v);
    if (!mounted) return;
    if (r != null && r['ok'] == true) {
      await _loadLive(silent: true);
      if (!mounted) return;
      _snack(v ? 'QQ 能力已启用' : 'QQ 能力已停用');
    } else {
      _snack(
          '没存成：' + (r == null ? '没连上主程序' : (r['error'] ?? '未知错误').toString()));
    }
  }

  /// 乐观更新：先改本地草稿，再发；失败回滚并给页内状态（不弹提醒）。
  Future<void> _saveField(String key, Object? value,
      {bool bili = false}) async {
    final dk = (bili ? 'bili:' : 'qq:') + key;
    setState(() => _draft[dk] = value);
    final r = bili
        ? await bridgeBiliField(key, value)
        : await qqGateway.saveField(key, value);
    if (!mounted) return;
    if (r != null && r['ok'] == true) {
      _clearAction();
      await _loadLive(silent: true);
    } else {
      setState(() => _draft.remove(dk));
      final err =
          r == null ? '没连上主程序（本地预览没有桥）' : (r['error'] ?? '未知错误').toString();
      _setAction('保存失败：' + err,
          err: true, retry: () => _saveField(key, value, bili: bili));
    }
  }

  Widget _fieldRow(FishField field, {bool bili = false}) {
    final dk = (bili ? 'bili:' : 'qq:') + field.key;
    final value = _draft.containsKey(dk) ? _draft[dk] : field.value;
    if (field.isBool) {
      return _SwitchRow(
        title: field.label,
        hint: field.hint,
        value: value == true,
        danger: field.danger,
        onChanged: (!bili && field.key == 'enabled')
            ? _setEnabled
            : (v) => _saveField(field.key, v, bili: bili),
      );
    }
    if (field.key == 'dailyMessages') {
      final n = value is num ? value.toInt() : 0;
      return _DailyLimitRow(
          value: n, onSave: (v) => _saveField(field.key, v, bili: bili));
    }
    if (field.key == 'stickerSubType') {
      return _SelectField(
        title: field.label,
        hint: field.hint,
        value: (value is num ? value.toInt() : 0),
        options: const {0: '普通大图', 1: '小表情（可长按收藏）'},
        onChanged: (v) => _saveField(field.key, v, bili: bili),
      );
    }
    if (field.isNumber) {
      return _NumField(
        title: field.label,
        hint: field.hint,
        value: value is num ? value.toDouble() : (field.min ?? 0).toDouble(),
        min: (field.min ?? 0).toDouble(),
        max: (field.max ?? 999999).toDouble(),
        unit: field.unit,
        onSave: (v) => _saveField(field.key, v, bili: bili),
      );
    }
    return _PropertyRow(label: field.label, value: field.displayValue);
  }

  List<Map<String, Object?>> _chatMaps(FishSnapshot data) {
    final ownerQQ = data.qq.configText('私聊QQ');
    final out = <Map<String, Object?>>[];
    final seen = <String>{};
    if (!kIsWeb && _config != null && _config!['allowChats'] is List) {
      for (final raw in _localChats) {
        final key = (raw['chatKey'] ?? '').toString();
        if (key.isEmpty || !seen.add(key)) continue;
        out.add({
          'chatKey': key,
          'name': (raw['name'] ?? '').toString(),
          'sessionId': '',
          'enabled': raw['enabled'] != false,
          'mode': (raw['mode'] ?? '').toString(),
        });
      }
      return _sanitizeChats(out);
    }
    for (final chat in data.qq.chats) {
      final key = (chat.type == 'group' ? 'group:' : 'private:') + chat.id;
      if (ownerQQ.isNotEmpty && key == 'private:' + ownerQQ) continue;
      if (!seen.add(key)) continue;
      out.add({
        'chatKey': key,
        'name': chat.title,
        'sessionId': chat.session,
        'enabled': _chatEnabledDraft.containsKey(key)
            ? _chatEnabledDraft[key]!
            : chat.mode != 'off',
        'mode': chat.mode == 'off' ? '' : chat.mode,
      });
    }
    return _sanitizeChats(out);
  }

  List<Map<String, Object?>> _sanitizeChats(List<Map<String, Object?>> list) {
    final out = <Map<String, Object?>>[];
    final seen = <String>{};
    for (final e in list) {
      final key = (e['chatKey'] ?? '').toString();
      if (key.isEmpty ||
          key.startsWith('private:') &&
              _ownerQQValue.isNotEmpty &&
              key == 'private:' + _ownerQQValue) continue;
      if (!seen.add(key)) continue;
      out.add(e);
    }
    return out;
  }

  Future<void> _saveChats(
      FishSnapshot data, List<Map<String, Object?>> list) async {
    _rememberOwner(data);
    list = _sanitizeChats(list);
    _setAction('保存中…');
    try {
      final r = await qqGateway.saveField('allowChats', list);
      if (!mounted) return;
      if (r != null && r['ok'] == true) {
        setState(() => _future = FishWorld.reload());
        _setAction('允许名单已保存（回读校验）');
      } else {
        var err =
            r == null ? '没连上主程序（本地预览没有桥）' : (r['error'] ?? '未知错误').toString();
        // 后端拒绝时会说哪条；前端再补上第几条，避免只给笼统“保存失败”。
        for (var i = 0; i < list.length; i++) {
          final key = (list[i]['chatKey'] ?? '').toString();
          if (key.isNotEmpty && err.contains(key)) {
            err = '第 ' + (i + 1).toString() + ' 条（' + key + '）不能保存：' + err;
            break;
          }
        }
        _setAction('保存失败：' + err,
            err: true, retry: () => _saveChats(data, list));
      }
    } catch (e) {
      _setAction('保存失败：' + e.toString(),
          err: true, retry: () => _saveChats(data, list));
    }
  }

  static final RegExp _qqIdPattern = RegExp(r'^[0-9]{5,12}$');

  /// 群聊：群号 + 群名 → chatKey = group:<id>
  Future<void> _addGroupChat(FishSnapshot data) async {
    final id = _groupCtl.text.trim();
    if (!_qqIdPattern.hasMatch(id)) {
      _snack('群号要填 5–12 位数字');
      return;
    }
    final list = _chatMaps(data);
    if (list.any((e) => e['chatKey'] == 'group:' + id)) {
      _snack('这个群已经在名单里');
      return;
    }
    list.add({
      'chatKey': 'group:' + id,
      'name': _groupNameCtl.text.trim(),
      'sessionId': '',
      'enabled': true
    });
    await _saveChats(data, list);
    _groupCtl.clear();
    _groupNameCtl.clear();
  }

  /// 好友：QQ 号 + 备注（可选）→ chatKey = private:<id>
  ///
  /// 和群的关键差别：好友走的是 `private:` 前缀。校验分开做，
  /// 混用一个输入框就没法给出「群号要 5–12 位」「QQ 号要 5–12 位」这种准确提示。
  Future<void> _addFriendChat(FishSnapshot data) async {
    final id = _friendCtl.text.trim();
    if (!_qqIdPattern.hasMatch(id)) {
      _snack('QQ 号要填 5–12 位数字');
      return;
    }
    // 主人私聊由桥直连，不在白名单里；硬加会被 _sanitizeChats 剔除，不如当场说清。
    final owner = data.qq.configText('私聊QQ');
    if (owner.isNotEmpty && id == owner) {
      _snack('这是主人自己的号，不用加白名单');
      return;
    }
    final list = _chatMaps(data);
    if (list.any((e) => e['chatKey'] == 'private:' + id)) {
      _snack('这个好友已经在名单里');
      return;
    }
    list.add({
      'chatKey': 'private:' + id,
      'name': _friendNameCtl.text.trim(),
      'sessionId': '',
      'enabled': true
    });
    await _saveChats(data, list);
    _friendCtl.clear();
    _friendNameCtl.clear();
  }

  Future<void> _setMode(String mode) async {
    _setAction('保存中…');
    try {
      final r = await qqGateway.saveField('groupReplyMode', mode);
      if (!mounted) return;
      if (r != null && r['ok'] == true) {
        await _loadConfig();
        if (!mounted) return;
        _setAction('开口档位已保存');
      } else {
        final err =
            r == null ? '没连上主程序（本地预览没有桥）' : (r['error'] ?? '未知错误').toString();
        _setAction('保存失败：' + err, err: true, retry: () => _setMode(mode));
      }
    } catch (e) {
      _setAction('保存失败：' + e.toString(),
          err: true, retry: () => _setMode(mode));
    }
  }

  void _setTab(int i) {
    setState(() => _tab = i);
    UiStore.set('fw.platforms.tab', i.toString());
  }

  Future<void> _pickTargets(FishSnapshot data) async {
    if (_picking) return;
    setState(() => _picking = true);
    try {
      final existing = <String, Map<String, Object?>>{
        for (final m in _chatMaps(data)) m['chatKey'].toString(): m,
      };
      final picked = await showDialog<List<Map<String, Object?>>>(
        context: context,
        useRootNavigator: true,
        barrierColor: WhaleTokens.scrimFor(Theme.of(context).brightness),
        // 背景糊掉但不提亮：BackdropFilter 只模糊，「压暗」交给 barrierColor（深 55% / 浅 28%）。
        builder: (ctx) => AppScrim(
          blurSigma: 6,
          opacity: 0,
          borderRadius: BorderRadius.zero,
          child: QqPickTargetsDialog(existing: existing),
        ),
      );
      if (picked == null || !mounted) return;
      await _saveChats(data, picked);
    } finally {
      if (mounted) setState(() => _picking = false);
    }
  }

  void _copy(String text) {
    if (text.isEmpty) return;
    Clipboard.setData(ClipboardData(text: text));
    _snack('已复制');
  }

  @override
  Widget build(BuildContext context) {
    _applyPalette(Theme.of(context).colorScheme);
    return FutureBuilder<FishSnapshot>(
      future: _future,
      builder: (ctx, snap) {
        if (snap.connectionState != ConnectionState.done) return _skeleton();
        if (snap.hasError) return _empty(snap.error.toString());
        final data = snap.data ?? FishSnapshot.empty();
        if (!data.ok)
          return _empty(kIsWeb
              ? '还没读到鱼与世界的数据。请打开 DSH 桌面端，确认工作区已绑定。'
              : '这台机器上还没有鱼与世界的数据。');
        return _body(context, data);
      },
    );
  }

  Widget _body(BuildContext context, FishSnapshot data) {
    return ColoredBox(
      color: _canvas,
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(
            WhaleTokens.gap, WhaleTokens.gap, WhaleTokens.gap, 160),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 1100),
            child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(children: [
                    Text('鱼与世界',
                        style: TextStyle(
                            fontSize: 24,
                            fontWeight: FontWeight.w700,
                            color: _text)),
                    const Spacer(),
                    _Segmented(value: _tab, onChanged: _setTab),
                  ]),
                  const SizedBox(height: 8),
                  const SizedBox(height: 20),
                  const FishSetupChecklist(),
                  if (_preview && kIsWeb) _PreviewBanner(),
                  // ⭐ 2026-11-20：超窗未投的消息要显眼 —— 这是「主人以为没回」的根因。
                  //   放在页面靠上位置；没有未投就一个字都不加（不占地方、不制造噪音）。
                  if (_undeliveredCount() > 0)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 14),
                      child: _UndeliveredCard(
                        data: _undelivered!,
                        busy: _undeliveredBusy,
                        onRedeliver: _redeliver,
                      ),
                    ),
                  if (_actionMsg.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: FishStatusAction(
                        status: _actionBusy
                            ? FishStatusKind.busy
                            : (_actionErr
                                ? FishStatusKind.error
                                : FishStatusKind.ok),
                        message: _actionMsg,
                        action: FishAction(
                          label: _retryAction != null ? '重试' : '刷新状态',
                          kind: FishActionKind.retry,
                          handler: _retryAction ?? () => _loadLive(),
                        ),
                      ),
                    ),
                  if (_loginHintUrl != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 12, vertical: 9),
                        decoration: BoxDecoration(
                            color: _card,
                            borderRadius: BorderRadius.circular(9),
                            border: Border.all(color: _line)),
                        child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(children: [
                                Icon(Icons.open_in_new,
                                    size: 14, color: _muted),
                                const SizedBox(width: 7),
                                Text('已尝试打开登录页 · ',
                                    style:
                                        TextStyle(fontSize: 12, color: _muted)),
                                TextButton(
                                  style: TextButton.styleFrom(
                                      padding: EdgeInsets.zero,
                                      minimumSize: Size.zero,
                                      tapTargetSize:
                                          MaterialTapTargetSize.shrinkWrap),
                                  onPressed: () => _openLogin(),
                                  child: const Text('点这里手动打开',
                                      style: TextStyle(fontSize: 12)),
                                ),
                              ]),
                              const SizedBox(height: 4),
                              SelectableText(_loginHintUrl!,
                                  style:
                                      TextStyle(fontSize: 11, color: _muted)),
                              const SizedBox(height: 4),
                              Text(
                                  '登录页可能要输入 WebUI 密码（你自己设的），进去后再扫码登 QQ；登录成功这里会自动转「接收中」。',
                                  style: TextStyle(
                                      fontSize: 11,
                                      height: 1.5,
                                      color: _muted)),
                            ]),
                      ),
                    ),
                  if (_tab == 0) _qqCard(context, data),
                  if (_tab == 1) _biliCard(data),
                  if (_tab == 2) _rulesCard(),
                ]),
          ),
        ),
      ),
    );
  }

  String _nicknameOf() {
    final raw = _live?['login'];
    final login = raw is Map ? raw : null;
    final n = (login?['nickname'] ?? '').toString();
    final u = (login?['userId'] ?? '').toString();
    return n.isNotEmpty ? n : u;
  }

  /// 心跳是谁写的，翻成人话：'plugin' → 「插件在跑」/ 'desktop' → 「桌面版在跑」。
  /// 空串表示读不到（没心跳或旧格式），界面就不追加这段。
  String _heartbeatSource() {
    final raw = (_live?['heartbeatSource'] ?? '').toString().trim();
    if (raw.isEmpty) return '';
    if (raw == 'plugin') return '插件在跑';
    if (raw == 'desktop') return '桌面版在跑';
    return raw;
  }

  /// 心跳多久算「停了」：约定是 6 分钟写一次，容两拍就是 15 分钟。
  static const int _heartbeatStaleMs = 15 * 60 * 1000;

  /// 心跳状态：'ok' 正常 / 'stale' 停了 / 'none' 从没写过。
  /// 单独给一个字符串，界面要按状态上色，不能只靠一句「刚刚」。
  String _heartbeatState() {
    final ms = int.tryParse((_live?['lastTickAt'] ?? '0').toString()) ?? 0;
    if (ms <= 0) return 'none';
    final age = DateTime.now().millisecondsSinceEpoch - ms;
    return age > _heartbeatStaleMs ? 'stale' : 'ok';
  }

  String _heartbeatText() {
    final ms = int.tryParse((_live?['lastTickAt'] ?? '0').toString()) ?? 0;
    // ★ 没有心跳就说「心跳停了」，不再谎报「刚刚」。
    //   旧逻辑在 lastTickAt 缺值时用 now 顶上，服务停了一夜界面也显示正常。
    if (ms <= 0) return '心跳停了（没有记录）';
    final diff =
        DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(ms));
    if (diff.inMilliseconds > _heartbeatStaleMs) {
      return '心跳停了 · ' +
          (diff.inMinutes >= 60
              ? (diff.inHours.toString() + ' 小时前')
              : (diff.inMinutes.toString() + ' 分钟前'));
    }
    if (diff.inSeconds < 60) return '刚刚';
    if (diff.inMinutes < 60) return diff.inMinutes.toString() + ' 分钟前';
    if (diff.inHours < 24) return diff.inHours.toString() + ' 小时前';
    final t = DateTime.fromMillisecondsSinceEpoch(ms);
    return t.month.toString().padLeft(2, '0') +
        '-' +
        t.day.toString().padLeft(2, '0') +
        ' ' +
        t.hour.toString().padLeft(2, '0') +
        ':' +
        t.minute.toString().padLeft(2, '0');
  }

  String _sessionTitle(FishSnapshot data, String sid) {
    if (sid.isEmpty) return '未命名会话';
    for (final c in data.qq.chats) {
      if (c.session == sid && c.title.isNotEmpty) return c.title;
    }
    return '未命名会话';
  }

  static const List<List<String>> _capGroups = [
    ['收发', 'enabled,sendMessage,dailyMessages,stickerSubType'],
    ['读取', 'readHistory,groupNotice,videoFrames,forwardExpand'],
    [
      '攒批与开口',
      'batchEnabled,batchQuietSec,batchUnfinishedExtraSec,batchMaxWaitSec,liveContextCount'
    ],
    ['空间与外发', 'qzoneEnabled,qzoneDailyDiary,autoPokeBack,pokeTalk'],
  ];

  Widget _qqCard(BuildContext context, FishSnapshot data) {
    final qq = data.qq;
    final running = _live?['running'] == true;
    final rawLogin = _live?['login'];
    final loginOk = rawLogin is Map && rawLogin['ok'] == true;
    final connected = loginOk && (!_protoKnown || _protoRunning);
    final log = (_live?['log'] as List?) ?? const [];
    final config = qq.config;
    final hours = data.activity.todayHours;
    final todayTotal = hours.fold<int>(0, (a, b) => a + b);
    return _BigCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _CardHead(
          title: '鱼与 QQ',
          running: running,
          statusOk: connected,
          onRefresh: () => _loadLive(),
          onToggle: _busy ? null : _toggleLive,
          runningLabel: '',
        ),
        const SizedBox(height: 14),
        _QqHeader(
          live: _live,
          connected: connected,
          running: running,
          nickname: _nicknameOf(),
          busy: _busy,
          starting: _protocolBusy,
          todayReceive: qq.todayReceive,
          todaySend: qq.todaySend,
          todayGroups: qq.todayGroups,
          heartbeat: _heartbeatText(),
          onRetry: _loadLive,
          onToggle: _toggleLive,
          onStart: _startProtocol,
          onOpenLogin: _openLogin,
          onStopProtocol: _confirmStopProtocol,
          onRestartProtocol: () => _stopProtocol(restart: true),
          protoRunning: _protoRunning,
          webui: _webui,
        ),
        const SizedBox(height: 18),
        _TodaySpark(hours: hours, total: todayTotal),
        const SizedBox(height: 20),
        _forwardSection(context),
        const SizedBox(height: 20),
        LayoutBuilder(builder: (_, box) {
          final half = (box.maxWidth - 16) / 2;
          return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SizedBox(
                width: half,
                child: _Section(
                    title: '接入配置',
                    storageKey: 'qq.access',
                    anchor: 'qq.access',
                    initiallyExpanded: true,
                    children: [
                      _LabeledField(
                          label: '协议端地址',
                          controller: _baseCtl,
                          hint: config['baseUrl'] == null
                              ? 'http://127.0.0.1:3000'
                              : '当前 ' +
                                  config['baseUrl'].toString() +
                                  '（留空=不改）'),
                      const SizedBox(height: 8),
                      Text(
                          '协议端（SnowLuma）的 OneBot 接口设了 access_token 才需要填；没设就留空。这不是 5099 网页的登录密码。',
                          style: TextStyle(
                              fontSize: 11, height: 1.5, color: _muted)),
                      if (_needAuth) ...[
                        const SizedBox(height: 10),
                        Row(children: [
                          Icon(Icons.key_outlined, size: 14, color: _error),
                          const SizedBox(width: 6),
                          Expanded(
                              child: Text('协议端要求鉴权，请填它的接口密钥',
                                  style:
                                      TextStyle(fontSize: 12, color: _error))),
                        ]),
                      ],
                      const SizedBox(height: 10),
                      Row(children: [
                        TextButton.icon(
                          style: TextButton.styleFrom(
                              padding: EdgeInsets.zero,
                              minimumSize: Size.zero,
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap),
                          onPressed: () => setState(() => _advOpen = !_advOpen),
                          icon: Icon(
                              _advOpen ? Icons.expand_less : Icons.expand_more,
                              size: 16,
                              color: _muted),
                          label: Text('高级设置',
                              style: TextStyle(fontSize: 12, color: _muted)),
                        ),
                        const Spacer(),
                        _GhostButton(label: '测试连接', onTap: _testConnection),
                        const SizedBox(width: 8),
                        _PrimaryButton(label: '保存接入配置', onTap: _saveConfig),
                      ]),
                      if (_advOpen) ...[
                        const SizedBox(height: 12),
                        _LabeledField(
                            label: '协议端接口密钥',
                            controller: _tokenCtl,
                            hint: '填 SnowLuma 的 access_token；留空 = 保持原值（不回显）',
                            obscure: true),
                      ],
                      if (_testMsg.isNotEmpty) ...[
                        const SizedBox(height: 8),
                        Text(_testMsg,
                            style: TextStyle(
                                fontSize: 12,
                                color: _testErr ? _error : _success)),
                      ],
                    ])),
            const SizedBox(width: 16),
            SizedBox(
                width: half,
                child: _Section(
                    title: '运行状态',
                    storageKey: 'qq.status',
                    initiallyExpanded: true,
                    children: [
                      _PropertyRow(label: '总开关', value: qq.configText('总开关')),
                      _PropertyRow(label: '试运行', value: qq.configText('试运行')),
                      _PropertyRow(
                          label: '主人 QQ', value: qq.configText('私聊QQ')),
                      _PropertyRow(label: '群号', value: qq.configText('群号')),
                      _PropertyRow(
                          label: '世界目录',
                          value: data.roots.isEmpty ? '—' : data.roots.first),
                      if (!qqGateway.isDesktop)
                        _TargetSessionRow(
                            value: _sessionTitle(data, qq.configText('目标会话')),
                            uuid: qq.configText('目标会话'),
                            onCopy: _copy),
                      // 心跳停了要用警示色写出来：这是「服务没在跑」最快的现场信号，
                      // 和日志里其它只读属性不是一回事。
                      Builder(builder: (ctx) {
                        final state = _heartbeatState();
                        final warn = WhaleTokens.warningFor(
                            Theme.of(ctx).colorScheme.brightness);
                        final text = _heartbeatText();
                        // ★ 2026-11-20：插件现在也写同一个心跳文件，所以要说清是谁在写。
                        //   旧界面只有一个时间，分不清「桌面版在跑」还是「插件在跑」——
                        //   而这两者同时跑是会双回消息的，用户必须能一眼看出来。
                        final src = _heartbeatSource();
                        final value = state == 'ok' && src.isNotEmpty
                            ? text + ' · ' + src
                            : text;
                        return state == 'ok'
                            ? _PropertyRow(label: '最后心跳', value: value)
                            : _PropertyRow(
                                label: '最后心跳',
                                value: value,
                                valueColor: state == 'none'
                                    ? Theme.of(ctx).colorScheme.error
                                    : warn,
                              );
                      }),
                      if (log.isNotEmpty) ...[
                        const SizedBox(height: 10),
                        for (final raw in log.reversed.take(5))
                          _LogLine(raw: raw as Map),
                      ],
                    ])),
          ]);
        }),
        const SizedBox(height: 20),
        _Section(
            title: '允许名单',
            storageKey: 'qq.allow',
            anchor: 'qq.whitelist',
            initiallyExpanded: true,
            children: [
              Row(children: [
                _GhostButton(
                    label: _picking ? '读取中…' : '从 QQ 选择',
                    onTap: _picking ? null : () => _pickTargets(data)),
                const SizedBox(width: 8),
                Text('读已加入的群和好友，勾选即可',
                    style: TextStyle(
                        fontSize: 12, color: _text.withValues(alpha: 0.4))),
                const Spacer(),
                Builder(builder: (_) {
                  final all = _chatMaps(data);
                  final g = all.where(_isGroupKey).length;
                  final f = all.length - g;
                  return Text(g.toString() + ' 个群 / ' + f.toString() + ' 个好友',
                      style: TextStyle(fontSize: 12, color: _muted));
                }),
              ]),
              const SizedBox(height: 10),
              // 添加区：群 / 好友两组分开。别塞进同一个输入框——两边校验规则
              // 和 chatKey 前缀都不一样，混着放必然写出「群号写成 private:」这种错。
              _addRow(context,
                  label: '群聊',
                  idCtl: _groupCtl,
                  idHint: '群号（5–12 位数字）',
                  nameCtl: _groupNameCtl,
                  nameHint: '群名（可选）',
                  focusNode: _groupFocus,
                  onAdd: () => _addGroupChat(data)),
              const SizedBox(height: 8),
              _addRow(context,
                  label: '好友',
                  idCtl: _friendCtl,
                  idHint: 'QQ 号（5–12 位数字）',
                  nameCtl: _friendNameCtl,
                  nameHint: '备注（可选）',
                  focusNode: null,
                  onAdd: () => _addFriendChat(data)),
              const SizedBox(height: 10),
              Row(children: [
                Text('全局开口档位', style: TextStyle(fontSize: 12, color: _muted)),
                const SizedBox(width: 10),
                _GlassDropdown(
                  value: (config['groupReplyMode'] ?? 'active').toString(),
                  items: const [
                    ['shy', '社恐'],
                    ['quiet', '安静'],
                    ['normal', '正常'],
                    ['active', '活跃'],
                    ['frenzy', '狂热']
                  ],
                  onChanged: _setMode,
                ),
              ]),
              const SizedBox(height: 8),
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(children: [
                  Icon(Icons.lock_outline, size: 13, color: _muted),
                  const SizedBox(width: 6),
                  // 规则归规则：主人私聊本来就不用加白名单，这句留着。
                  Expanded(
                      child: Text(
                          kIsWeb
                              ? '主人私聊由 QQ 桥直连，不用加白名单'
                              : '主人私聊不用加白名单；白名单写在本机配置',
                          style: TextStyle(fontSize: 11, color: _muted))),
                  // 入口归入口：它单独一个可点控件，Tab 能聚焦、Enter/空格能触发。
                  // 不把它塞进上面那句正文里做“蓝字装饰”——那既看不出能点、键盘也摸不到。
                  if (kIsWeb) _goBindOwnerButton(),
                ]),
              ),
              Builder(builder: (_) {
                final all = _chatMaps(data);
                if (all.isEmpty)
                  return Text('还没有授权任何群或好友。',
                      style: TextStyle(fontSize: 12, color: _muted));
                final groups = all.where(_isGroupKey).toList();
                final friends = all.where((e) => !_isGroupKey(e)).toList();
                // 两段分开列：群聊一组、好友一组，各自有计数。
                // 混在一排会分不清 group: 和 private:，也没法一眼看出各有多少。
                return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (groups.isNotEmpty) ...[
                        _groupHeader('群聊', groups.length),
                        for (final m in groups)
                          _localChatRow(context, data, m,
                              (config['groupReplyMode'] ?? 'active').toString()),
                      ],
                      if (friends.isNotEmpty) ...[
                        if (groups.isNotEmpty) const SizedBox(height: 6),
                        _groupHeader('好友', friends.length),
                        for (final m in friends)
                          _localChatRow(context, data, m,
                              (config['groupReplyMode'] ?? 'active').toString()),
                      ],
                    ]);
              }),
            ]),
        _Section(
            title: '能力开关',
            storageKey: 'qq.caps',
            initiallyExpanded: true,
            children: [
              LayoutBuilder(builder: (_, box) {
                final w = (box.maxWidth - 12) / 2;
                return Wrap(spacing: 12, runSpacing: 12, children: [
                  for (final g in _capGroups)
                    SizedBox(
                        width: w,
                        child: _CapGroup(
                          title: g[0],
                          fields: [
                            for (final f in qq.fields)
                              if (g[1].split(',').contains(f.key)) f
                          ],
                          buildRow: _fieldRow,
                          extra: g[0] == '空间与外发' && _config != null
                              ? [
                                  for (final e in const [
                                    ['postsPerDay', '发动态 / 日记', '次'],
                                    ['likesPerDay', '点赞', '次'],
                                    ['commentsPerDay', '评论', '次'],
                                    ['repliesPerDay', '回复', '次']
                                  ])
                                    _NumField(
                                        title: e[1],
                                        hint: '',
                                        value: ((_config!['qzone']
                                                    as Map?)?[e[0]] as num?)
                                                ?.toDouble() ??
                                            0,
                                        min: 0,
                                        max: 100,
                                        unit: e[2],
                                        onSave: (v) => _saveQzone(e[0], v)),
                                ]
                              : const [],
                        )),
                ]);
              }),
            ]),
      ]),
    );
  }

  /// chatKey 前缀就是类型真源：`group:` = 群，`private:` = 好友。
  /// 不另存 type 字段——存了就有两份真源，早晚对不上。
  static bool _isGroupKey(Map<String, Object?> m) =>
      (m['chatKey'] ?? '').toString().startsWith('group:');

  /// 添加区的一行：类型标签 + 号 + 名 + 添加按钮。
  Widget _addRow(
    BuildContext context, {
    required String label,
    required TextEditingController idCtl,
    required String idHint,
    required TextEditingController nameCtl,
    required String nameHint,
    required FocusNode? focusNode,
    required VoidCallback onAdd,
  }) {
    return Row(children: [
      SizedBox(
          width: 40,
          child: Text(label,
              style: TextStyle(fontSize: 12, color: _text.withValues(alpha: 0.55)))),
      Expanded(
          child: _SmallField(
              controller: idCtl, hint: idHint, focusNode: focusNode)),
      const SizedBox(width: 8),
      Expanded(child: _SmallField(controller: nameCtl, hint: nameHint)),
      const SizedBox(width: 8),
      _GhostButton(label: '添加', onTap: onAdd),
    ]);
  }

  /// 分组小标题：类型 + 条数，和列表条目同一套用词（群 / 好友）。
  Widget _groupHeader(String label, int count) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6, top: 2),
      child: Row(children: [
        Text(label,
            style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w600,
                color: _text.withValues(alpha: 0.55))),
        const SizedBox(width: 6),
        Text(count.toString(),
            style: TextStyle(fontSize: 11, color: _muted)),
      ]),
    );
  }

  Widget _localChatRow(BuildContext context, FishSnapshot data,
      Map<String, Object?> m, String globalMode) {
    final key = (m['chatKey'] ?? '').toString();
    final name = (m['name'] ?? '').toString();
    final on = m['enabled'] != false;
    final mode = (m['mode'] ?? '').toString();
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
      decoration: BoxDecoration(
          color: _card,
          borderRadius: BorderRadius.circular(9),
          border: Border.all(color: _line)),
      child: Row(children: [
        // 类型徽标：一眼分清群和好友（之前两种 chatKey 混在一排看不出来）。
        Builder(builder: (_) {
          final isGroup = _isGroupKey(m);
          final tone = isGroup ? _positive : _text.withValues(alpha: 0.55);
          return Container(
            margin: const EdgeInsets.only(right: 10),
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            decoration: BoxDecoration(
                color: tone.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(5)),
            child: Text(isGroup ? '群' : '好友',
                style: TextStyle(fontSize: 10, color: tone)),
          );
        }),
        Expanded(
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(name.isEmpty
                    ? (_isGroupKey(m) ? '群 ' : '好友 ') +
                        key.substring(key.indexOf(':') + 1)
                    : (_isGroupKey(m) ? '群 · ' : '好友 · ') + name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 13, color: _text)),
            const SizedBox(height: 2),
            // 小字给号码本身：群号 / QQ 号，别把 chatKey 原样糊上去。
            Text((_isGroupKey(m) ? '群号 ' : 'QQ ') + key.substring(key.indexOf(':') + 1),
                style: TextStyle(fontSize: 11, color: _muted)),
          ]),
        ),
        FishSwitch(value: on, onChanged: (v) => _toggleLocalChat(data, key, v)),
        const SizedBox(width: 10),
        _GlassDropdown(
          value: mode.isEmpty ? '' : mode,
          items: [
            ['', '跟随全局'],
            for (final e in _modeLabels.entries) [e.key, e.value],
          ],
          onChanged: (v) => _setLocalChatMode(data, key, v),
        ),
        IconButton(
          tooltip: '移除',
          visualDensity: VisualDensity.compact,
          icon: Icon(Icons.delete_outline, size: 15, color: _muted),
          onPressed: () => _removeLocalChat(data, key),
        ),
      ]),
    );
  }

  Future<void> _toggleLocalChat(FishSnapshot data, String key, bool v) async {
    final list = _chatMaps(data);
    for (final m in list) {
      if (m['chatKey'] == key) m['enabled'] = v;
    }
    await _saveChats(data, list);
  }

  Future<void> _setLocalChatMode(
      FishSnapshot data, String key, String mode) async {
    final list = _chatMaps(data);
    for (final m in list) {
      if (m['chatKey'] == key) m['mode'] = mode;
    }
    await _saveChats(data, list);
  }

  Future<void> _removeLocalChat(FishSnapshot data, String key) async {
    final list = _chatMaps(data)..removeWhere((e) => e['chatKey'] == key);
    await _saveChats(data, list);
  }

  Widget _biliCard(FishSnapshot data) {
    final bili = data.bili;
    return _BigCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _CardHead(
            title: '鱼与 B站',
            running: bili.enabled,
            runningLabel: bili.statusLabel,
            onRefresh: () => setState(() => _future = FishWorld.reload())),
        const SizedBox(height: 24),
        Padding(
          padding: EdgeInsets.only(bottom: 12),
          child: Text('账号信息',
              style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: _muted,
                  letterSpacing: 0.2)),
        ),
        _BiliAccount(
          name: bili.accountName,
          mid: bili.accountMid,
          ownerName: bili.ownerName,
          ownerMid: bili.ownerMid,
        ),
        const SizedBox(height: 24),
        _Section(
            title: '状态',
            storageKey: 'bili.status',
            initiallyExpanded: true,
            children: [
              _PropertyRow(
                  label: '平台插件', value: bili.installed ? '已安装' : '未安装'),
              _PropertyRow(label: '能力开关', value: bili.enabled ? '已启用' : '未启用'),
              _PropertyRow(
                  label: '已开 / 总数',
                  value: bili.enabledCount.toString() +
                      ' / ' +
                      bili.fieldsTotal.toString()),
            ]),
        const SizedBox(height: 20),
        _Section(title: '能力开关', storageKey: 'bili.caps', children: [
          Align(
            alignment: Alignment.centerLeft,
            child: SizedBox(
              width: 680,
              child: Column(children: [
                for (final field in bili.fields) _fieldRow(field, bili: true),
              ]),
            ),
          ),
        ]),
      ]),
    );
  }

  Widget _forwardSection(BuildContext context) {
    return FutureBuilder<Map<String, dynamic>?>(
      future: bridgeQqInbox(),
      builder: (ctx, snap) {
        final r = snap.data;
        final list =
            (r == null ? const [] : ((r['messages'] as List?) ?? const []));
        final items = [
          for (final e in list)
            if (e is Map) Map<String, dynamic>.from(e)
        ];
        if (items.isEmpty) return const SizedBox.shrink();
        return _Section(
            title: '最近消息',
            storageKey: 'qq.inbox',
            initiallyExpanded: true,
            children: [
              for (final m in items) _inboxRow(context, m),
            ]);
      },
    );
  }

  Widget _inboxRow(BuildContext context, Map<String, dynamic> m) {
    final text = (m['text'] ?? m['title'] ?? m['summary'] ?? '').toString();
    final fid = (m['forwardId'] ??
            (m['type'] == 'forward' || m['kind'] == 'forward'
                ? (m['id'] ?? '')
                : ''))
        .toString();
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(children: [
        Icon(fid.isNotEmpty ? Icons.forum_outlined : Icons.chat_bubble_outline,
            size: 15, color: _muted),
        const SizedBox(width: 8),
        Expanded(
            child: Text(text.isEmpty ? '聊天记录' : text,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 13, color: _text))),
        if (fid.isNotEmpty)
          TextButton(
              onPressed: () => _showForward(fid), child: const Text('展开')),
      ]),
    );
  }

  String _forwardLine(Object? e) {
    if (e is Map) {
      final sender = (e['sender'] ?? e['name'] ?? '').toString();
      final text = (e['text'] ?? e['content'] ?? '').toString();
      return sender.isEmpty ? text : sender + '：' + text;
    }
    return e.toString();
  }

  Future<void> _showForward(String id) async {
    final r = await bridgeQqForward(id);
    if (!mounted) return;
    final ok = r != null && r['ok'] == true;
    final rows = ok
        ? ((r['messages'] as List?) ?? (r['items'] as List?) ?? const [])
        : const [];
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('聊天记录'),
        content: SizedBox(
          width: 520,
          height: 360,
          child: ok
              ? (rows.isEmpty
                  ? FishEmpty(text: '这条转发里没有可显示的消息')
                  : ListView(children: [
                      for (final e in rows)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 10),
                          child: Text(
                            _forwardLine(e),
                            style: const TextStyle(fontSize: 13, height: 1.6),
                          ),
                        ),
                    ]))
              : FishStatusAction(
                  status: FishStatusKind.error,
                  message: '展开失败：' +
                      (r == null
                          ? '没连上主程序'
                          : (r['error'] ?? '未知错误').toString()),
                  action: FishAction(
                      label: '重试',
                      kind: FishActionKind.retry,
                      handler: () {
                        Navigator.pop(ctx);
                        _showForward(id);
                      }),
                ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx), child: const Text('关闭'))
        ],
      ),
    );
  }

  Widget _rulesCard() {
    return _BigCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const _CardHead(title: '规则', running: true, runningLabel: '可写'),
        const SizedBox(height: 24),
        for (final line in const [
          'QQ / B站默认不启用，打开后鱼才参与；本页的开关直接写回后端并回读校验。',
          '外发动作单独开门：发送消息、空间动态、被戳回应都是独立开关。',
          '改动即时保存到本机配置；失败会在上方给红字，并可点「重试」。',
        ])
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Padding(
                  padding: EdgeInsets.only(top: 5),
                  child: Icon(Icons.circle, size: 5, color: _muted)),
              const SizedBox(width: 10),
              Expanded(
                  child: Text(line,
                      style:
                          TextStyle(fontSize: 13, height: 1.7, color: _text))),
            ]),
          ),
      ]),
    );
  }

  Widget _skeleton() => ColoredBox(
        color: _canvas,
        child: Center(
            child: SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(strokeWidth: 2))),
      );

  Widget _empty(String text) => ColoredBox(
        color: _canvas,
        child: Center(
            child: Text(text, style: TextStyle(fontSize: 13, color: _muted))),
      );
}

/// 从 QQ 选择：先开弹层，再异步读数据；读失败在弹层内重试。
class QqPickTargetsDialog extends StatefulWidget {
  final Map<String, Map<String, Object?>> existing;
  final Map<String, dynamic>? debugTargets;
  const QqPickTargetsDialog({required this.existing, this.debugTargets});

  @override
  State<QqPickTargetsDialog> createState() => QqPickTargetsDialogState();
}

class QqPickTargetsDialogState extends State<QqPickTargetsDialog> {
  bool _loading = true;
  String _error = '';
  List<Map<String, dynamic>> _groups = const [];
  List<Map<String, dynamic>> _friends = const [];
  final Set<String> _selected = <String>{};

  @override
  void initState() {
    super.initState();
    _selected.addAll(widget.existing.keys);
    final debug = widget.debugTargets;
    if (debug != null) {
      _loading = false;
      _groups = ((debug['groups'] as List?) ?? const [])
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      _friends = ((debug['friends'] as List?) ?? const [])
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
    } else {
      _load();
    }
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = '';
    });
    final r = await qqGateway.listTargets();
    if (!mounted) return;
    if (r == null) {
      setState(() {
        _loading = false;
        _error = '没连上 QQ 桥，读不到群和好友';
      });
      return;
    }
    final groups = ((r['groups'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .toList();
    final friends = ((r['friends'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .toList();
    final errors = (r['errors'] as Map?) ?? const {};
    final top = r['ok'] == false ? (r['error'] ?? '读取失败').toString() : '';
    setState(() {
      _groups = groups;
      _friends = friends;
      _loading = false;
      _error = [
        top,
        (errors['groups'] ?? '').toString(),
        (errors['friends'] ?? '').toString()
      ].where((x) => x.isNotEmpty).map((x) => '读取失败：' + x).join('；');
    });
  }

  Widget _skeletonRow() => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Container(
          height: 38,
          decoration: BoxDecoration(
              color: _text.withValues(alpha: 0.06),
              borderRadius: BorderRadius.circular(8)),
        ),
      );

  Widget _item(String key, String title, String sub) => CheckboxListTile(
        dense: true,
        contentPadding: EdgeInsets.zero,
        controlAffinity: ListTileControlAffinity.leading,
        activeColor: _positive,
        checkColor: _text,
        value: _selected.contains(key),
        onChanged: (v) => setState(() {
          if (v == true) {
            _selected.add(key);
          } else {
            _selected.remove(key);
          }
        }),
        title: Text(title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 13, color: _text)),
        subtitle: Text(sub,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style:
                TextStyle(fontSize: 11, color: _text.withValues(alpha: 0.4))),
      );

  /// 只清 / 只选某一段：两段各自独立，互不牵连。
  void _selectAllIn(Iterable<String> keys) => setState(() => _selected.addAll(keys));

  void _clearIn(Iterable<String> keys) => setState(() => _selected.removeAll(keys));

  /// 一段的标题行：标题 + 「已选 x/y」+ 全选 / 全不选。
  Widget _sectionHeader(String label, List<String> keys) {
    final picked = keys.where(_selected.contains).length;
    return Padding(
      padding: const EdgeInsets.only(top: 4, bottom: 2),
      child: Row(children: [
        Text(label,
            style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                color: _text.withValues(alpha: 0.55))),
        const SizedBox(width: 6),
        Text(picked.toString() + '/' + keys.length.toString(),
            style: TextStyle(fontSize: 11, color: _muted)),
        const Spacer(),
        TextButton(
            onPressed: keys.isEmpty ? null : () => _selectAllIn(keys),
            style: TextButton.styleFrom(
                minimumSize: const Size(0, 26),
                padding: const EdgeInsets.symmetric(horizontal: 6),
                visualDensity: VisualDensity.compact),
            child: Text('全选', style: TextStyle(fontSize: 11, color: _muted))),
        TextButton(
            onPressed: keys.isEmpty ? null : () => _clearIn(keys),
            style: TextButton.styleFrom(
                minimumSize: const Size(0, 26),
                padding: const EdgeInsets.symmetric(horizontal: 6),
                visualDensity: VisualDensity.compact),
            child: Text('反选', style: TextStyle(fontSize: 11, color: _muted))),
      ]),
    );
  }

  List<Map<String, Object?>> _picked() {
    final list = <Map<String, Object?>>[];
    for (final key in _selected) {
      final old = widget.existing[key];
      if (old != null) {
        list.add(Map<String, Object?>.from(old));
        continue;
      }
      if (key.startsWith('group:')) {
        final g = _groups.firstWhere(
            (e) => 'group:' + (e['id'] ?? '').toString() == key,
            orElse: () => const {});
        list.add({
          'chatKey': key,
          'name': (g['name'] ?? '').toString(),
          'sessionId': '',
          'enabled': true
        });
      } else if (key.startsWith('private:')) {
        final f = _friends.firstWhere(
            (e) => 'private:' + (e['id'] ?? '').toString() == key,
            orElse: () => const {});
        list.add({
          'chatKey': key,
          'name': (f['name'] ?? '').toString(),
          'sessionId': '',
          'enabled': true
        });
      }
    }
    return list;
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    return Dialog(
      backgroundColor: _card,
      insetPadding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
      shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(14),
          side: BorderSide(color: _line)),
      child: ShrinkToFit(
        maxHeightFactor: 0.70,
        child: SizedBox(
          width: 560,
          height: size.height * 0.70,
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 18, 12, 8),
              child: Row(children: [
                Text('从 QQ 选择',
                    style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                        color: _text)),
                const SizedBox(width: 8),
                Text('已选 ' + _selected.length.toString(),
                    style: TextStyle(
                        fontSize: 12, color: _text.withValues(alpha: 0.4))),
                const Spacer(),
                IconButton(
                    onPressed: () => Navigator.pop(context),
                    icon: Icon(Icons.close, size: 18, color: _muted)),
              ]),
            ),
            Expanded(
              child: _loading
                  ? Padding(
                      padding: const EdgeInsets.fromLTRB(20, 6, 20, 12),
                      child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('正在读取群和好友…',
                                style: TextStyle(fontSize: 12, color: _muted)),
                            const SizedBox(height: 14),
                            for (var i = 0; i < 5; i++) _skeletonRow(),
                          ]),
                    )
                  : _error.isNotEmpty
                      ? Padding(
                          padding: const EdgeInsets.fromLTRB(20, 6, 20, 12),
                          child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                _SoftError(text: _error, padded: false),
                                const SizedBox(height: 12),
                                _GhostButton(label: '重试', onTap: _load),
                              ]),
                        )
                      : Builder(builder: (_) {
                          final groupKeys = [
                            for (final g in _groups)
                              'group:' + (g['id'] ?? '').toString()
                          ];
                          final friendKeys = [
                            for (final f in _friends)
                              'private:' + (f['id'] ?? '').toString()
                          ];
                          // 读不到好友要单独说，不能和群混成一句「没读到」——
                          // 群可能读到了、只坏好友，混着说会让人以为全坏了。
                          final friendsMissing = _friends.isEmpty &&
                              _groups.isNotEmpty;
                          final groupsMissing = _groups.isEmpty &&
                              _friends.isEmpty;
                          return ListView(
                            padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
                            children: [
                              if (groupsMissing)
                                Padding(
                                  padding:
                                      const EdgeInsets.symmetric(vertical: 12),
                                  child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Text('没读到群聊或好友。确认协议端已启动、OneBot 地址对得上。',
                                            style: TextStyle(
                                                fontSize: 12,
                                                height: 1.6,
                                                color: _muted)),
                                        const SizedBox(height: 8),
                                        _GhostButton(label: '重试', onTap: _load),
                                      ]),
                                ),
                              if (_groups.isNotEmpty) ...[
                                _sectionHeader('群聊', groupKeys),
                                for (final g in _groups)
                                  _item(
                                      'group:' + (g['id'] ?? '').toString(),
                                      (g['name'] ?? '').toString().isEmpty
                                          ? (g['id'] ?? '').toString()
                                          : (g['name'] ?? '').toString(),
                                      '群 ' +
                                          (g['id'] ?? '').toString() +
                                          ((g['members'] ?? 0) as num > 0
                                              ? ' · ' +
                                                  (g['members'] ?? 0).toString() +
                                                  ' 人'
                                              : '')),
                              ],
                              if (_friends.isNotEmpty) ...[
                                const SizedBox(height: 10),
                                _sectionHeader('好友', friendKeys),
                                for (final f in _friends)
                                  _item(
                                      'private:' + (f['id'] ?? '').toString(),
                                      (f['name'] ?? '').toString().isEmpty
                                          ? (f['id'] ?? '').toString()
                                          : (f['name'] ?? '').toString(),
                                      'QQ ' + (f['id'] ?? '').toString()),
                              ],
                              if (friendsMissing)
                                Padding(
                                  padding: const EdgeInsets.only(top: 12),
                                  child: Row(children: [
                                    Icon(Icons.info_outline,
                                        size: 14, color: _muted),
                                    const SizedBox(width: 6),
                                    Expanded(
                                        child: Text(
                                            '好友没读到（群读到了）。可能协议端只给了群列表，或好友接口超时。',
                                            style: TextStyle(
                                                fontSize: 11,
                                                height: 1.5,
                                                color: _muted))),
                                    TextButton(
                                        onPressed: _load,
                                        style: TextButton.styleFrom(
                                            minimumSize: const Size(0, 26),
                                            padding: const EdgeInsets
                                                .symmetric(horizontal: 6),
                                            visualDensity:
                                                VisualDensity.compact),
                                        child: Text('重试',
                                            style: TextStyle(
                                                fontSize: 11, color: _muted))),
                                  ]),
                                ),
                            ],
                          );
                        }),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 18),
              child: Row(children: [
                Text('已选 ' + _selected.length.toString() + ' 项',
                    style: TextStyle(fontSize: 12, color: _muted)),
                const SizedBox(width: 10),
                TextButton(
                    onPressed: _loading
                        ? null
                        : () => setState(() => _selected.clear()),
                    child: Text('全部清空',
                        style: TextStyle(fontSize: 12, color: _muted))),
                const Spacer(),
                _GhostButton(label: '取消', onTap: () => Navigator.pop(context)),
                const SizedBox(width: 8),
                _PrimaryButton(
                    label: '保存选择',
                    onTap: _loading || _error.isNotEmpty
                        ? null
                        : () => Navigator.pop(context, _picked())),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}

class _BigCard extends StatelessWidget {
  final Widget child;
  const _BigCard({required this.child});
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(24),
        decoration: BoxDecoration(
          color: _card,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: _line),
        ),
        child: child,
      );
}

class _Segmented extends StatelessWidget {
  final int value;
  final ValueChanged<int> onChanged;
  const _Segmented({required this.value, required this.onChanged});
  @override
  Widget build(BuildContext context) {
    const labels = ['QQ', 'B站', '规则'];
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: _text.withValues(alpha: 0.03),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: _text.withValues(alpha: 0.08)),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        for (var i = 0; i < labels.length; i++)
          MouseRegion(
            cursor: SystemMouseCursors.click,
            child: GestureDetector(
              onTap: () => onChanged(i),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 160),
                padding:
                    const EdgeInsets.symmetric(horizontal: 18, vertical: 7),
                decoration: BoxDecoration(
                  color: value == i
                      ? _text.withValues(alpha: 0.12)
                      : Colors.transparent,
                  borderRadius: BorderRadius.circular(7),
                  border: Border.all(
                      color: value == i
                          ? _text.withValues(alpha: 0.10)
                          : Colors.transparent),
                ),
                child: Text(labels[i],
                    style: TextStyle(
                        fontSize: 12,
                        fontWeight:
                            value == i ? FontWeight.w600 : FontWeight.w500,
                        color: value == i
                            ? _text
                            : _text.withValues(alpha: 0.62))),
              ),
            ),
          ),
      ]),
    );
  }
}

class _CardHead extends StatelessWidget {
  final String title;
  final bool running;
  final bool? statusOk;
  final String runningLabel;
  final VoidCallback? onRefresh;
  final VoidCallback? onToggle;
  const _CardHead(
      {required this.title,
      required this.running,
      this.statusOk,
      required this.runningLabel,
      this.onRefresh,
      this.onToggle});
  @override
  Widget build(BuildContext context) {
    final ok = statusOk ?? running;
    final color = ok ? _positive : (running ? _error : _line);
    return Row(children: [
      Text(title,
          style: TextStyle(
              fontSize: 16, fontWeight: FontWeight.w600, color: _text)),
      if (runningLabel.isNotEmpty) ...[
        const SizedBox(width: 8),
        Container(
          width: 7,
          height: 7,
          decoration: BoxDecoration(
            color: color,
            shape: BoxShape.circle,
            boxShadow: ok
                ? [
                    BoxShadow(
                        color: _positive.withValues(alpha: 0.45), blurRadius: 6)
                  ]
                : null,
          ),
        ),
        const SizedBox(width: 6),
        Text(runningLabel,
            style: TextStyle(
                fontSize: 12,
                color: ok ? _positive : (running ? _error : _muted))),
      ],
      const Spacer(),
      if (onToggle != null)
        _GhostButton(label: running ? '停止接收' : '开始接收', onTap: onToggle),
      if (onRefresh != null)
        IconButton(
            onPressed: onRefresh,
            icon: Icon(Icons.refresh, size: 17, color: _muted)),
    ]);
  }
}

class _Section extends StatefulWidget {
  final String title;
  final String storageKey;
  final String anchor;
  final bool initiallyExpanded;
  final List<Widget> children;
  const _Section(
      {required this.title,
      this.storageKey = '',
      this.anchor = '',
      this.initiallyExpanded = false,
      required this.children});

  @override
  State<_Section> createState() => _SectionState();
}

class _SectionState extends State<_Section> {
  late bool _open = _readOpen();

  bool _readOpen() {
    if (widget.storageKey.isEmpty) return widget.initiallyExpanded;
    final raw = UiStore.get('fw.section.' + widget.storageKey);
    if (raw == '1') return true;
    if (raw == '0') return false;
    return widget.initiallyExpanded;
  }

  void _toggle() {
    setState(() => _open = !_open);
    if (widget.storageKey.isNotEmpty) {
      UiStore.set('fw.section.' + widget.storageKey, _open ? '1' : '0');
    }
  }

  @override
  Widget build(BuildContext context) {
    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        InkWell(
          borderRadius: BorderRadius.circular(6),
          onTap: _toggle,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Row(children: [
              Text(widget.title,
                  style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: _muted,
                      letterSpacing: 0.2)),
              const Spacer(),
              AnimatedRotation(
                turns: _open ? 0.5 : 0,
                duration: const Duration(milliseconds: 160),
                child: Icon(Icons.keyboard_arrow_down, size: 16, color: _muted),
              ),
            ]),
          ),
        ),
        AnimatedSize(
          duration: const Duration(milliseconds: 180),
          curve: Curves.easeOut,
          alignment: Alignment.topCenter,
          child: _open
              ? Padding(
                  padding: const EdgeInsets.only(top: 18),
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: widget.children),
                )
              : const SizedBox(width: double.infinity),
        ),
      ],
    );
    if (widget.anchor.isEmpty) return body;
    return FishAnchor(anchor: widget.anchor, child: body);
  }
}

class _PreviewBanner extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(
        color: _card,
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: _line),
      ),
      child: Row(children: [
        Icon(Icons.info_outline, size: 14, color: _muted),
        const SizedBox(width: 7),
        Expanded(
            child: Text('当前是本地预览，协议端 / 桥功能不可用。要看真实状态请打开 DSH 桌面端。',
                style: TextStyle(fontSize: 12, color: _muted))),
      ]),
    );
  }
}

class _QqAvatar extends StatelessWidget {
  final String userId;
  final String initial;
  const _QqAvatar({required this.userId, required this.initial});

  @override
  Widget build(BuildContext context) {
    // 三级降级：真实头像 → 首字圆形 → 人形图标；全程安静，不弹提示、不裂图。
    if (userId.isEmpty) return _fallbackIcon();
    return ClipOval(
      child: Image.network(
        'https://q1.qlogo.cn/g?b=qq&nk=' + userId + '&s=100',
        width: 42,
        height: 42,
        fit: BoxFit.cover,
        gaplessPlayback: true,
        // Web 上 CanvasKit 走 fetch，QQ CDN 没有 CORS 头 → 内建 <img> 兜底，桌面端不受影响。
        webHtmlElementStrategy: WebHtmlElementStrategy.fallback,
        errorBuilder: (_, __, ___) => _fallbackInitial(),
      ),
    );
  }

  Widget _fallbackInitial() {
    if (initial.isEmpty) return _fallbackIcon();
    return Container(
      width: 42,
      height: 42,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: _card,
        shape: BoxShape.circle,
        border: Border.all(color: _text.withValues(alpha: 0.10)),
      ),
      child: Text(initial,
          style: TextStyle(
              fontSize: 16, fontWeight: FontWeight.w600, color: _text)),
    );
  }

  Widget _fallbackIcon() => Container(
        width: 42,
        height: 42,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: _card,
          shape: BoxShape.circle,
          border: Border.all(color: _text.withValues(alpha: 0.10)),
        ),
        child: Icon(Icons.person_outline, size: 19, color: _muted),
      );
}

/// 一个显式的入口按钮：点/键盘都到「鱼的设定 → 主人绑定卡」。
/// 用 TextButton 而不是「正文里的蓝字」——可聚焦、有焦点框、有 hover，摸得到。
Widget _goBindOwnerButton() => Builder(
      builder: (ctx) {
        final scheme = Theme.of(ctx).colorScheme;
        void go() => FishNav.focus(NavRoute.profile, 'pf-owner', field: 'pf-owner-qq');
        return Tooltip(
          message: '去「鱼的设定」绑主人会话',
          child: TextButton.icon(
            onPressed: go,
            icon: Icon(Icons.arrow_forward, size: 13, color: scheme.primary),
            label: Text('去绑主人会话',
                style: TextStyle(fontSize: 11, color: scheme.primary)),
            style: TextButton.styleFrom(
              minimumSize: const Size(0, 26),
              padding: const EdgeInsets.symmetric(horizontal: 6),
              visualDensity: VisualDensity.compact,
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
          ),
        );
      },
    );

class _QqHeader extends StatelessWidget {
  final Map<String, dynamic>? live;
  final bool connected;
  final bool running;
  final String nickname;
  final bool busy;
  final bool starting;
  final int todayReceive;
  final int todaySend;
  final int todayGroups;
  final String heartbeat;
  final VoidCallback? onRetry;
  final VoidCallback? onToggle;
  final VoidCallback? onStart;
  final VoidCallback? onOpenLogin;
  final VoidCallback? onStopProtocol;
  final VoidCallback? onRestartProtocol;
  final bool protoRunning;
  final String webui;
  const _QqHeader(
      {required this.live,
      required this.connected,
      required this.running,
      required this.nickname,
      required this.busy,
      required this.starting,
      required this.todayReceive,
      required this.todaySend,
      required this.todayGroups,
      required this.heartbeat,
      this.onRetry,
      this.onToggle,
      this.onStart,
      this.onOpenLogin,
      this.onStopProtocol,
      this.onRestartProtocol,
      this.protoRunning = false,
      this.webui = 'http://127.0.0.1:5099'});

  @override
  Widget build(BuildContext context) {
    final raw = live?['login'];
    final login = raw is Map ? raw : null;
    final userId = (login?['userId'] ?? '').toString();
    final desktop = !kIsWeb;
    String state;
    Color tone;
    Widget action = const SizedBox.shrink();
    if (live == null) {
      state = desktop ? '协议端未启动' : '没连上主程序（未测）';
      tone = _muted;
      action = FishActionButton(
          action: FishAction(
              label: '重试',
              kind: FishActionKind.retry,
              handler: onRetry ?? () {}));
    } else if (!connected && protoRunning) {
      state = desktop ? '已启动未登录' : '协议端已启动 · 未登录';
      tone = _error;
      action = Row(mainAxisSize: MainAxisSize.min, children: [
        FishActionButton(
            action: FishAction(
                label: desktop ? '去登录（5099）' : '打开登录页',
                kind: FishActionKind.openUrl,
                handler: onOpenLogin ?? () {})),
        if (!desktop) ...[
          const SizedBox(width: 6),
          FishActionButton(
              action: FishAction(
                  label: '结束并重启',
                  kind: FishActionKind.launch,
                  handler: onRestartProtocol ?? () {})),
        ],
      ]);
    } else if (!connected) {
      state = desktop ? '协议端未启动' : '协议端没启动';
      tone = _error;
      action = Row(mainAxisSize: MainAxisSize.min, children: [
        FishActionButton(
            action: FishAction(
                label: starting ? '正在启动…' : '启动协议端',
                kind: FishActionKind.launch,
                handler: starting ? () {} : (onStart ?? () {}))),
        if (desktop) ...[
          const SizedBox(width: 6),
          FishActionButton(
              action: FishAction(
                  label: '打开登录页',
                  kind: FishActionKind.openUrl,
                  handler: onOpenLogin ?? () {})),
        ] else ...[
          const SizedBox(width: 6),
          FishActionButton(
              action: FishAction(
                  label: '结束并重启',
                  kind: FishActionKind.launch,
                  handler: onRestartProtocol ?? () {})),
        ],
      ]);
    } else if (!running) {
      state = desktop ? '已登录' : '接收关着';
      tone = _muted;
      action = FishActionButton(
          action: FishAction(
              label: '开始接收',
              kind: FishActionKind.launch,
              handler: busy ? () {} : (onToggle ?? () {})));
    } else {
      state = '收发中';
      tone = _success;
      action = FishActionButton(
          action: FishAction(
              label: '停止接收',
              kind: FishActionKind.launch,
              handler: onToggle ?? () {}));
    }
    final name =
        nickname.isEmpty ? (userId.isEmpty ? '未登录' : userId) : nickname;
    return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _QqAvatar(
          userId: connected ? userId : '',
          initial: name.isNotEmpty ? name.substring(0, 1) : ''),
      const SizedBox(width: 12),
      Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text.rich(TextSpan(children: [
            WidgetSpan(
                alignment: PlaceholderAlignment.middle,
                child: Container(
                    width: 7,
                    height: 7,
                    margin: const EdgeInsets.only(right: 6),
                    decoration:
                        BoxDecoration(color: tone, shape: BoxShape.circle))),
            TextSpan(
                text: connected ? state + ' · ' + name : state,
                style: TextStyle(
                    fontSize: 14, fontWeight: FontWeight.w600, color: _text)),
            if (userId.isNotEmpty)
              TextSpan(
                  text: '（QQ ' + userId + '）',
                  style: TextStyle(fontSize: 12, color: _muted)),
          ])),
          const SizedBox(height: 4),
          Text(
              '今日 ' +
                  todayReceive.toString() +
                  ' 收 / ' +
                  todaySend.toString() +
                  ' 发 · 活跃群 ' +
                  todayGroups.toString() +
                  ' · 心跳 ' +
                  heartbeat,
              style: TextStyle(
                  fontSize: 12,
                  color: _muted,
                  fontFeatures: const [FontFeature.tabularFigures()])),
        ]),
      ),
      Padding(padding: const EdgeInsets.only(left: 8, top: 2), child: action),
    ]);
  }
}

class _TodaySpark extends StatelessWidget {
  final List<int> hours;
  final int total;
  const _TodaySpark({required this.hours, required this.total});
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final peak = hours.isEmpty ? 0 : hours.reduce((a, b) => a > b ? a : b);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Text('今日动态',
            style: TextStyle(
                fontSize: 12, fontWeight: FontWeight.w600, color: _muted)),
        const SizedBox(width: 8),
        Text(total == 0 ? '今天还没收发' : total.toString() + ' 条 · 按小时',
            style: TextStyle(fontSize: 11, color: _muted)),
      ]),
      const SizedBox(height: 8),
      if (total == 0)
        Container(height: 2, color: scheme.onSurface.withValues(alpha: .12))
      else
        SizedBox(
          height: 30,
          child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            for (var i = 0; i < (hours.length >= 24 ? 24 : hours.length); i++)
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 1.5),
                  child: Container(
                    height: 3 + (peak == 0 ? 0 : (hours[i] / peak) * 24),
                    decoration: BoxDecoration(
                      color: hours[i] == 0
                          ? scheme.onSurface.withValues(alpha: .10)
                          : scheme.primary.withValues(alpha: .55),
                      borderRadius: BorderRadius.circular(1),
                    ),
                  ),
                ),
              ),
          ]),
        ),
    ]);
  }
}

class _CapGroup extends StatelessWidget {
  final String title;
  final List<FishField> fields;
  final Widget Function(FishField) buildRow;
  final List<Widget> extra;
  const _CapGroup(
      {required this.title,
      required this.fields,
      required this.buildRow,
      this.extra = const []});
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 6),
      decoration: BoxDecoration(
          color: _card,
          borderRadius: BorderRadius.circular(11),
          border: Border.all(color: _line)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title,
            style: TextStyle(
                fontSize: 12, fontWeight: FontWeight.w600, color: _text)),
        const SizedBox(height: 8),
        for (final f in fields) buildRow(f),
        ...extra,
      ]),
    );
  }
}

class _BiliAccount extends StatelessWidget {
  final String name;
  final String mid;
  final String ownerName;
  final String ownerMid;
  const _BiliAccount(
      {required this.name,
      required this.mid,
      required this.ownerName,
      required this.ownerMid});

  @override
  Widget build(BuildContext context) {
    final has = mid.isNotEmpty || name.isNotEmpty;
    final display = name.isNotEmpty ? name : (mid.isNotEmpty ? mid : '未登录');
    final owner = ownerName.isNotEmpty ? ownerName : ownerMid;
    return Row(children: [
      Container(
        width: 42,
        height: 42,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: _card,
          shape: BoxShape.circle,
          border: Border.all(color: _text.withValues(alpha: 0.10)),
        ),
        child: has
            ? Text(display.substring(0, 1),
                style: TextStyle(
                    fontSize: 16, fontWeight: FontWeight.w600, color: _text))
            : Icon(Icons.person_outline, size: 19, color: _muted),
      ),
      const SizedBox(width: 12),
      Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(display,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                  fontSize: 14, fontWeight: FontWeight.w600, color: _text)),
          const SizedBox(height: 3),
          Text(
            has ? 'UID ' + mid : '还没有读到 B站登录信息',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 12, color: _text.withValues(alpha: 0.4)),
          ),
          if (owner.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Text(
                  '主人 ' +
                      owner +
                      (ownerMid.isNotEmpty ? ' · UID ' + ownerMid : ''),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                      fontSize: 11, color: _text.withValues(alpha: 0.3))),
            ),
        ]),
      ),
      Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
        decoration: BoxDecoration(
          color: has
              ? _positive.withValues(alpha: 0.12)
              : _text.withValues(alpha: 0.05),
          borderRadius: BorderRadius.circular(999),
          border: Border.all(
              color: has
                  ? _positive.withValues(alpha: 0.30)
                  : _text.withValues(alpha: 0.10)),
        ),
        child: Text(has ? '已登录' : '未登录',
            style: TextStyle(fontSize: 11, color: has ? _positive : _muted)),
      ),
    ]);
  }
}

class _PropertyRow extends StatelessWidget {
  final String label;
  final String value;
  /// 可选：值用别的颜色（心跳停了之类的异常态）。
  final Color? valueColor;
  const _PropertyRow({required this.label, required this.value, this.valueColor});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 16),
        child: Row(children: [
          SizedBox(
              width: 120,
              child:
                  Text(label, style: TextStyle(fontSize: 12, color: _muted))),
          Expanded(
              child: Text(value,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 13, color: valueColor ?? _text))),
        ]),
      );
}

class _TargetSessionRow extends StatelessWidget {
  final String value;
  final String uuid;
  final ValueChanged<String> onCopy;
  const _TargetSessionRow(
      {required this.value, required this.uuid, required this.onCopy});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Row(children: [
        SizedBox(
            width: 120,
            child: Text('目标会话', style: TextStyle(fontSize: 12, color: _muted))),
        Expanded(
          child: FishTooltip(
            message: uuid.isEmpty ? '未设置目标会话' : uuid,
            child: Text(value,
                maxLines: 1,
                softWrap: false,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 13, color: _text)),
          ),
        ),
        const SizedBox(width: 8),
        InkWell(
          borderRadius: BorderRadius.circular(6),
          onTap: () => onCopy(uuid.isEmpty ? value : uuid),
          child: Padding(
            padding: EdgeInsets.all(5),
            child: Icon(Icons.copy, size: 15, color: _muted),
          ),
        ),
      ]),
    );
  }
}

class _LabeledField extends StatelessWidget {
  final String label;
  final TextEditingController controller;
  final String hint;
  final bool obscure;
  const _LabeledField(
      {required this.label,
      required this.controller,
      required this.hint,
      this.obscure = false});
  @override
  Widget build(BuildContext context) => Row(children: [
        SizedBox(
            width: 120,
            child: Text(label, style: TextStyle(fontSize: 12, color: _muted))),
        Expanded(
            child: SizedBox(
          height: 40,
          child: TextField(
            controller: controller,
            obscureText: obscure,
            style: TextStyle(fontSize: 13, color: _text),
            decoration: InputDecoration(
              isDense: true,
              hintText: hint,
              hintStyle:
                  TextStyle(fontSize: 12, color: _text.withValues(alpha: 0.35)),
              filled: true,
              fillColor: _card,
              border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: BorderSide(color: _line)),
              enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: BorderSide(color: _line)),
              focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: BorderSide(color: _text.withValues(alpha: 0.28))),
              contentPadding:
                  const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
            ),
          ),
        )),
      ]);
}

class _SmallField extends StatelessWidget {
  final TextEditingController controller;
  final String hint;
  final FocusNode? focusNode;
  const _SmallField(
      {required this.controller, required this.hint, this.focusNode});
  @override
  Widget build(BuildContext context) => SizedBox(
        height: 40,
        child: TextField(
          controller: controller,
          focusNode: focusNode,
          textAlignVertical: TextAlignVertical.center,
          style: TextStyle(fontSize: 12, color: _text),
          decoration: InputDecoration(
            isDense: true,
            hintText: hint,
            hintStyle:
                TextStyle(fontSize: 12, color: _text.withValues(alpha: 0.35)),
            filled: true,
            fillColor: _card,
            border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(8),
                borderSide: BorderSide(color: _text.withValues(alpha: 0.10))),
            enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(8),
                borderSide: BorderSide(color: _text.withValues(alpha: 0.10))),
            focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(8),
                borderSide: BorderSide(color: _text.withValues(alpha: 0.30))),
            contentPadding:
                const EdgeInsets.symmetric(horizontal: 12, vertical: 0),
          ),
        ),
      );
}

class _SwitchRow extends StatelessWidget {
  final String title;
  final String hint;
  final bool value;
  final bool danger;
  final ValueChanged<bool>? onChanged;
  const _SwitchRow(
      {required this.title,
      required this.hint,
      required this.value,
      this.danger = false,
      this.onChanged});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(children: [
          Expanded(
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                Row(children: [
                  Flexible(
                      child: Text(title,
                          style: TextStyle(fontSize: 14, color: _text))),
                  if (danger)
                    Padding(
                      padding: const EdgeInsets.only(left: 6),
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 5, vertical: 1),
                        decoration: BoxDecoration(
                            border:
                                Border.all(color: _muted.withValues(alpha: .6)),
                            borderRadius: BorderRadius.circular(4)),
                        child: Text('外发',
                            style: TextStyle(fontSize: 9, color: _muted)),
                      ),
                    ),
                ]),
                if (hint.isNotEmpty)
                  Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(hint,
                          maxLines: 4,
                          style: TextStyle(
                              fontSize: 12,
                              height: 1.5,
                              color: _text.withValues(alpha: 0.4)))),
              ])),
          const SizedBox(width: 16),
          Semantics(
            label: title,
            toggled: value,
            child:
                FishSwitch(value: value, danger: danger, onChanged: onChanged),
          ),
        ]),
      );
}

class _GlassDropdown extends StatelessWidget {
  final String value;
  final List<List<String>> items;
  final ValueChanged<String> onChanged;
  const _GlassDropdown(
      {required this.value, required this.items, required this.onChanged});
  @override
  Widget build(BuildContext context) {
    final label =
        items.firstWhere((e) => e[0] == value, orElse: () => [value, value])[1];
    return PopupMenuButton<String>(
      tooltip: '',
      color: _card,
      elevation: 0,
      shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
          side: BorderSide(color: _line)),
      onSelected: onChanged,
      itemBuilder: (_) => [
        for (final item in items)
          PopupMenuItem(
              value: item[0],
              child:
                  Text(item[1], style: TextStyle(fontSize: 12, color: _text))),
      ],
      child: Container(
        height: 32,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
            color: _card,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: _text.withValues(alpha: 0.10))),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Text(label, style: TextStyle(fontSize: 12, color: _text)),
          const SizedBox(width: 8),
          Icon(Icons.keyboard_arrow_down, size: 15, color: _muted),
        ]),
      ),
    );
  }
}

class _DailyLimitRow extends StatelessWidget {
  final int value;
  final ValueChanged<num> onSave;
  const _DailyLimitRow({required this.value, required this.onSave});
  @override
  Widget build(BuildContext context) {
    final on = value > 0;
    final last = int.tryParse(UiStore.get('fw.qq.dailyLast') ?? '') ?? 200;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _SwitchRow(
        title: '限制每天最多发几条',
        hint: on ? '' : '关掉 = 不限制，想发多少发多少',
        value: on,
        onChanged: (v) {
          if (v) {
            onSave(last <= 0 ? 200 : last);
          } else {
            onSave(0);
          }
        },
      ),
      if (on)
        _NumField(
          title: '每天最多',
          hint: '',
          value: value.toDouble(),
          min: 0,
          max: 3000,
          unit: '条',
          onSave: (v) {
            final n = v.toInt();
            if (n > 0) UiStore.set('fw.qq.dailyLast', n.toString());
            onSave(n);
          },
        )
      else
        Padding(
          padding: const EdgeInsets.only(left: 2, bottom: 8),
          child: Text('当前：不限制', style: TextStyle(fontSize: 11, color: _muted)),
        ),
    ]);
  }
}

class _NumField extends StatefulWidget {
  final String title;
  final String hint;
  final double value;
  final double min;
  final double max;
  final String unit;
  final ValueChanged<num> onSave;
  const _NumField(
      {required this.title,
      required this.hint,
      required this.value,
      required this.min,
      required this.max,
      required this.unit,
      required this.onSave});
  @override
  State<_NumField> createState() => _NumFieldState();
}

class _NumFieldState extends State<_NumField> {
  late final TextEditingController _ctl =
      TextEditingController(text: _fmt(widget.value));
  final _focus = FocusNode();

  static String _fmt(double v) =>
      v == v.roundToDouble() ? v.toInt().toString() : v.toString();

  @override
  void initState() {
    super.initState();
    _focus.addListener(() {
      if (!_focus.hasFocus) _commit();
    });
  }

  @override
  void didUpdateWidget(covariant _NumField old) {
    super.didUpdateWidget(old);
    if (!_focus.hasFocus && _fmt(widget.value) != _ctl.text)
      _ctl.text = _fmt(widget.value);
  }

  @override
  void dispose() {
    _focus.dispose();
    _ctl.dispose();
    super.dispose();
  }

  void _commit() {
    final raw = _ctl.text.trim();
    final parsed = num.tryParse(raw);
    if (parsed == null) {
      _ctl.text = _fmt(widget.value);
      return;
    }
    var v = parsed.toDouble();
    if (v < widget.min) v = widget.min;
    if (v > widget.max) v = widget.max;
    final fixed = v == v.roundToDouble() ? v.toInt() : v;
    _ctl.text = _fmt(v);
    if (fixed != widget.value) widget.onSave(fixed);
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SizedBox(
            width: 150,
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(widget.title, style: TextStyle(fontSize: 12, color: _text)),
              if (widget.hint.isNotEmpty)
                Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(widget.hint,
                        style: TextStyle(
                            fontSize: 10, height: 1.4, color: _muted))),
            ])),
        const SizedBox(width: 12),
        SizedBox(
          width: 120,
          child: Semantics(
            label: widget.title,
            child: TextField(
              controller: _ctl,
              focusNode: _focus,
              keyboardType:
                  const TextInputType.numberWithOptions(decimal: false),
              textInputAction: TextInputAction.done,
              onSubmitted: (_) => _commit(),
              style: TextStyle(
                  fontSize: 13,
                  color: _text,
                  fontFeatures: const [FontFeature.tabularFigures()]),
              decoration: InputDecoration(
                isDense: true,
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                suffixText: widget.unit.isEmpty ? null : widget.unit,
                suffixStyle: TextStyle(fontSize: 11, color: _muted),
                filled: true,
                fillColor: _card,
                border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(8),
                    borderSide:
                        BorderSide(color: _text.withValues(alpha: 0.10))),
                enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(8),
                    borderSide:
                        BorderSide(color: _text.withValues(alpha: 0.10))),
              ),
            ),
          ),
        ),
        const SizedBox(width: 10),
        Text(
            widget.min.toInt().toString() + '–' + widget.max.toInt().toString(),
            style: TextStyle(fontSize: 10, color: _muted)),
      ]),
    );
  }
}

class _SelectField extends StatelessWidget {
  final String title;
  final String hint;
  final int value;
  final Map<int, String> options;
  final ValueChanged<int> onChanged;
  const _SelectField(
      {required this.title,
      required this.hint,
      required this.value,
      required this.options,
      required this.onChanged});
  @override
  Widget build(BuildContext context) {
    final items = [
      for (final e in options.entries) [e.key.toString(), e.value]
    ];
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SizedBox(
            width: 150,
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: TextStyle(fontSize: 12, color: _text)),
              if (hint.isNotEmpty)
                Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(hint,
                        style: TextStyle(
                            fontSize: 10, height: 1.4, color: _muted))),
            ])),
        const SizedBox(width: 12),
        _GlassDropdown(
          value: value.toString(),
          items: items,
          onChanged: (v) => onChanged(int.tryParse(v) ?? 0),
        ),
      ]),
    );
  }
}

class _SoftError extends StatelessWidget {
  final String text;
  final bool padded;
  const _SoftError({required this.text, this.padded = false});
  @override
  Widget build(BuildContext context) {
    if (text.isEmpty) return const SizedBox.shrink();
    final child = Text(text, style: TextStyle(fontSize: 11, color: _error));
    return padded
        ? Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 8), child: child)
        : child;
  }
}

class _LogLine extends StatelessWidget {
  final Map raw;
  const _LogLine({required this.raw});
  @override
  Widget build(BuildContext context) {
    final dir = (raw['dir'] ?? 'sys').toString();
    final text = (raw['text'] ?? '').toString();
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(children: [
        Icon(
            dir == 'in'
                ? Icons.south_west
                : (dir == 'out' ? Icons.north_east : Icons.info_outline),
            size: 12,
            color: _muted),
        const SizedBox(width: 6),
        Expanded(
            child: Text(text,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12, color: _text))),
      ]),
    );
  }
}

class _PrimaryButton extends StatelessWidget {
  final String label;
  final VoidCallback? onTap;
  const _PrimaryButton({required this.label, this.onTap});
  @override
  Widget build(BuildContext context) => FilledButton(
        onPressed: onTap,
        style: FilledButton.styleFrom(
          backgroundColor: _text,
          foregroundColor: _onPrimary,
          elevation: 0,
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        ),
        child: Text(label,
            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
      );
}

class _GhostButton extends StatelessWidget {
  final String label;
  final VoidCallback? onTap;
  const _GhostButton({required this.label, this.onTap});
  @override
  Widget build(BuildContext context) => TextButton(
        onPressed: onTap,
        style: TextButton.styleFrom(
          foregroundColor: _muted,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        ),
        child: Text(label, style: const TextStyle(fontSize: 12)),
      );
}

// ⭐ 2026-11-20（主人要求 A）：桥超窗未投的消息卡。
//
// 为什么单独一张卡而不是塞进状态卡里：
//   这是「主人以为没回」的根因，性质比普通状态行重 —— 它需要**动作**（补投），
//   而状态卡是只读的。混在一起会让补投按钮看着像个开关。
class _UndeliveredCard extends StatelessWidget {
  final Map<String, dynamic> data;
  final bool busy;
  final Future<void> Function(String? id) onRedeliver;
  const _UndeliveredCard({
    required this.data,
    required this.busy,
    required this.onRedeliver,
  });

  List<Map<String, dynamic>> get _items {
    final raw = data['items'];
    if (raw is! List) return const [];
    return raw.whereType<Map>().map((x) => Map<String, dynamic>.from(x)).toList();
  }

  static String _ago(int ageSec) {
    if (ageSec <= 0) return '';
    if (ageSec < 60) return ageSec.toString() + ' 秒前';
    if (ageSec < 3600) return (ageSec ~/ 60).toString() + ' 分钟前';
    if (ageSec < 86400) return (ageSec ~/ 3600).toString() + ' 小时前';
    return (ageSec ~/ 86400).toString() + ' 天前';
  }

  @override
  Widget build(BuildContext context) {
    final items = _items;
    final count = (data['count'] is int) ? data['count'] as int : items.length;
    final exempt = data['exemptMinutes'];
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: _card,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: _line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Icon(Icons.schedule, size: 15, color: _muted),
            const SizedBox(width: 7),
            Expanded(
              child: Text(
                count.toString() + ' 条消息没投出去',
                style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: _text),
              ),
            ),
            if (busy)
              SizedBox(
                width: 13,
                height: 13,
                child:
                    CircularProgressIndicator(strokeWidth: 1.6, color: _muted),
              ),
          ]),
          const SizedBox(height: 6),
          Text(
            '这些是你在她不在线时发的，超过补投窗口就停在这儿了（不会自动回）。'
            '要让她回应就点下面的补投。',
            style: TextStyle(fontSize: 11.5, height: 1.45, color: _muted),
          ),
          if (exempt is int && exempt > 0) ...[
            const SizedBox(height: 4),
            Text(
              '重启后 ' + exempt.toString() + ' 分钟内的消息会自动补投，不会落到这里。',
              style: TextStyle(fontSize: 11, color: _muted),
            ),
          ],
          const SizedBox(height: 10),
          for (final it in items.take(5))
            Padding(
              padding: const EdgeInsets.only(bottom: 7),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 64,
                    child: Text(
                      _ago((it['ageSec'] is int) ? it['ageSec'] as int : 0),
                      style: TextStyle(fontSize: 11, color: _muted),
                    ),
                  ),
                  Expanded(
                    child: Text(
                      ((it['text'] ?? '') as String).isEmpty
                          ? '（没有文字）'
                          : (it['text'] as String),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12, height: 1.4, color: _text),
                    ),
                  ),
                  const SizedBox(width: 8),
                  TextButton(
                    style: TextButton.styleFrom(
                      minimumSize: const Size(0, 26),
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                    onPressed: busy
                        ? null
                        : () => onRedeliver((it['id'] ?? '').toString()),
                    child: const Text('补投', style: TextStyle(fontSize: 11.5)),
                  ),
                ],
              ),
            ),
          if (items.length > 5)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Text(
                '还有 ' + (items.length - 5).toString() + ' 条…',
                style: TextStyle(fontSize: 11, color: _muted),
              ),
            ),
          const SizedBox(height: 4),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              style: TextButton.styleFrom(
                minimumSize: const Size(0, 30),
                padding: const EdgeInsets.symmetric(horizontal: 10),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              onPressed: busy ? null : () => onRedeliver(null),
              icon: const Icon(Icons.replay, size: 14),
              label: const Text('全部补投', style: TextStyle(fontSize: 12)),
            ),
          ),
        ],
      ),
    );
  }
}
