import 'dart:async';
import 'dart:convert';
import 'dart:io';

// ignore_for_file: prefer_interpolation_to_compose_strings

/// 协议端（SnowLuma）一键就绪服务。
///
/// 把 `tools/snowluma-oneclick.mjs` 的链路搬进桌面端，四件事：
/// **检测 / 一键 / 状态 / 登录凭据**。
///
/// 桌面专用：Web 端不加载本文件（走桥）。
///
/// 安全红线（用户定）：
/// - QQ 密码只以 **DPAPI 密文 + 凭据引用** 落盘，任何界面 / 日志 / 配置都不见明文；
/// - WebUI 令牌只写本机配置，不写日志；
/// - 登录仍由用户自己在 QQ 里完成，本服务**不代输密码**（SnowLuma 只做进程注入，
///   没有代输接口——已核过本体，见收口单「未验证项」）。

/// 传输层：真实实现走本机 HTTP；测试注入假实现，不碰真端口。
abstract class ProtocolTransport {
  /// 5099 WebUI 是否在监听（任何 HTTP 响应都算活着，401 也算）。
  Future<bool> webuiAlive();

  /// 用访问令牌换会话 token；失败返回 null。
  Future<String?> webuiLogin({required String password});

  /// 令牌是否有效（`/api/auth/state` 回 200）。
  Future<bool> authState(String token);

  /// 列已发现的 QQ 进程。
  Future<List<Map<String, dynamic>>> processes(String token);

  /// 向指定 pid 注入 SnowLuma。
  Future<bool> loadProcess(String token, int pid);

  /// OneBot 3000 的 get_login_info。
  Future<Map<String, dynamic>?> onebotLoginInfo();

  /// 端口是否在听。
  Future<bool> portListening(int port);
}

class HttpProtocolTransport implements ProtocolTransport {
  static const String webuiBase = 'http://127.0.0.1:5099';
  static const String onebotBase = 'http://127.0.0.1:3000';

  @override
  Future<bool> webuiAlive() async {
    final r = await _json(webuiBase + '/api/login',
        method: 'POST', body: const {}, timeoutMs: 2500);
    return r != null;
  }

  @override
  Future<String?> webuiLogin({required String password}) async {
    final r = await _json(webuiBase + '/api/login',
        method: 'POST', body: {'password': password}, timeoutMs: 5000);
    if (r != null && r['success'] == true) {
      final t = (r['token'] ?? '').toString();
      return t.isEmpty ? null : t;
    }
    return null;
  }

  @override
  Future<bool> authState(String token) async {
    final code = await _status(webuiBase + '/api/auth/state',
        headers: {'x-snowluma-token': token}, timeoutMs: 4000);
    return code == 200;
  }

  @override
  Future<List<Map<String, dynamic>>> processes(String token) async {
    final r = await _json(webuiBase + '/api/processes',
        headers: {'x-snowluma-token': token}, timeoutMs: 5000);
    final list = (r?['list'] as List?) ?? const [];
    return [
      for (final e in list)
        if (e is Map) Map<String, dynamic>.from(e),
    ];
  }

  @override
  Future<bool> loadProcess(String token, int pid) async {
    final r = await _json(
        webuiBase + '/api/processes/' + pid.toString() + '/load',
        method: 'POST',
        headers: {'x-snowluma-token': token},
        body: const {},
        timeoutMs: 30000);
    return r != null && r['success'] == true;
  }

  @override
  Future<Map<String, dynamic>?> onebotLoginInfo() async {
    final r = await _json(onebotBase + '/get_login_info', timeoutMs: 5000);
    final data = r?['data'];
    return data is Map ? Map<String, dynamic>.from(data) : null;
  }

