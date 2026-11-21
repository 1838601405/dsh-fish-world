import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'qq_gateway_base.dart';

Directory? _testDir;
String? _testWorldRoot;
void useQqConfigDirForTest(String path) => _testDir = Directory(path);
void useQqWorldRootForTest(String path) => _testWorldRoot = path;

/// 配置读写审计：**每次都打绝对路径与实际写入的值**。
///
/// 为什么非要打：用户报过「主人 QQ 每次重启要重设」，查了半天发现
/// 是查错了文件（桌面版写 qq_config.json，面板版写 qq-bridge-config.json）。
/// 日志里没有路径，就只能靠猜。所以读和写都留一行，带绝对路径。
///
/// 落点：与 qq_config.json 同目录的 `qq_config.log`（不写 stderr，
/// nohup/打包后看不到 console）。任何异常都不抛——审计不能反过来弄坏正事。
void _audit(String line) {
  try {
    final appData = Platform.environment['APPDATA'];
    final home =
        Platform.environment['HOME'] ?? Platform.environment['USERPROFILE'] ?? '.';
    final base = (appData != null && appData.isNotEmpty) ? appData : home;
    final dir = _testDir ?? Directory(base + Platform.pathSeparator + '大肥鱼');
    final f = File(dir.path + Platform.pathSeparator + 'qq_config.log');
    f.parent.createSync(recursive: true);
    f.writeAsStringSync(
        '[' + DateTime.now().toIso8601String() + '] ' + line + '\n',
        mode: FileMode.append,
        flush: true);
  } catch (_) {}
}

/// 敏感键在日志里怎么显示：口令类只显示长度，其余原样。
String _auditValue(String key, Object? value) {
  final s = (value ?? '').toString();
  if (key == 'token' || key == '令盤' || key == '口令' || key == 'apiKey') {
    return s.isEmpty ? '""' : '<' + s.length.toString() + ' 字符，不打印>';
  }
  return '"' + s + '"';
}

QqGateway createQqGateway() => _DesktopQqGateway();

class _DesktopQqGateway implements QqGateway {
  static const _defaultBase = 'http://127.0.0.1:3000';
  static const _webui = 'http://127.0.0.1:5099';
  String _base = _defaultBase;

  File get _cfgFile {
    if (_testDir != null) return File(_testDir!.path + Platform.pathSeparator + 'qq_config.json');
    final appData = Platform.environment['APPDATA'];
    final home = Platform.environment['HOME'] ?? Platform.environment['USERPROFILE'] ?? '.';
    final base = (appData != null && appData.isNotEmpty) ? appData : home;
    return File(base + Platform.pathSeparator + '大肥鱼' + Platform.pathSeparator + 'qq_config.json');
  }

  String? _worldRoot() {
    if (_testWorldRoot != null) return _testWorldRoot;
    final candidates = <String>[
      Platform.environment['FISH_WORLD_ROOT'] ?? '',
      Platform.environment['APPDATA'] == null ? '' : Platform.environment['APPDATA']! + Platform.pathSeparator + '大肥鱼' + Platform.pathSeparator + '鱼的世界',
      'D:' + Platform.pathSeparator + '大肥鱼' + Platform.pathSeparator + '鱼的世界',
      'E:' + Platform.pathSeparator + 'WhaleGirl' + Platform.pathSeparator + '鱼的世界',
    ];
    for (final c in candidates) {
      if (c.trim().isEmpty) continue;
      if (Directory(c).existsSync()) return c;
    }
    return null;
  }

  File? _chatsFile() {
    final root = _worldRoot();
    if (root == null) return null;
    return File(root + Platform.pathSeparator + '鱼的关系' + Platform.pathSeparator + 'chats.json');
  }

