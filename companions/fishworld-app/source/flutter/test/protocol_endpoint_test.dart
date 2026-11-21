import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/desktop/protocol_endpoint.dart';

// ignore_for_file: prefer_interpolation_to_compose_strings

/// 假传输层：不碰真端口，按测试预设回答。
class _FakeTransport implements ProtocolTransport {
  bool webuiUp = false;
  bool authOk = true;
  String? loginToken;
  List<Map<String, dynamic>> procs = const [];
  bool loadOk = true;
  Map<String, dynamic>? loginInfo;
  bool port3000 = false;
  bool port3001 = false;
  final List<String> calls = <String>[];

  @override
  Future<bool> webuiAlive() async {
    calls.add('webuiAlive');
    return webuiUp;
  }

  @override
  Future<String?> webuiLogin({required String password}) async {
    calls.add('webuiLogin');
    return loginToken;
  }

  @override
  Future<bool> authState(String token) async {
    calls.add('authState');
    return authOk;
  }

  @override
  Future<List<Map<String, dynamic>>> processes(String token) async {
    calls.add('processes');
    return procs;
  }

  @override
  Future<bool> loadProcess(String token, int pid) async {
    calls.add('loadProcess');
    return loadOk;
  }

  @override
  Future<Map<String, dynamic>?> onebotLoginInfo() async {
    calls.add('onebotLoginInfo');
    return loginInfo;
  }

  @override
  Future<bool> portListening(int port) async {
    calls.add('portListening:' + port.toString());
    return port == 3000 ? port3000 : port3001;
  }
}

/// 假编解码：可逆，但密文里不含明文，用来验「落盘不见明文」。
class _FakeCodec implements CredentialCodec {
  @override
  Future<String> protect(String plain) async => 'enc::' + base64Encode(utf8.encode(plain));

  @override
  Future<String> unprotect(String blob) async =>
      utf8.decode(base64Decode(blob.replaceFirst('enc::', '')));
}

Future<String> _makeSnowlumaDir() async {
  final d = await Directory.systemTemp.createTemp('snow-');
  await File(d.path + Platform.pathSeparator + 'node.exe').writeAsString('');
  await File(d.path + Platform.pathSeparator + 'index.mjs').writeAsString('');
  // 本机存过的访问令牌：真实安装里由首次启动日志抓出来存这儿。
  final cfg = Directory(d.path + Platform.pathSeparator + 'config');
  await cfg.create(recursive: true);
  await File(cfg.path + Platform.pathSeparator + '.oneclick-token')
      .writeAsString('saved-token');
  return d.path;
}