  @override
  Future<bool> portListening(int port) async {
    try {
      final s = await Socket.connect('127.0.0.1', port,
          timeout: const Duration(milliseconds: 450));
      s.destroy();
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<Map<String, dynamic>?> _json(
    String url, {
    String method = 'GET',
    Map<String, String> headers = const {},
    Map<String, Object?> body = const {},
    int timeoutMs = 5000,
  }) async {
    try {
      final client = HttpClient()
        ..connectionTimeout = Duration(milliseconds: timeoutMs);
      final req = method == 'GET'
          ? await client.getUrl(Uri.parse(url))
          : await client.postUrl(Uri.parse(url));
      for (final e in headers.entries) {
        req.headers.add(e.key, e.value);
      }
      if (body.isNotEmpty) {
        req.headers.contentType = ContentType.json;
        req.write(jsonEncode(body));
      }
      final res = await req.close().timeout(Duration(milliseconds: timeoutMs));
      final text = await res.transform(utf8.decoder).join();
      client.close(force: true);
      final decoded = jsonDecode(text);
      return decoded is Map ? Map<String, dynamic>.from(decoded) : null;
    } catch (_) {
      return null;
    }
  }

  /// 只取 HTTP 状态码；连不上返回 0。判据要看码，不看「有没有响应体」。
  Future<int> _status(
    String url, {
    Map<String, String> headers = const {},
    int timeoutMs = 4000,
  }) async {
    try {
      final client = HttpClient()
        ..connectionTimeout = Duration(milliseconds: timeoutMs);
      final req = await client.getUrl(Uri.parse(url));
      for (final e in headers.entries) {
        req.headers.add(e.key, e.value);
      }
      final res = await req.close().timeout(Duration(milliseconds: timeoutMs));
      final code = res.statusCode;
      await res.transform(utf8.decoder).join();
      client.close(force: true);
      return code;
    } catch (_) {
      return 0;
    }
  }
}

/// 凭据编解码：把明文变成可落盘的密文，以及反向。
/// 真实实现走 Windows DPAPI；测试注入假实现，不碰系统密钥。
abstract class CredentialCodec {
  Future<String> protect(String plain);
  Future<String> unprotect(String blob);
}

/// Windows DPAPI（`ProtectedData`，等价 `CryptProtectData`，用户作用域）。
/// 明文只经 stdin 进 PowerShell，不进 argv、不进日志。
class PowershellDpapiCodec implements CredentialCodec {
  // 全部用 raw string：避免 Dart 把 PowerShell 的 $ 变量当成插值。
  // 三处编码都要点名：不做的话 PowerShell 子进程 stdout 走 OEM 码页，
  // 中文解回来就变成乱码/半截多字节（实测 FormatException: Missing extension byte）。
  static const String _protectScript =
      'Add-Type -AssemblyName System.Security; '
      '[Console]::InputEncoding = [Text.Encoding]::UTF8; '
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
      r'$p = [Console]::ReadLine(); ' +
      r'$b = [Text.Encoding]::UTF8.GetBytes($p); ' +
      r'$enc = [Security.Cryptography.ProtectedData]::Protect($b, $null, 1); ' +
      r'[Convert]::ToBase64String($enc)';

  static const String _unprotectScript =
      'Add-Type -AssemblyName System.Security; '
      '[Console]::InputEncoding = [Text.Encoding]::UTF8; '
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
      r'$e = [Convert]::FromBase64String([Console]::ReadLine()); ' +
      r'$d = [Security.Cryptography.ProtectedData]::Unprotect($e, $null, 1); ' +
      r'[Text.Encoding]::UTF8.GetString($d)';

  @override
  Future<String> protect(String plain) => _run(_protectScript, plain);

  @override
  Future<String> unprotect(String blob) => _run(_unprotectScript, blob);

  Future<String> _run(String script, String input) async {
    final proc = await Process.start(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      mode: ProcessStartMode.normal,
    );
    proc.stdin.write(input);
    proc.stdin.close();
    final out = await proc.stdout.transform(utf8.decoder).join();
    final err = await proc.stderr.transform(utf8.decoder).join();
    final code = await proc.exitCode;
    final text = out.trim();
    if (code != 0 || text.isEmpty) {
      throw StateError('DPAPI 调用失败（exit ' +
          code.toString() +
          '）：' +
          (err.trim().isEmpty ? text : err.trim()));
    }
    return text;
  }
}

/// 退出码：与 `snowluma-oneclick.mjs` 一致，UI 按码给话。
const int codeOk = 0;
const int codeNoSnowluma = 2;
const int codeNotStarted = 3;
const int codeAuthFailed = 4;
const int codeNoQqProcess = 5;
const int codeNotOnline = 6;

String codeName(int code) => switch (code) {
      codeOk => '就绪',
      codeNoSnowluma => '找不到协议端',
      codeNotStarted => '协议端起不来',
      codeAuthFailed => 'WebUI 登录失败',
      codeNoQqProcess => '没有可注入的 QQ',
      codeNotOnline => 'QQ 没上线',
      _ => '未知失败',
    };

String? _testDir;
String? _testAppDir;
int? _testOnlineWaitMs;
bool _testSkipQqLaunch = false;

void useProtocolDirForTest(String? path) => _testDir = path;
void useProtocolAppDirForTest(String? path) => _testAppDir = path;

/// 压短「等 QQ 上线」的窗口，只给测试用；生产固定 90 秒。
void useProtocolOnlineWaitMsForTest(int? ms) => _testOnlineWaitMs = ms;

/// 测试里别真把 QQ 拉起来（会弹窗、会打断人）。
void useProtocolSkipQqLaunchForTest(bool skip) => _testSkipQqLaunch = skip;

/// 协议端服务。
class ProtocolEndpoint {
  final ProtocolTransport _transport;
  final CredentialCodec _codec;

  ProtocolEndpoint({
    ProtocolTransport? transport,
    CredentialCodec? codec,
  })  : _transport = transport ?? HttpProtocolTransport(),
        _codec = codec ?? PowershellDpapiCodec();

  // ---------------------------------------------------------------- 检测

  /// 找 SnowLuma 目录：测试钩子优先，再环境变量，再按盘符扫常见位置。
  /// 与 oneclick 脚本同一份候选，避免两边判据漂移。
  String findSnowluma() {
    // 钩子一旦设了（哪怕设成空串）就只用它：空串 = 明确「找不到」，
    // 这样测试能在装了真 SnowLuma 的机器上造出「没有协议端」的负向场景。
    if (_testDir != null) return _snowlumaUsable(_testDir!) ? _testDir! : '';
    final candidates = <String Function()>[
      () => Platform.environment['SNOWLUMA_DIR'] ?? '',
      () => 'D:' + Platform.pathSeparator + 'deepseek-qq' + Platform.pathSeparator + 'snowluma',
      () => 'C:' + Platform.pathSeparator + 'deepseek-qq' + Platform.pathSeparator + 'snowluma',
      () => 'E:' + Platform.pathSeparator + 'deepseek-qq' + Platform.pathSeparator + 'snowluma',
      () => 'F:' + Platform.pathSeparator + 'deepseek-qq' + Platform.pathSeparator + 'snowluma',
      () => 'D:' + Platform.pathSeparator + 'snowluma',
      () => 'C:' + Platform.pathSeparator + 'snowluma',
      () => 'E:' + Platform.pathSeparator + 'snowluma',
      () => 'F:' + Platform.pathSeparator + 'snowluma',
      () => (Platform.environment['USERPROFILE'] ?? '') +
          Platform.pathSeparator +
          'snowluma',
    ];
    for (final f in candidates) {
      final c = f().trim();
      if (c.isEmpty) continue;
      if (_snowlumaUsable(c)) return c;
    }
    return '';
  }

  bool _snowlumaUsable(String dir) {
    if (dir.isEmpty) return false;
    final node = File(dir + Platform.pathSeparator + 'node.exe');
    final entry = File(dir + Platform.pathSeparator + 'index.mjs');
    return node.existsSync() && entry.existsSync();
  }

  /// 找 QQ 本体（QQNT）：注册表不可靠，按已知安装位置找 QQ.exe。
  /// 找不到就返回空串，UI 如实说「没找到 QQ」。
  String findQq() {
    const candidates = <String>[
      r'C:\Program Files\Tencent\QQNT\QQ.exe',
      r'C:\Program Files (x86)\Tencent\QQNT\QQ.exe',
      r'D:\Program Files\Tencent\QQNT\QQ.exe',
      r'D:\Tencent\QQNT\QQ.exe',
      r'E:\Program Files\Tencent\QQNT\QQ.exe',
      r'E:\Tencent\QQNT\QQ.exe',
    ];
    for (final c in candidates) {
      if (File(c).existsSync()) return c;
    }
    return '';
  }

  /// 拉起 QQ 本体，让用户在里面扫码登录。
  /// **不代填密码**：这里只负责把窗口打开。
  Future<Map<String, dynamic>> launchQq() async {
    if (Platform.environment.containsKey('FLUTTER_TEST') && _testSkipQqLaunch) {
      return {'ok': true, 'launched': false, 'reason': '测试里不真启动'};
    }
    final exe = findQq();
    if (exe.isEmpty) {
      return {
        'ok': false,
        'launched': false,
        'error': '没找到 QQ（QQNT）。装在别处的话，手动打开 QQ 扫码登录即可。'
      };
    }
    try {
      await Process.start(exe, const [], mode: ProcessStartMode.detached);
      return {'ok': true, 'launched': true, 'path': exe};
    } catch (e) {
      return {'ok': false, 'launched': false, 'error': e.toString()};
    }
  }

  /// 检测：把「找得到吗 / 起得来吗 / 登录了吗」一次摆清。
  /// 每步都给 `ok` 与一句人话，UI 直接摆。
  Future<Map<String, dynamic>> detect() async {
    final dir = findSnowluma();
    final usable = _snowlumaUsable(dir);
    final webui = await _transport.webuiAlive();
    final onebotHttp = await _transport.portListening(3000);
    final onebotWs = await _transport.portListening(3001);
    final login = await _transport.onebotLoginInfo();
    final logged =
        login != null && (login['user_id'] ?? '').toString().isNotEmpty;
    final steps = <Map<String, dynamic>>[
      {
        'key': 'dir',
        'title': '协议端目录',
        'ok': usable,
        'detail': usable ? dir : '没找到 node.exe + index.mjs（可设 SNOWLUMA_DIR）',
      },
      {
        'key': 'webui',
        'title': 'WebUI 5099',
        'ok': webui,
        'detail': webui ? '在监听' : '没监听',
      },
      {
        'key': 'onebot',
        'title': 'OneBot 3000 / 3001',
        'ok': onebotHttp,
        'detail': (onebotHttp ? '3000 在' : '3000 无') +
            (onebotWs ? ' · 3001 在' : ' · 3001 无'),
      },
      {
        'key': 'login',
        'title': 'QQ 登录',
        'ok': logged,
        'detail': logged
            ? '已登录 ' + (login['nickname'] ?? '').toString()
            : '还没登录',
      },
    ];
    return {
      'ok': true,
      'snowlumaDir': dir,
      'usable': usable,
      'webui': webui,
      'onebotHttp': onebotHttp,
      'onebotWs': onebotWs,
      'protocolRunning': webui || onebotHttp,
      'logged': logged,
      'webuiUrl': HttpProtocolTransport.webuiBase,
      'steps': steps,
    };
  }

  // ---------------------------------------------------------------- 一键

  /// 一键就绪：找目录 → 起进程 → 拿令牌 → 列进程 → 注入 → 等上线 → 核对 uin。
  /// 返回 `{ok, code, message, stage, uin, nickname, snowlumaDir}`；
  /// `code` 与 oneclick 脚本一致，UI 按码给话，不假成功。
  Future<Map<String, dynamic>> oneClick({String? uin, String? webuiToken}) async {
    final dir = findSnowluma();
    if (!_snowlumaUsable(dir)) {
      return _fail(codeNoSnowluma, '找不到协议端：需要 node.exe + index.mjs', 'dir', dir);
    }

    if (!await _transport.webuiAlive()) {
      final r = await _launch(dir);
      if (!r.up) {
        return _fail(
            codeNotStarted, '协议端 40 秒内没监听 5099，看日志：' + r.logPath, 'launch', dir);
      }
    }

    final token = await _resolveToken(dir, webuiToken);
    if (token.isEmpty) {
      return _fail(
          codeAuthFailed,
          '需要 WebUI 访问令牌：在 5099 设过就在下面填，或用首次启动日志里的初始令牌',
          'token',
          dir);
    }

    final procs = await _transport.processes(token);
    if (procs.isEmpty) {
      return _fail(codeNoQqProcess, '没有可注入的 QQ 进程（先打开 QQ 登录鱼号）', 'processes', dir);
    }
    final wanted = uin?.trim() ?? '';
    Map<String, dynamic>? target;
    for (final p in procs) {
      final acc = p['account'];
      if (acc is Map && (acc['uin'] ?? '').toString() == wanted) {
        target = p;
        break;
      }
    }
    if (target == null && wanted.isEmpty) {
      for (final p in procs) {
        final acc = p['account'];
        if (acc is Map && (acc['uin'] ?? '').toString().isNotEmpty) {
          target = p;
          break;
        }
      }
    }
    if (target == null) {
      return _fail(
          codeNoQqProcess,
          wanted.isEmpty ? '没有找到已登录的 QQ 进程' : '没找到 QQ ' + wanted,
          'processes',
          dir);
    }

    final pid = int.tryParse((target['pid'] ?? '0').toString()) ?? 0;
    final accountUin = ((target['account'] as Map?)?['uin'] ?? '').toString();
    if ((target['status'] ?? '').toString() != 'online') {
      final loaded = await _transport.loadProcess(token, pid);
      if (!loaded) {
        return _fail(
            codeNotStarted, '注入失败（pid ' + pid.toString() + '）', 'inject', dir);
      }
    }

    final online = await _waitOnline(token, accountUin);
    if (!online) {
      return _fail(
          codeNotOnline,
          '账号 ' +
              (accountUin.isEmpty ? '?' : accountUin) +
              ' 90 秒内没上线（可能要在手机上确认登录）',
          'online',
          dir);
    }

    final who = await _transport.onebotLoginInfo();
    final got = (who?['user_id'] ?? '').toString();
    if (got != accountUin) {
      return _fail(
          codeNotOnline,
          'OneBot 3000 返回的账号不是 ' +
              accountUin +
              '（拿到 ' +
              (got.isEmpty ? '空' : got) +
              '）',
          'verify',
          dir);
    }

    return {
      'ok': true,
      'code': codeOk,
      'message':
          '协议端就绪：' + accountUin + ' ' + (who?['nickname'] ?? '').toString(),
      'stage': 'done',
      'uin': accountUin,
      'nickname': (who?['nickname'] ?? '').toString(),
      'snowlumaDir': dir,
    };
  }

  /// 拉起 SnowLuma，等 5099 监听。返回日志路径与是否起来了。
  ///
  /// 用 `cmd /c ... >> log 2>&1` 起，因为 Dart 的 `Process.start` 在
  /// detached 模式不收 stdout/stderr 参数；而首次启动的初始凭据只打在
  /// 输出里，别的路子拿不到。
  Future<({String logPath, bool up})> _launch(String dir) async {
    final logDir = Directory(dir + Platform.pathSeparator + 'logs');
    final logFile =
        File(logDir.path + Platform.pathSeparator + 'oneclick-launch.log');
    try {
      logDir.createSync(recursive: true);
    } catch (_) {
      return (logPath: '', up: false);
    }
    final nodePath = File(dir + Platform.pathSeparator + 'node.exe').path;
    final entryPath = File(dir + Platform.pathSeparator + 'index.mjs').path;
    final cmd = 'cd /d "' +
        dir +
        '" && "' +
        nodePath +
        '" "' +
        entryPath +
        '" >> "' +
        logFile.path +
        '" 2>&1';
    try {
      await Process.start(
        'cmd',
        ['/c', cmd],
        mode: ProcessStartMode.detached,
        runInShell: false,
      );
    } catch (_) {
      return (logPath: logFile.path, up: false);
    }
    for (var i = 0; i < 40; i++) {
      await Future<void>.delayed(const Duration(seconds: 1));
      if (await _transport.webuiAlive()) return (logPath: logFile.path, up: true);
    }
    return (logPath: logFile.path, up: false);
  }

  /// 令牌：显式给的优先，其次本机存的，最后从首次启动日志里抓初始令牌。
  /// 每个候选都先按「会话令牌」试（`/api/auth/state`），不通再按「访问密码」
  /// 换会话令牌——与 oneclick 脚本同一条路径，避免两边判据漂移。
  Future<String> _resolveToken(String dir, String? given) async {
    final tokenFile = File(dir +
        Platform.pathSeparator +
        'config' +
        Platform.pathSeparator +
        '.oneclick-token');

    Future<String?> tryCandidate(String candidate) async {
      final c = candidate.trim();
      if (c.isEmpty) return null;
      if (await _transport.authState(c)) return c;
      return await _transport.webuiLogin(password: c);
    }

    final explicit = given?.trim() ?? '';
    if (explicit.isNotEmpty) {
      return (await tryCandidate(explicit)) ?? '';
    }
    if (tokenFile.existsSync()) {
      final saved = tokenFile.readAsStringSync().trim();
      if (saved.isNotEmpty) {
        final t = await tryCandidate(saved);
        if (t != null) return t;
      }
    }
    // 首次启动的初始凭据只打在启动输出里，抓一次存本机，之后不再依赖日志。
    final logFile = File(dir +
        Platform.pathSeparator +
        'logs' +
        Platform.pathSeparator +
        'oneclick-launch.log');
    if (logFile.existsSync()) {
      final raw = logFile.readAsStringSync();
      final m =
          RegExp(r'initial credentials: user=admin password=(\S+)').firstMatch(raw);
      if (m != null) {
        final pwd = m.group(1)!;
        try {
          tokenFile.parent.createSync(recursive: true);
          tokenFile.writeAsStringSync(pwd, flush: true);
        } catch (_) {}
        final t = await tryCandidate(pwd);
        if (t != null) return t;
      }
    }
    return '';
  }

  Future<bool> _waitOnline(String token, String uin) async {
    final waitMs = _testOnlineWaitMs ?? 90000;
    final deadline = DateTime.now().add(Duration(milliseconds: waitMs));
    while (DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(seconds: 3));
      final list = await _transport.processes(token);
      for (final p in list) {
        final acc = p['account'];
        if (acc is Map &&
            (acc['uin'] ?? '').toString() == uin &&
            (p['status'] ?? '').toString() == 'online') {
          return true;
        }
      }
    }
    return false;
  }

  Map<String, dynamic> _fail(int code, String message, String stage, String dir) => {
        'ok': false,
        'code': code,
        'message': message,
        'stage': stage,
        'uin': '',
        'nickname': '',
        'snowlumaDir': dir,
      };

  // ---------------------------------------------------------------- 凭据

  File _credFile() {
    final base = _testAppDir ??
        ((Platform.environment['APPDATA'] ??
                Platform.environment['USERPROFILE'] ??
                '.') +
            Platform.pathSeparator +
            '大肥鱼');
    return File(base + Platform.pathSeparator + 'protocol_credential.json');
  }

  Map<String, dynamic> _readCred() {
    try {
      final f = _credFile();
      if (f.existsSync()) {
        final raw = jsonDecode(f.readAsStringSync());
        if (raw is Map) return Map<String, dynamic>.from(raw);
      }
    } catch (_) {}
    return <String, dynamic>{};
  }

  void _writeCred(Map<String, dynamic> data) {
    final f = _credFile();
    f.parent.createSync(recursive: true);
    f.writeAsStringSync(const JsonEncoder.withIndent('  ').convert(data),
        flush: true);
    if (Platform.isWindows) {
      try {
        final user = Platform.environment['USERNAME'] ?? '';
        if (user.isNotEmpty) {
          Process.runSync(
              'icacls', [f.path, '/inheritance:r', '/grant:r', '$user:(R,W)']);
        }
      } catch (_) {}
    }
  }

  /// 存 QQ 密码：DPAPI 加密后只落密文 + 凭据引用，明文不落盘、不写日志。
  Future<Map<String, dynamic>> saveCredential(String password) async {
    final plain = password.trim();
    if (plain.isEmpty) {
      return {'ok': false, 'error': '密码是空的'};
    }
    final blob = await _codec.protect(plain);
    final now = DateTime.now().toUtc().toIso8601String();
    _writeCred({
      'version': 1,
      'algorithm': 'DPAPI',
      'createdAt': now,
      'blob': blob,
    });
    // 只回引用，不回密文、更不回明文。
    return {
      'ok': true,
      'hasCredential': true,
      'algorithm': 'DPAPI',
      'createdAt': now,
      'blobLength': blob.length,
    };
  }

  /// 凭据状态：只给「有没有 / 什么时候存的 / 什么算法」，不给内容。
  Map<String, dynamic> credentialStatus() {
    final c = _readCred();
    final blob = (c['blob'] ?? '').toString();
    return {
      'ok': true,
      'hasCredential': blob.isNotEmpty,
      'algorithm': (c['algorithm'] ?? 'DPAPI').toString(),
      'createdAt': (c['createdAt'] ?? '').toString(),
    };
  }

  /// 清掉凭据引用（只删引用，不动 QQ 本身）。
  Map<String, dynamic> clearCredential() {
    try {
      final f = _credFile();
      if (f.existsSync()) f.deleteSync();
    } catch (_) {}
    return {'ok': true, 'hasCredential': false};
  }

  /// 仅供测试/自检：把存的凭据解回来核对。
  /// 生产流程不调用——登录不由 App 代做。
  Future<String?> readCredentialForCheck() async {
    final blob = (_readCred()['blob'] ?? '').toString();
    if (blob.isEmpty) return null;
    return _codec.unprotect(blob);
  }
}

ProtocolEndpoint createProtocolEndpoint({
  ProtocolTransport? transport,
  CredentialCodec? codec,
}) =>
    ProtocolEndpoint(transport: transport, codec: codec);