  List<Map<String, dynamic>> _readChats() {
    final f = _chatsFile();
    if (f == null || !f.existsSync()) return const [];
    try {
      final raw = jsonDecode(f.readAsStringSync());
      final list = raw is Map ? raw['items'] : raw;
      if (list is! List) return const [];
      return [
        for (final e in list)
          if (e is Map)
            {
              'chatKey': (e['chatKey'] ?? ((e['kind'] ?? 'group') == 'private' ? 'private:' : 'group:') + (e['id'] ?? '')).toString(),
              'name': (e['name'] ?? '').toString(),
              'sessionId': (e['sessionId'] ?? '').toString(),
              'enabled': e['enabled'] != false,
              'mode': (e['mode'] ?? '').toString(),
            },
      ];
    } catch (_) {
      return const [];
    }
  }

  void _writeChats(List<Map<String, dynamic>> items) {
    final f = _chatsFile();
    if (f == null) return;
    try {
      final old = <String, Map<String, dynamic>>{};
      if (f.existsSync()) {
        final raw = jsonDecode(f.readAsStringSync());
        for (final e in ((raw is Map ? raw['items'] : raw) as List? ?? const [])) {
          if (e is Map) old[(e['chatKey'] ?? '').toString()] = Map<String, dynamic>.from(e);
        }
      }
      final out = <Map<String, dynamic>>[];
      for (final m in items) {
        final key = (m['chatKey'] ?? '').toString();
        if (key.isEmpty) continue;
        final kind = key.startsWith('private:') ? 'private' : 'group';
        final prev = old[key];
        out.add({
          'chatKey': key,
          'kind': kind,
          'id': key.substring(key.indexOf(':') + 1),
          'sessionId': (m['sessionId'] ?? prev?['sessionId'] ?? '').toString(),
          'name': (m['name'] ?? prev?['name'] ?? '').toString(),
          'enabled': m['enabled'] != false,
          'mode': (m['mode'] ?? prev?['mode'] ?? '').toString(),
          'cursorAt': prev?['cursorAt'] ?? 0,
          'cursorMessageId': prev?['cursorMessageId'] ?? '',
        });
      }
      f.parent.createSync(recursive: true);
      f.writeAsStringSync(const JsonEncoder.withIndent('  ').convert({'version': 1, 'items': out, 'updatedAt': DateTime.now().toUtc().toIso8601String()}), flush: true);
    } catch (_) {}
  }

  Map<String, dynamic> _cfg() {
    final f = _cfgFile;
    try {
      final raw = jsonDecode(f.readAsStringSync());
      if (raw is Map) {
        final m = Map<String, dynamic>.from(raw);
        // 读到的 ownerQQ 是「重启后主人 QQ 还在不在」的第一现场，必须留痕。
        _audit('READ  ' +
            f.path +
            '  ownerQQ=' +
            _auditValue('ownerQQ', m['ownerQQ']) +
            '  keys=' +
            m.keys.join(','));
        return m;
      }
      _audit('READ  ' + f.path + '  <不是 JSON 对象，按默认值兜底>');
    } catch (e) {
      // 文件不存在是常态（首次运行），要和「读坏了」区分开。
      _audit('READ  ' + f.path + '  <读不到：' + e.toString() + '>');
    }
    return <String, dynamic>{
      'baseUrl': _defaultBase,
      'allowChats': <Object?>[],
      'groupReplyMode': 'active',
      'receive': false
    };
  }

  /// 写配置。**失败必须让调用方知道**——旧版是 `catch (_) {}`，
  /// 写不进也返回成功，界面就显示「已保存」而磁盘上什么都没变（假成功）。
  ///
  /// 返回 true = 真写进去了；false = 没写进去（调用方要如实报错）。
  bool _saveCfg(Map<String, dynamic> c) {
    final f = _cfgFile;
    try {
      f.parent.createSync(recursive: true);
      f.writeAsStringSync(const JsonEncoder.withIndent('  ').convert(c),
          flush: true);
      _audit('WRITE ' +
          f.path +
          '  ownerQQ=' +
          _auditValue('ownerQQ', c['ownerQQ']) +
          '  ownerQQSavedAt=' +
          _auditValue('ownerQQSavedAt', c['ownerQQSavedAt']) +
          '  bytes=' +
          f.lengthSync().toString());
      return true;
    } catch (e) {
      _audit('WRITE ' + f.path + '  <失败：' + e.toString() + '>');
      return false;
    }
  }