void main() {
  late Directory tmp;
  late String snowDir;

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('proto-');
    snowDir = await _makeSnowlumaDir();
    useProtocolDirForTest(snowDir);
    useProtocolAppDirForTest(tmp.path);
    useProtocolOnlineWaitMsForTest(null);
  });

  tearDown(() async {
    useProtocolDirForTest(null);
    useProtocolAppDirForTest(null);
    useProtocolOnlineWaitMsForTest(null);
    await tmp.delete(recursive: true);
    await Directory(snowDir).delete(recursive: true);
  });

  // ------------------------------------------------------------ 检测

  test('检测：目录齐、端口在、已登录 ⇒ 四步全 ok', () async {
    final t = _FakeTransport()
      ..webuiUp = true
      ..port3000 = true
      ..port3001 = true
      ..loginInfo = {'user_id': '457310173', 'nickname': '鱼'};
    final r = await ProtocolEndpoint(transport: t).detect();
    expect(r['usable'], isTrue);
    expect(r['webui'], isTrue);
    expect(r['onebotHttp'], isTrue);
    expect(r['onebotWs'], isTrue);
    expect(r['logged'], isTrue);
    final steps = r['steps'] as List;
    expect(steps.length, 4);
    expect(steps.every((e) => (e as Map)['ok'] == true), isTrue);
  });

  test('检测：找不到协议端目录 ⇒ 目录那步红，其余照实报', () async {
    useProtocolDirForTest('');
    final t = _FakeTransport()..webuiUp = true;
    final r = await ProtocolEndpoint(transport: t).detect();
    expect(r['usable'], isFalse);
    final steps = r['steps'] as List;
    final dirStep = steps.first as Map;
    expect(dirStep['key'], 'dir');
    expect(dirStep['ok'], isFalse);
    // 后面几步不能因为目录没了就假绿。
    expect(steps.length, 4);
  });

  test('检测：没登录 ⇒ login 步红', () async {
    final t = _FakeTransport()..webuiUp = true;
    final r = await ProtocolEndpoint(transport: t).detect();
    final steps = r['steps'] as List;
    final loginStep = steps.last as Map;
    expect(loginStep['key'], 'login');
    expect(loginStep['ok'], isFalse);
  });

  // ------------------------------------------------------------ 一键

  test('一键：已在跑 + 进程在线 + uin 对得上 ⇒ code 0，且不再注入', () async {
    final t = _FakeTransport()
      ..webuiUp = true
      ..loginToken = 'tok'
      ..procs = [
        {'pid': 4242, 'status': 'online', 'account': {'uin': '457310173'}},
      ]
      ..loginInfo = {'user_id': '457310173', 'nickname': '鱼'};
    final r = await ProtocolEndpoint(transport: t).oneClick();
    expect(r['ok'], isTrue);
    expect(r['code'], codeOk);
    expect(r['uin'], '457310173');
    expect(r['nickname'], '鱼');
    expect(t.calls, isNot(contains('loadProcess')));
  });

  test('一键：不在跑 ⇒ 先注入，等一轮后上线', () async {
    useProtocolOnlineWaitMsForTest(6000);
    final t = _TwoPhaseTransport();
    final r = await ProtocolEndpoint(transport: t).oneClick();
    expect(r['ok'], isTrue);
    expect(r['code'], codeOk);
    expect(t.calls, contains('loadProcess'));
  });

  test('一键：找不到协议端 ⇒ code 2', () async {
    useProtocolDirForTest('');
    final r = await ProtocolEndpoint(transport: _FakeTransport()).oneClick();
    expect(r['ok'], isFalse);
    expect(r['code'], codeNoSnowluma);
  });

  test('一键：没有可注入的 QQ ⇒ code 5', () async {
    final t = _FakeTransport()..webuiUp = true..loginToken = 'tok'..procs = const [];
    final r = await ProtocolEndpoint(transport: t).oneClick();
    expect(r['ok'], isFalse);
    expect(r['code'], codeNoQqProcess);
  });

  test('一键：指定 uin 没找到 ⇒ code 5，且消息里带 uin', () async {
    final t = _FakeTransport()
      ..webuiUp = true
      ..loginToken = 'tok'
      ..procs = [{'pid': 1, 'status': 'online', 'account': {'uin': '111'}}];
    final r = await ProtocolEndpoint(transport: t).oneClick(uin: '999');
    expect(r['ok'], isFalse);
    expect(r['code'], codeNoQqProcess);
    expect(r['message'], contains('999'));
  });

  test('一键：注入失败 ⇒ code 3', () async {
    final t = _FakeTransport()
      ..webuiUp = true
      ..loginToken = 'tok'
      ..loadOk = false
      ..procs = [{'pid': 7, 'status': 'waiting', 'account': {'uin': '457310173'}}];
    final r = await ProtocolEndpoint(transport: t).oneClick();
    expect(r['ok'], isFalse);
    expect(r['code'], codeNotStarted);
    expect(r['stage'], 'inject');
  });

  test('一键：等不到上线 ⇒ code 6', () async {
    useProtocolOnlineWaitMsForTest(0);
    final r = await ProtocolEndpoint(transport: _NeverOnlineTransport()).oneClick();
    expect(r['ok'], isFalse);
    expect(r['code'], codeNotOnline);
    expect(r['stage'], 'online');
  });

  test('一键：OneBot 回的账号对不上 ⇒ code 6（不假成功）', () async {
    final t = _FakeTransport()
      ..webuiUp = true
      ..loginToken = 'tok'
      ..procs = [{'pid': 7, 'status': 'online', 'account': {'uin': '457310173'}}]
      ..loginInfo = {'user_id': '888888888'};
    final r = await ProtocolEndpoint(transport: t).oneClick();
    expect(r['ok'], isFalse);
    expect(r['code'], codeNotOnline);
    expect(r['stage'], 'verify');
  });

  test('一键：拿不到 WebUI 令牌 ⇒ code 4', () async {
    final t = _FakeTransport()..webuiUp = true..authOk = false..loginToken = null;
    final r = await ProtocolEndpoint(transport: t).oneClick();
    expect(r['ok'], isFalse);
    expect(r['code'], codeAuthFailed);
    expect(r['stage'], 'token');
  });

  // ------------------------------------------------------------ 凭据

  test('凭据：存进去只落密文，文件里不见明文', () async {
    final ep = ProtocolEndpoint(codec: _FakeCodec());
    final r = await ep.saveCredential('我的QQ密码-中文');
    expect(r['ok'], isTrue);
    final raw =
        await File(tmp.path + Platform.pathSeparator + 'protocol_credential.json').readAsString();
    expect(raw, isNot(contains('我的QQ密码')));
    expect(raw, contains('DPAPI'));
    final st = ep.credentialStatus();
    expect(st['hasCredential'], isTrue);
    // 状态里不回密文，更不回明文。
    expect(jsonEncode(st), isNot(contains('enc::')));
    expect(jsonEncode(st), isNot(contains('我的QQ密码')));
  });

  test('凭据：空密码不存', () async {
    final ep = ProtocolEndpoint(codec: _FakeCodec());
    final r = await ep.saveCredential('   ');
    expect(r['ok'], isFalse);
    expect(ep.credentialStatus()['hasCredential'], isFalse);
  });

  test('凭据：清掉后引用就没了', () async {
    final ep = ProtocolEndpoint(codec: _FakeCodec());
    await ep.saveCredential('abc');
    expect(ep.credentialStatus()['hasCredential'], isTrue);
    final r = ep.clearCredential();
    expect(r['ok'], isTrue);
    expect(ep.credentialStatus()['hasCredential'], isFalse);
  });

  test('凭据：存的能解回来（自检用，生产不代登录）', () async {
    final ep = ProtocolEndpoint(codec: _FakeCodec());
    await ep.saveCredential('自检密码');
    expect(await ep.readCredentialForCheck(), '自检密码');
  });

  // ------------------------------------------------------------ 找 QQ / 拉起

  test('找 QQ：本机有 QQNT 就给出 .exe 路径，没有就返回空串（不编路径）', () async {
    final ep = ProtocolEndpoint();
    final path = ep.findQq();
    if (path.isEmpty) {
      // 没装 QQ 的机器：必须如实返回空，不能编一个看起来对的路径。
      expect(path, '');
    } else {
      expect(path, endsWith('.exe'));
      expect(File(path).existsSync(), isTrue, reason: '给出的路径必须真实存在');
    }
  });

  test('拉起 QQ：找不到本体时 ok=false 且给一句人话，不假成功', () async {
    // 测试模式下不真启动；这里只验「失败时如实报」的分支形状。
    useProtocolSkipQqLaunchForTest(true);
    final ep = ProtocolEndpoint();
    final r = await ep.launchQq();
    // 真装了 QQ 的机器走「不真启动」分支；没装的走「找不到」分支——两种都不许假成功。
    if (r['ok'] == true) {
      expect(r['launched'], isFalse);
    } else {
      expect((r['error'] ?? '').toString(), isNotEmpty);
    }
    useProtocolSkipQqLaunchForTest(false);
  });
}

/// 第一次 processes 还在等，注入后再问就在线。
class _TwoPhaseTransport extends _FakeTransport {
  var n = 0;
  _TwoPhaseTransport() {
    webuiUp = true;
    loginToken = 'tok';
    loginInfo = {'user_id': '457310173', 'nickname': '鱼'};
  }

  @override
  Future<List<Map<String, dynamic>>> processes(String token) async {
    n++;
    final waiting = <Map<String, dynamic>>[
      {'pid': 4242, 'status': 'waiting', 'account': {'uin': '457310173'}},
    ];
    final online = <Map<String, dynamic>>[
      {'pid': 4242, 'status': 'online', 'account': {'uin': '457310173'}},
    ];
    return n <= 1 ? waiting : online;
  }
}

/// 永远等不到上线。
class _NeverOnlineTransport extends _FakeTransport {
  _NeverOnlineTransport() {
    webuiUp = true;
    loginToken = 'tok';
    procs = const [
      {'pid': 7, 'status': 'waiting', 'account': {'uin': '457310173'}},
    ];
  }
}