  int _heartbeatMs() {
    try {
      final info = _heartbeatFile();
      return info.atMs;
    } catch (_) {}
    return 0;
  }

  /// 心跳文件的完整信息：时间戳 + 谁写的。
  ///
  /// ★ 2026-11-20：插件版现在也写**同一个文件**（谁跑都算活），
  ///   所以旁边多了一个 `source` 字段（'plugin' / 桌面版写的没有这个字段）。
  ///   面板要说清楚「现在是插件在跑」，而不是只显示一个时间让人猜。
  ///   旧版本桌面版写的心跳没有 source，按 'desktop' 算。
  ({int atMs, String source}) _heartbeatFile() {
    try {
      final f = File(_cfgFile.parent.path + Platform.pathSeparator + 'qq-heartbeat.json');
      if (!f.existsSync()) return (atMs: 0, source: '');
      final raw = jsonDecode(f.readAsStringSync());
      if (raw is Map) {
        final atMs =
            DateTime.tryParse((raw['at'] ?? '').toString())?.millisecondsSinceEpoch ?? 0;
        final src = (raw['source'] ?? '').toString().trim();
        return (atMs: atMs, source: src.isEmpty ? 'desktop' : src);
      }
    } catch (_) {}
    return (atMs: 0, source: '');
  }

  /// 桥超窗未投队列：**直接读状态文件**，不走 HTTP。
  ///
  /// 为什么不走 HTTP：插件版拿不到宿主 webServer 端口（要猜 7790-7799），
  /// 而桌面版本来就能读本机文件，桥的状态文件就在 DSH_HOME 里，最可靠。
  /// 桥的字段名是中文（未投队列 / 桥启动于 / 重启豁免分），照它读。
  @override
  Future<Map<String, dynamic>?> undelivered() async {
    try {
      final f = File(_bridgeStatePath());
      if (!f.existsSync()) {
        // 文件还没有 = 桥没跑过/没丢过东西。这不是错误，如实说「没有」。
        return {'ok': true, 'count': 0, 'items': <Map<String, dynamic>>[], 'source': 'file'};
      }
      final raw = jsonDecode(f.readAsStringSync());
      if (raw is! Map) return {'ok': false, 'error': '桥状态文件格式不对'};
      final items = <Map<String, dynamic>>[];
      final list = raw['未投队列'];
      if (list is List) {
        for (final x in list) {
          if (x is! Map) continue;
          final at = int.tryParse((x['时间'] ?? 0).toString()) ?? 0;
          items.add({
            'id': (x['id'] ?? '').toString(),
            'atMs': at * 1000,
            'ageSec': int.tryParse((x['秒'] ?? 0).toString()) ?? 0,
            'text': (x['文字'] ?? '').toString(),
            'nickname': (x['昵称'] ?? '').toString(),
            'qq': x['号码'] ?? 0,
            'reason': (x['原因'] ?? '').toString(),
          });
        }
      }
      return {
        'ok': true,
        'count': items.length,
        'items': items,
        'bridgeStartedAt': int.tryParse((raw['桥启动于'] ?? 0).toString()) ?? 0,
        'exemptMinutes': int.tryParse((raw['重启豁免分'] ?? 30).toString()) ?? 30,
        'supportsQueue': raw.containsKey('未投队列'),
        'source': 'file',
      };
    } catch (e) {
      return {'ok': false, 'error': e.toString()};
    }
  }

  /// 补投：写一个请求文件给桥，桥下一次轮询会执行。
  ///
  /// 桌面版没有直连桥 HTTP 端口的可靠办法（要猜端口），
  /// 而文件握手是确定的：桥读这个请求、执行、删掉。
  @override
  Future<Map<String, dynamic>?> redeliver({String? id, bool all = false}) async {
    try {
      if (!all && (id == null || id.isEmpty)) {
        return {'ok': false, 'error': '要给 id，或者选全部补投'};
      }
      final f = File(_redeliverRequestPath());
      f.parent.createSync(recursive: true);
      f.writeAsStringSync(
          jsonEncode({
            'id': all ? '' : id,
            'all': all,
            'at': DateTime.now().toIso8601String(),
          }),
          flush: true);
      return {'ok': true, 'queued': true, 'note': '已提交补投请求，桥下一次轮询会执行'};
    } catch (e) {
      return {'ok': false, 'error': e.toString()};
    }
  }

  /// 桥的状态文件：DSH_HOME/qq-bridge-state.json。
  String _dshHome() {
    final env = Platform.environment['DSH_HOME'];
    if (env != null && env.isNotEmpty) return env;
    return (Platform.environment['USERPROFILE'] ?? '.') +
        Platform.pathSeparator +
        'DSH-home';
  }

  String _bridgeStatePath() => _dshHome() + Platform.pathSeparator + 'qq-bridge-state.json';

  String _redeliverRequestPath() =>
      _dshHome() + Platform.pathSeparator + 'qq-redeliver-request.json';

  @override
  bool get isDesktop => true;

  Future<Map<String, dynamic>?> _post(String endpoint, [Map<String, Object?> body = const {}]) async {
    try {
      final base = _cfg()['baseUrl']?.toString();
      _base = (base == null || base.isEmpty) ? _defaultBase : base;
      final client = HttpClient()..connectionTimeout = const Duration(seconds: 3);
      final req = await client.postUrl(Uri.parse(_base + endpoint));
      req.headers.contentType = ContentType.json;
      req.write(jsonEncode(body));
      final res = await req.close().timeout(const Duration(seconds: 5));
      final text = await res.transform(utf8.decoder).join();
      client.close(force: true);
      final decoded = jsonDecode(text);
      return decoded is Map ? Map<String, dynamic>.from(decoded) : null;
    } catch (_) {
      return null;
    }
  }

  Future<bool> _listening(int port) async {
    try {
      final s = await Socket.connect('127.0.0.1', port, timeout: const Duration(milliseconds: 450));
      s.destroy();
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<bool> _protocolRunning() async => await _listening(3000) || await _listening(5099);

  @override
  Future<Map<String, dynamic>?> probeLogin() async {
    if (Platform.environment.containsKey('FLUTTER_TEST') && !const bool.fromEnvironment('LIVE_QQ_TEST')) return {'ok': true, 'login': {'ok': false}};
    final r = await _post('/get_login_info');
    final data = r?['data'];
    if (data is Map) {
      return {
        'ok': true,
        'login': {
          'ok': true,
          'nickname': (data['nickname'] ?? '').toString(),
          'userId': (data['user_id'] ?? '').toString(),
        },
      };
    }
    return {'ok': true, 'login': {'ok': false, 'error': r == null ? '协议端未启动' : '未登录'}};
  }

  @override
  Future<Map<String, dynamic>?> loginState() async {
    if (Platform.environment.containsKey('FLUTTER_TEST') && !const bool.fromEnvironment('LIVE_QQ_TEST')) {
      return {
        'ok': true,
        'running': false,
        'protocol': {'running': false, 'webui': _webui},
        'login': {'ok': false},
        'needAuth': false,
        'lastTickAt': '0',
        'sessionConflict': _sessionConflictText(),
      };
    }
    final running = await _protocolRunning();
    final probe = await probeLogin();
    final login = (probe?['login'] as Map?) ?? const {'ok': false};
    final info = _heartbeatFile();
    final hb = info.atMs;
    return {
      'ok': true,
      'running': _cfg()['receive'] == true,
      'protocol': {'running': running, 'webui': _webui},
      'login': login,
      'needAuth': false,
      // ★ 不许再「没有心跳就假装 now」：旧写法是
      //   `_heartbeatMs() > 0 ? ... : (running ? DateTime.now()... : '0')`
      //   ——只要 3000 端口有人在听，界面就显示「刚刚」，服务停了一夜也看不出来。
      //   现在只信文件里的时间戳；没有就是 '0'，界面上会显示「—」/「心跳停了」。
      'lastTickAt': hb > 0 ? hb.toString() : '0',
      // 心跳多久没动：界面据此判断「停了」而不是靠猜。
      'heartbeatAgeMs': hb > 0 ? DateTime.now().millisecondsSinceEpoch - hb : -1,
      // 谁写的心跳：'plugin'（DSH 插件）/ 'desktop'（桌面版自己）。
      // ★ 2026-11-20 加：插件现在也写同一个文件，面板要能说清是谁在跑。
      'heartbeatSource': info.source,
      // 会话冲突：同一个 sessionId 同时挂在主人私聊和别处 ⇒ 面板要显式报出来，不能静默串台。
      'sessionConflict': _sessionConflictText(),
    };
  }

  String _sessionConflictText() {
    return _sessionConflictTextInner();
  }

  String _sessionConflictTextInner() {
    try {
      final root = _worldRoot();
      if (root == null) return '';
      final chats = File(root +
          Platform.pathSeparator +
          '鱼的关系' +
          Platform.pathSeparator +
          'chats.json');
      final people = File(root +
          Platform.pathSeparator +
          '鱼的关系' +
          Platform.pathSeparator +
          'people.json');
      if (!chats.existsSync() || !people.existsSync()) return '';
      final rawPeople = jsonDecode(people.readAsStringSync());
      final ownerRaw = rawPeople is Map ? rawPeople['owner'] : null;
      String ownerQQ = ownerRaw is Map ? (ownerRaw['qqId'] ?? '').toString() : '';
      if (ownerQQ.isEmpty) {
        // 没有 owner 段就从 qq_config 的主人 QQ 兜底。
        final cfgQQ = (_cfg()['ownerQQ'] ?? '').toString().trim();
        if (cfgQQ.isNotEmpty) ownerQQ = cfgQQ;
      }
      if (ownerQQ.isEmpty) return '';
      final rawChats = jsonDecode(chats.readAsStringSync());
      final itemsRaw = rawChats is Map ? rawChats['items'] : rawChats;
      final items = itemsRaw is List ? itemsRaw : const [];
      final bySid = <String, List<String>>{};
      for (final e in items) {
        if (e is! Map) continue;
        final sid = (e['sessionId'] ?? '').toString();
        if (sid.isEmpty) continue;
        final key = (e['chatKey'] ?? '').toString();
        bySid.putIfAbsent(sid, () => <String>[]).add(key);
      }
      final out = <String>[];
      bySid.forEach((sid, keys) {
        if (keys.length < 2) return;
        if (!keys.contains('private:' + ownerQQ)) return;
        out.add('会话冲突：' + sid + ' 同时绑了 ' + keys.join(' 和 '));
      });
      return out.join('；');
    } catch (_) {
      return '';
    }
  }

  @override
  Future<Map<String, dynamic>?> startProtocol() async {
    if (await _protocolRunning()) {
      return {'ok': true, 'alreadyRunning': true, 'result': {'ok': true, 'alreadyRunning': true}, 'webui': _webui};
    }
    final dir = Platform.environment['SNOWLUMA_DIR'] ?? 'D:' + Platform.pathSeparator + 'deepseek-qq' + Platform.pathSeparator + 'snowluma';
    final node = File(dir + Platform.pathSeparator + 'node.exe');
    final entry = File(dir + Platform.pathSeparator + 'index.mjs');
    if (!node.existsSync() || !entry.existsSync()) {
      return {'ok': false, 'error': '找不到 SnowLuma：' + dir};
    }
    try {
      await Process.start(node.path, [entry.path], workingDirectory: dir, mode: ProcessStartMode.detached);
    } catch (e) {
      return {'ok': false, 'error': e.toString()};
    }
    for (var i = 0; i < 20; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 300));
      if (await _protocolRunning()) {
        return {'ok': true, 'alreadyRunning': false, 'result': {'ok': true, 'alreadyRunning': false}, 'webui': _webui};
      }
    }
    return {'ok': false, 'error': '协议端启动超时（5099 未监听）'};
  }

  @override
  Future<Map<String, dynamic>?> stopProtocol() async => {'ok': true, 'result': {'ok': true, 'remaining': 0}};

  @override
  Future<Map<String, dynamic>?> setReceiving(bool running) async {
    final c = _cfg();
    c['receive'] = running;
    final ok = _saveCfg(c);
    if (!ok) return {'ok': false, 'running': running, 'error': '写不进本机配置'};
    return {'ok': true, 'running': running};
  }

  @override
  Future<Map<String, dynamic>?> listTargets() async {
    final groups = await _post('/get_group_list');
    final friends = await _post('/get_friend_list');
    List<Map<String, dynamic>> list(Object? raw) {
      final data = (raw as Map?)?['data'];
      if (data is! List) return const [];
      return [for (final e in data) if (e is Map) {'id': (e['group_id'] ?? e['user_id'] ?? '').toString(), 'name': (e['group_name'] ?? e['nickname'] ?? '').toString()}];
    }
    return {'ok': true, 'groups': list(groups), 'friends': list(friends), 'targets': [], 'errors': {}};
  }

  @override
  Future<Map<String, dynamic>?> send(String chatKey, String text) async {
    final group = chatKey.startsWith('group:');
    final id = int.tryParse(chatKey.substring(chatKey.indexOf(':') + 1)) ?? 0;
    final r = await _post(group ? '/send_group_msg' : '/send_private_msg', {group ? 'group_id' : 'user_id': id, 'message': text});
    return {'ok': r != null && (r['status'] == 'ok' || r['retcode'] == 0)};
  }

  @override
  Future<Map<String, dynamic>?> loadConfig() async {
    final cfg = _cfg();
    cfg['allowChats'] = _readChats();
    return {'ok': true, 'config': cfg};
  }

  @override
  Future<Map<String, dynamic>?> saveConfig({String? baseUrl, String? token}) async {
    final c = _cfg();
    if (baseUrl != null && baseUrl.trim().isNotEmpty) c['baseUrl'] = baseUrl.trim();
    if (token != null && token.trim().isNotEmpty) c['token'] = token.trim();
    final ok = _saveCfg(c);
    if (!ok) return {'ok': false, 'error': '写不进本机配置', 'config': c};
    return {'ok': true, 'config': c};
  }

  @override
  Future<Map<String, dynamic>?> saveField(String key, Object? value) async {
    final c = _cfg();
    if (key == 'allowChats') {
      final list = (value is List ? value : const []).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
      _writeChats(list);
      c['allowChats'] = _readChats();
    } else {
      c[key] = value;
    }
    // 绑定主人 QQ 就等于允许他私聊：写进 chats.json，别让“关了群顺手关了主人”。
    // ★ 顺序要紧：先把 ownerQQSavedAt 一起放进 c，再一次写盘。
    //   旧写法是先 _saveCfg 再补时间戳再 _saveCfg——中间那次失败会被吞掉，
    //   结果磁盘上有号没时间戳（实测现场就是这样：文件里没有 ownerQQSavedAt）。
    if (key == 'ownerQQ') {
      final qq = (value ?? '').toString().trim();
      c['ownerQQSavedAt'] = qq.isEmpty ? '' : DateTime.now().toIso8601String();
    }
    final ok = _saveCfg(c);
    if (!ok) {
      // 写盘失败：如实报，不假成功。界面靠这个 ok 决定显示红字还是绿字。
      _audit('SAVE-FAIL key=' + key + ' value=' + _auditValue(key, value));
      return {'ok': false, 'error': '写不进本机配置（' + _cfgFile.path + '）', 'config': c};
    }
    if (key == 'ownerQQ') {
      final qq = (value ?? '').toString().trim();
      if (qq.isNotEmpty) _ensureOwnerChat('private:' + qq, '');
    }
    return {'ok': true, 'config': c};
  }

  void _ensureOwnerChat(String key, String name) {
    final list = List<Map<String, dynamic>>.from(_readChats());
    for (final e in list) {
      if ((e['chatKey'] ?? '').toString() == key) {
        if (e['enabled'] != true) {
          e['enabled'] = true;
          _writeChats(list);
        }
        return;
      }
    }
    list.add(<String, dynamic>{
      'chatKey': key,
      'kind': 'private',
      'id': key.substring(key.indexOf(':') + 1),
      'name': name,
      'enabled': true,
    });
    _writeChats(list);
  }
}
