import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/services.dart';

import '../data/model_store_io.dart';
import 'meme_store.dart';
import 'people_store.dart';
import 'qq_reply_rules.dart';
import 'send_fence.dart';
import 'sha256.dart';
import '../version.dart';

/// 桌面版独立收答：不依赖 DSH，只靠 OneBot WS(3001) + DeepSeek API。
/// Web 端走 bridge，不加载本文件（见 qq_service_stub.dart）。
bool _started = false;
WebSocket? _ws;
Timer? _retryTimer;
Timer? _pollTimer;
Timer? _heartbeatTimer;
/// 启动后 3 秒的兜底心跳（约定：重启 3 秒内必须有一次）。
Timer? _heartbeatBootTimer;
int _failures = 0;
bool _polling = false;
final Set<String> _seen = <String>{};
final Set<String> _processing = <String>{};
// 连发合并：同一个人 3 秒内的多条并成一个问题，只答一次。
final Map<String, List<String>> _burst = <String, List<String>>{};
final Map<String, Timer> _burstTimer = <String, Timer>{};
const int _burstWindowMs = 3000;
DateTime? _startedAt;
Map<String, dynamic> _model = <String, dynamic>{};
String _persona = '';
String _personaPath = '';
String _personaSha = '';
DateTime? _personaMtime;
String _memoryBrief = '';
final Map<String, List<Map<String, String>>> _ctx =
    <String, List<Map<String, String>>>{};
final Map<String, int> _seq = <String, int>{};
PeopleStore? _people;
List<String> _confirmedMemes = <String>[];
List<String> _pendingMemes = <String>[];
String _sessionConflictText = '';
bool _deliveryBlocked = false;
final StreamController<Map<String, String>> _chatEvents = StreamController<Map<String, String>>.broadcast();

String _appDirPath() {
  final appData = Platform.environment['APPDATA'];
  final home = Platform.environment['HOME'] ??
      Platform.environment['USERPROFILE'] ??
      '.';
  return ((appData != null && appData.isNotEmpty) ? appData : home) +
      Platform.pathSeparator +
      '大肥鱼';
}

File _appFile(String name) =>
    File(_appDirPath() + Platform.pathSeparator + name);

void _log(String msg) {
  try {
    final f = _appFile('qq_agent.log');
    f.parent.createSync(recursive: true);
    f.writeAsStringSync(
        '[' + DateTime.now().toIso8601String() + '] ' + msg + '\n',
        mode: FileMode.append,
        flush: true);
  } catch (_) {}
}

String _readText(File f, [String fallback = '']) {
  try {
    return f.existsSync() ? f.readAsStringSync() : fallback;
  } catch (_) {
    return fallback;
  }
}

Map<String, dynamic> _jsonMap(String raw) {
  try {
    final v = jsonDecode(raw);
    return v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};
  } catch (_) {
    return <String, dynamic>{};
  }
}

Directory? _worldRoot() {
  final candidates = <String>[
    Platform.environment['FISH_WORLD_ROOT'] ?? '',
    _appDirPath() + Platform.pathSeparator + '鱼的世界',
    'D:' + Platform.pathSeparator + '大肥鱼' + Platform.pathSeparator + '鱼的世界',
    'E:' + Platform.pathSeparator + 'WhaleGirl' + Platform.pathSeparator + '鱼的世界',
  ];
  for (final c in candidates) {
    if (c.trim().isNotEmpty && Directory(c).existsSync()) return Directory(c);
  }
  return null;
}

Set<String> _whitelist() {
  final override = (Platform.environment['FISH_QQ_WHITELIST'] ?? '').trim();
  if (override.isNotEmpty) {
    return override
        .split(',')
        .map((x) => x.trim())
        .where((x) => x.isNotEmpty)
        .toSet();
  }
  final root = _worldRoot();
  if (root == null) return <String>{};
  final f = File(root.path +
      Platform.pathSeparator +
      '鱼的关系' +
      Platform.pathSeparator +
      'chats.json');
  final raw = _jsonMap(_readText(f));
  final items = raw['items'] is List ? raw['items'] as List : const [];
  final out = <String>{};
  for (final e in items) {
    if (e is! Map) continue;
    if (e['enabled'] == false) continue;
    var key = (e['chatKey'] ?? '').toString();
    if (key.isEmpty) {
      final kind = (e['kind'] ?? 'group').toString();
      final id = (e['id'] ?? '').toString();
      if (id.isNotEmpty) key = kind + ':' + id;
    }
    if ((key.startsWith('private:') || key.startsWith('group:')) &&
        key.substring(key.indexOf(':') + 1).isNotEmpty) out.add(key);
  }
  // 主人私聊永远在白名单里：主人是唯一被允许直接跟鱼说话的人，
  // 把他挂在 chats.json 的 enabled 上会让“关掉一个群”顺手把主人也关掉。
  final owner = _ownerQQ();
  if (owner.isNotEmpty) out.add('private:' + owner);
  return out;
}

String _ownerQQ() {
  try {
    final cfg = _jsonMap(_readText(_appFile('qq_config.json')));
    final v = (cfg['ownerQQ'] ?? '').toString().trim();
    if (v.isNotEmpty) return v;
  } catch (_) {}
  return '';
}

Map<String, dynamic>? _onebotWs(String uin) {
  final dirs = <String>[
    Platform.environment['SNOWLUMA_DIR'] ?? '',
    'D:' +
        Platform.pathSeparator +
        'deepseek-qq' +
        Platform.pathSeparator +
        'snowluma',
  ].where((x) => x.isNotEmpty);
  for (final base in dirs) {
    final cfgDir = Directory(base + Platform.pathSeparator + 'config');
    if (!cfgDir.existsSync()) continue;
    for (final ent in cfgDir.listSync()) {
      if (ent is! File) continue;
      final name = ent.path.split(Platform.pathSeparator).last;
      if (!name.startsWith('onebot_')) continue;
      if (uin.isNotEmpty && !name.startsWith('onebot_' + uin)) continue;
      final raw = _jsonMap(_readText(ent));
      final networks = raw['networks'];
      final servers = networks is Map ? networks['wsServers'] : null;
      if (servers is! List) continue;
      for (final s in servers) {
        if (s is! Map) continue;
        final wantPort =
            int.tryParse(Platform.environment['FISH_QQ_WS_PORT'] ?? '') ?? 3001;
        final port = wantPort;
        final token = (s['accessToken'] ?? '').toString();
        if (token.isNotEmpty) return {'token': token, 'port': port};
      }
    }
  }
  return null;
}

bool allowChatKey(Set<String> allow, String key) => allow.contains(key);

String _chatFromEvent(Map<String, dynamic> e) {
  final type = (e['message_type'] ?? '').toString();
  if (type == 'group') {
    final gid = (e['group_id'] ?? '').toString();
    return gid.isEmpty ? '' : 'group:' + gid;
  }
  if (type == 'private') {
    final uid = (e['user_id'] ?? '').toString();
    return uid.isEmpty ? '' : 'private:' + uid;
  }
  return '';
}

Stream<Map<String, String>> get desktopQqEvents => _chatEvents.stream;

Future<String> desktopLocalChat(String text) async {
  if (Platform.environment.containsKey('FLUTTER_TEST') &&
      !const bool.fromEnvironment('LIVE_QQ_TEST')) {
    return '（测试环境本地回复）';
  }
  if (_model.isEmpty) await _loadConfig();
  final v = text.trim();
  if (v.isEmpty) return '';
  final reply = await _answer('desktop:local', v);
  if (reply.isNotEmpty) {
    final list = _ctx['desktop:local'] ?? <Map<String, String>>[];
    list.add({'role': 'user', 'content': v});
    list.add({'role': 'assistant', 'content': reply});
    while (list.length > 12) list.removeAt(0);
    _ctx['desktop:local'] = list;
    _saveContext();
  }
  return reply;
}

String _textOf(dynamic message) {
  if (message is String) return message.trim();
  if (message is List) {
    final b = StringBuffer();
    for (final seg in message) {
      if (seg is Map && (seg['type'] ?? '') == 'text') {
        final d = seg['data'];
        if (d is Map) b.write((d['text'] ?? '').toString());
      }
    }
    return b.toString().trim();
  }
  return (message ?? '').toString().trim();
}

void _loadSeen() {
  try {
    final raw = _jsonMap(_readText(_appFile('qq_seen.json')));
    final list = raw['ids'];
    if (list is List) for (final x in list) _seen.add(x.toString());
  } catch (_) {}
}

void _saveSeen() {
  try {
    final ids = _seen.toList();
    if (ids.length > 2000) ids.removeRange(0, ids.length - 2000);
    _appFile('qq_seen.json')
        .writeAsStringSync(jsonEncode({'ids': ids}), flush: true);
  } catch (_) {}
}

Map<String, dynamic> _contextFile() =>
    _jsonMap(_readText(_appFile('qq_context.json')));

void _loadSeq() {
  final raw = _jsonMap(_readText(_appFile('qq_cursors.json')));
  for (final e in raw.entries) {
    final v = int.tryParse(e.value.toString()) ?? 0;
    if (v > 0) _seq[e.key] = v;
  }
}

void _saveSeq() {
  try {
    _appFile('qq_cursors.json')
        .writeAsStringSync(jsonEncode(_seq), flush: true);
  } catch (_) {}
}

void _loadContext() {
  final raw = _contextFile();
  for (final e in raw.entries) {
    final v = e.value;
    if (v is List) {
      _ctx[e.key] = [
        for (final x in v)
          if (x is Map)
            {
              'role': (x['role'] ?? '').toString(),
              'content': (x['content'] ?? '').toString()
            },
      ];
    }
  }
}

void _saveContext() {
  try {
    final out = <String, dynamic>{};
    for (final e in _ctx.entries) out[e.key] = e.value;
    _appFile('qq_context.json').writeAsStringSync(jsonEncode(out), flush: true);
  } catch (_) {}
}

// people.json 放在世界目录的「鱼的关系」下，和 chats.json 挨着。
void _initPeople() {
  try {
    final root = _worldRoot();
    if (root == null) return;
    final owner = _ownerQQ();
    final store = PeopleStore(File(root.path +
        Platform.pathSeparator +
        '鱼的关系' +
        Platform.pathSeparator +
        'people.json'));
    // 主人先建档：昵称默认「大星」，别名带上「主人」。
    if (owner.isNotEmpty) {
      store.seen(qqId: owner, nickname: '大星', chatKey: 'private:' + owner, isOwner: true);
    }
    _people = store;
    _log('people 已加载 ' + store.all.length.toString() + ' 人');
  } catch (e) {
    _log('people 加载失败：' + e.toString());
  }
}

// 会话冲突：一个 sessionId 同时挂在主人私聊和别处 ⇒ 报错，并在启动时拒绝投递。
// 会话只是“往哪发”，不是“谁在说话”；混用就是把别人当成主人。
void _checkSessionConflicts() {
  try {
    final store = _people;
    if (store == null) return;
    store.useSessionResolver((chatKey) {
      final root = _worldRoot();
      if (root == null) return '';
      final f = File(root.path +
          Platform.pathSeparator +
          '鱼的关系' +
          Platform.pathSeparator +
          'chats.json');
      if (!f.existsSync()) return '';
      final raw = _jsonMap(_readText(f));
      for (final e in ((raw['items'] as List?) ?? const [])) {
        if (e is! Map) continue;
        final key = (e['chatKey'] ??
                ((e['kind'] == 'private' ? 'private:' : 'group:') +
                    (e['id'] ?? '')))
            .toString();
        if (key == chatKey) return (e['sessionId'] ?? '').toString();
      }
      return '';
    });
    final conflicts = store.sessionConflicts();
    if (conflicts.isEmpty) return;
    _sessionConflictText = conflicts.map((c) => c.text).join('；');
    _log('启动报错 · ' + _sessionConflictText);
    _log('已拒绝启动投递（会话冲突）');
    _deliveryBlocked = true;
  } catch (e) {
    _log('会话冲突检查失败：' + e.toString());
  }
}

// 梗：只把 confirmed 的喂给模型；pending 的只让它「问一句这是啥」。
void _loadMemes() {
  try {
    final f = _kbFile();
    if (f == null || !f.existsSync()) return;
    final raw = _jsonMap(_readText(f));
    final items = (raw['items'] as List?) ?? const [];
    _confirmedMemes = confirmedMemeLines(items);
    _pendingMemes = pendingMemeNames(items);
    _log('梗 ' + _confirmedMemes.length.toString() + ' confirmed / ' +
        _pendingMemes.length.toString() + ' pending');
  } catch (e) {
    _log('知识库加载失败：' + e.toString());
  }
}

File? _kbFile() {
  final root = _worldRoot();
  if (root == null) return null;
  return File(root.path +
      Platform.pathSeparator +
      '鱼的记忆' +
      Platform.pathSeparator +
      '知识库.json');
}

// 收件时识别梗：命中就写一条 pending，5 分钟内落库。
void _captureMeme(String text, String chatKey, String who, String uid) {
  try {
    final f = _kbFile();
    if (f == null) return;
    // 先试语录（长文本 / 引用体 / 段子），再试短梗：转发的整段语录以前全被漏掉。
    // 短梗只认「引号里的词」和已知梗句式；「整句就是一个短词」那条跳过，
    // 否则每句 12 字以内的闲聊都会被当成梗写进知识库。
    var c = extractQuote(text);
    if (c == null) {
      final meme = extractCandidate(text);
      if (meme != null && (meme['why'] ?? '') != '整句就是一个短词') c = meme;
    }
    if (c == null) return;
    final raw = _jsonMap(_readText(f));
    final items = (raw['items'] as List?) ?? const [];
    // 已经拒绝过的别再提：findDuplicate 命中且 status=rejected 就跳过。
    final hit = findDuplicate(items, c['name']!);
    if (hit != null && (hit['status'] ?? '').toString() == 'rejected') return;
    final now = DateTime.now();
    final stamp = now.month.toString().padLeft(2, '0') +
        '-' +
        now.day.toString().padLeft(2, '0') +
        ' ' +
        now.hour.toString().padLeft(2, '0') +
        ':' +
        now.minute.toString().padLeft(2, '0');
    final source = chatKey + ' · ' + stamp + ' · ' + who + '：' + text;
    final r = addMemeCandidate(kbFile: f, candidate: c, source: source, now: now);
    if (r['ok'] == true) {
      _log('梗候选 ' + r['action'].toString() + ' ' + r['name'].toString());
      _loadMemes();
    }
  } catch (e) {
    _log('梗识别失败：' + e.toString());
  }
}

void _writeHeartbeat() {
  try {
    final f = _appFile('qq-heartbeat.json');
    f.parent.createSync(recursive: true);
    f.writeAsStringSync(jsonEncode({'at': DateTime.now().toIso8601String()}), flush: true);
  } catch (e) {
    // 不吞：心跳写不进去时，界面会显示「心跳停了」，得留个能查的原因，
    // 否则只能看到「停了」却不知道为什么。日志本身失败也不能再抛。
    try {
      _log('心跳写入失败：' + e.toString());
    } catch (_) {}
  }
}

Future<void> _loadConfig() async {
  _model = await readModelRaw() ?? <String, dynamic>{};
  _personaPath = 'D:' +
      Platform.pathSeparator +
      'DSH-home' +
      Platform.pathSeparator +
      'fish-world-personas' +
      Platform.pathSeparator +
      'default.md';
  _persona = _readText(File(_personaPath));
  if (_persona.trim().isEmpty) {
    _persona = '你是 DeepSeek 小鲸鱼，在 QQ 上和人聊天。短句、口语、不写小作文。';
    _personaSha = 'fallback';
  } else {
    _personaSha = sha256OfText(_persona);
  }
  try {
    _personaMtime = File(_personaPath).statSync().modified;
  } catch (_) {
    _personaMtime = null;
  }
  _log('人设卡 ' + _personaPath + ' sha256=' + _personaSha + ' bytes=' + _persona.length.toString());
  try {
    final raw = await rootBundle.loadString('assets/data/fish_snapshot.json');
    final snap = _jsonMap(raw);
    final mem = snap['memory'];
    final m = mem is Map ? mem['memories'] : null;
    final items = m is Map ? m['items'] : null;
    if (items is List) {
      final texts = <String>[];
      for (final x in items.take(8)) {
        if (x is Map) {
          final t = (x['text'] ?? '').toString().trim();
          if (t.isNotEmpty) texts.add('- ' + t);
        }
      }
      _memoryBrief = texts.join('\n');
    }
  } catch (_) {}
  _loadSeen();
  _loadContext();
  _loadSeq();
  _initPeople();
  _loadMemes();
  _checkSessionConflicts();
  final root = _worldRoot()?.path ?? '未找到';
  final allow = _whitelist();
  _log('v' + appVersion + ' world=' + root + ' enabledFilter=on whitelist=' + allow.length.toString());
}

Future<Map<String, dynamic>?> _postApi(String path, Map<String, Object?> body,
    {bool model = false}) async {
  final base = model
      ? ((_model['baseUrl'] ?? '').toString().trim().isEmpty
          ? 'https://api.deepseek.com'
          : (_model['baseUrl'] ?? '').toString().trim())
      : ((Platform.environment['FISH_QQ_API_BASE'] ?? '').trim().isEmpty
          ? 'http://127.0.0.1:3000'
          : Platform.environment['FISH_QQ_API_BASE']!.trim());
  final uri = Uri.parse(base + path);
  final client = HttpClient()..connectionTimeout = const Duration(seconds: 10);
  try {
    final req = await client.postUrl(uri);
    req.headers.contentType = ContentType.json;
    if (model) {
      final key = (_model['apiKey'] ?? '').toString();
      if (key.isEmpty) throw StateError('模型 Key 为空');
      req.headers.set('authorization', 'Bearer ' + key);
    }
    final payload = utf8.encode(jsonEncode(body));
    req.headers.contentLength = payload.length;
    req.add(payload);
    final res = await req.close().timeout(const Duration(seconds: 45));
    final text = await res.transform(utf8.decoder).join();
    if (res.statusCode < 200 || res.statusCode >= 300) {
      _log('API ' +
          path +
          ' HTTP ' +
          res.statusCode.toString() +
          ' ' +
          text.substring(0, math.min(300, text.length)));
      return null;
    }
    final v = jsonDecode(text);
    return v is Map ? Map<String, dynamic>.from(v) : null;
  } catch (e) {
    _log('API ' + path + ' 失败：' + e.toString());
    return null;
  } finally {
    client.close(force: true);
  }
}

List<String> _splitBubbles(String text) {
  // 生成后先合并、再切 1–3 条；两套拆分叠加会把条数翻倍（见 qq_reply_rules）。
  final byRule = splitReply(text);
  if (byRule.isNotEmpty) return byRule;
  final raw = text
      .split(RegExp(r'\n+|／+|\s+\/\s+|；|;'))
      .map((x) => x.trim())
      .where((x) => x.isNotEmpty)
      .toList();
  final out = <String>[];
  for (final part in raw) {
    if (part.length <= 120) {
      out.add(part);
      continue;
    }
    final sentences = part
        .split(RegExp(r'(?<=[。！？!?])'))
        .map((x) => x.trim())
        .where((x) => x.isNotEmpty)
        .toList();
    out.addAll(sentences.isEmpty ? [part] : sentences);
  }
  return out.take(5).toList();
}

Future<bool> _send(String chatKey, String text) async {
  // 出站闸：判据在 send_fence.dart（纯函数，和插件侧 JS 版同口径）。
  // 拦下就整条不发——不截断、不改写、不重试；只留一条代号日志，
  // 不把被拦的原文写进日志（原文进日志等于把「什么会被拦」抄一份到磁盘）。
  final fence = fenceText(text);
  if (!fence.ok) {
    _log('出站闸拦下：' + fence.reason + ' ' + chatKey);
    return false;
  }
  final parts = _splitBubbles(fence.text);
  if (parts.isEmpty) return false;
  final private = chatKey.startsWith('private:');
  final id = int.tryParse(chatKey.substring(chatKey.indexOf(':') + 1)) ?? 0;
  for (var i = 0; i < parts.length; i++) {
    final r = await _postApi(private ? '/send_private_msg' : '/send_group_msg', {
      (private ? 'user_id' : 'group_id'): id,
      'message': parts[i],
    });
    if (r == null ||
        r['status'] == 'failed' ||
        (r['retcode'] != null && r['retcode'] != 0)) {
      _log('发送失败 ' + chatKey + '：' + r.toString());
      return false;
    }
    if (i < parts.length - 1) {
      await Future<void>.delayed(Duration(milliseconds: 400 + math.Random().nextInt(500)));
    }
  }
  return true;
}

// 人设卡热加载：文件改了不用重启，下一次回答就用新卡。
// 判据是 mtime + 长度，不靠轮询整份文件。
void _refreshPersonaIfChanged() {
  if (_personaPath.isEmpty) return;
  try {
    final f = File(_personaPath);
    if (!f.existsSync()) return;
    final st = f.statSync();
    if (_personaMtime != null &&
        st.modified == _personaMtime &&
        _personaSha != 'fallback') return;
    final text = _readText(f);
    if (text.trim().isEmpty) return;
    _persona = text;
    _personaSha = sha256OfText(text);
    _personaMtime = st.modified;
    _log('人设卡已重载 sha256=' + _personaSha + ' bytes=' + text.length.toString());
  } catch (e) {
    _log('人设卡重载失败：' + e.toString());
  }
}

String _ownerNameLine() {
  final qq = _ownerQQ();
  if (qq.isEmpty) return '';
  return '\n\n【谁是谁】主人 QQ 是 ' + qq + '，昵称「大星」。「大星」就是主人本人，不是第三个人；'
      '被问「大星是谁」就回答是他自己（你啊 / 你自己），不要说不认识。';
}

String _memeLine() {
  if (_confirmedMemes.isEmpty && _pendingMemes.isEmpty) return '';
  final sb = StringBuffer();
  if (_confirmedMemes.isNotEmpty) {
    sb.write('\n\n【你会的梗】' +
        _confirmedMemes.take(8).join('；') +
        '。用到就自然用，别硬塞。');
  }
  if (_pendingMemes.isNotEmpty) {
    sb.write('\n【还没确认的梗】' +
        _pendingMemes.take(6).join('、') +
        '——这些你还没弄懂，别人提起来就问一句「这啥」，别装懂，也别用。');
  }
  return sb.toString();
}

String _seriousLine(String incoming) {
  if (!isSeriousTopic(incoming)) return '';
  return '\n\n【认真模式】这一条涉及法律/赔偿/医疗/工资/合同这类事：结论优先、短句、'
      '不玩梗、不嘲讽、不抖机灵，不拿「被包养」之类开玩笑；不确定的就说不知道，别编。';
}

Future<String> _answerOnce(String chatKey, String incoming,
    {String historyTail = '', String speakerQQ = '', String speakerName = '', String speakerChatKey = '', String extra = ''}) async {
  _refreshPersonaIfChanged();
  final history = _ctx[chatKey] ?? <Map<String, String>>[];
  final messages = <Map<String, String>>[
    {
      'role': 'system',
      'content': _persona +
          _ownerNameLine() +
          (_people == null || speakerQQ.isEmpty
              ? _ownerNameLine()
              : _people!.promptFor(speakerQQ,
                  nickname: speakerName, chatKey: speakerChatKey)) +
          _seriousLine(incoming + historyTail) +
          _memeLine() +
          '\n\n【你在 QQ 上直接聊天】直接说你要说的话，短句，不要解释你怎么想的。'
              '一条回复只说一件事，最多三句；不要列清单、不要分点。' +
          (_memoryBrief.isEmpty ? '' : '\n\n【你记得的事】\n' + _memoryBrief) +
          extra
    },
    ...history,
    {'role': 'user', 'content': incoming},
  ];
  final base = (_model['baseUrl'] ?? '').toString().trim();
  final url = base.isEmpty ? 'https://api.deepseek.com' : base;
  final path = url.endsWith('/chat/completions') ? '' : '/chat/completions';
  final r = await _postApi(
      path,
      {
        'model': (_model['model'] ?? '').toString().isEmpty
            ? 'deepseek-chat'
            : _model['model'],
        'messages': messages,
        'temperature': 1.0,
        'max_tokens': 500,
      },
      model: true);
  if (r == null) return '';
  final choices = r['choices'];
  if (choices is! List || choices.isEmpty) return '';
  final first = choices.first;
  final msg = first is Map ? first['message'] : null;
  final text = msg is Map ? (msg['content'] ?? '').toString().trim() : '';
  if (text.isEmpty) return '';
  final bad = contradictionHint(text);
  if (bad != null) {
    _log('回复自我矛盾（' + bad + '），只保留最后一句立场：' + text);
    final parts = splitReply(text);
    return parts.isEmpty ? text : parts.last;
  }
  return text;
}

// 不合格就重写一次：矛盾（同一段里既认得主人又说不知道这是谁）直接打回。
Future<String> _answer(String chatKey, String incoming,
    {String historyTail = '', String speakerQQ = '', String speakerName = ''}) async {
  final first = await _answerOnce(chatKey, incoming,
      historyTail: historyTail,
      speakerQQ: speakerQQ,
      speakerName: speakerName,
      speakerChatKey: chatKey);
  if (first.isEmpty) return first;
  final why = _replyProblem(first, speakerQQ: speakerQQ, speakerName: speakerName);
  if (why == null) return first;
  _log('回复不合格（' + why + '），重写一次：' + first);
  final again = await _answerOnce(chatKey, incoming,
      historyTail: historyTail,
      speakerQQ: speakerQQ,
      speakerName: speakerName,
      speakerChatKey: chatKey,
      extra: '\n\n【上一版不合格】原因：' + why + '。重写：不要说没印象、不要把主人当别人。');
  if (again.isEmpty) {
    final parts = splitReply(first);
    return parts.isEmpty ? first : parts.last;
  }
  if (_replyProblem(again, speakerQQ: speakerQQ, speakerName: speakerName) == null) {
    return again;
  }
  _log('重写后仍不合格，只保留后一句立场：' + again);
  final parts = splitReply(again);
  return parts.isEmpty ? again : parts.last;
}

// 判「回复不合格」：P0-2 的自我矛盾 + 这条单的“认得主人却不认识这个名字”。
String? _replyProblem(String reply,
    {String speakerQQ = '', String speakerName = ''}) {
  final clash = contradictionHint(reply);
  if (clash != null) return '同一概念既肯定又否认（' + clash + '）';
  final looksClueless = namesToSearch.any((w) => reply.contains(w));
  final looksKnown = reply.contains('主人') || (speakerName.isNotEmpty && reply.contains(speakerName));
  final isOwner = speakerQQ.isNotEmpty && _people?.ownerQQ == speakerQQ;
  if (isOwner && looksClueless && looksKnown) {
    return '既认得主人，又说不知道这个名字';
  }
  return null;
}


Future<void> _handleMessage(Map<String, dynamic> e) async {
  final chatKey = _chatFromEvent(e);
  if (_deliveryBlocked) {
    _log('会话冲突未解决，拒收：' + chatKey);
    return;
  }
  if (chatKey.isEmpty || !allowChatKey(_whitelist(), chatKey)) return;
  final selfId = (e['self_id'] ?? '').toString();
  final sender = e['sender'];
  final uid = sender is Map
      ? (sender['user_id'] ?? '').toString()
      : (e['user_id'] ?? '').toString();
  if (selfId.isNotEmpty && uid == selfId) return;
  final id = (e['message_id'] ?? e['message_seq'] ?? '').toString();
  final seq = int.tryParse((e['message_seq'] ?? 0).toString()) ?? 0;
  if (seq > (_seq[chatKey] ?? 0)) {
    _seq[chatKey] = seq;
    _saveSeq();
  }
  if (id.isEmpty || _seen.contains(id) || _processing.contains(id)) return;
  _processing.add(id);
  final text = _textOf(e['message'] ?? e['raw_message']);
  if (text.isEmpty) return;
  final who = sender is Map
      ? (sender['nickname'] ?? sender['card'] ?? '').toString()
      : '';
  _log('收到 ' + chatKey + ' ' + who + '：' + text);
  _captureMeme(text, chatKey, who, uid);
  _chatEvents.add({'kind': 'in', 'text': text});

  // 见到人就建档：昵称、在哪见过、是不是主人。
  final isOwner = uid.isNotEmpty && uid == _ownerQQ();
  try {
    _people?.seen(
      qqId: uid,
      nickname: who,
      chatKey: chatKey,
      isOwner: isOwner,
    );
  } catch (e) {
    _log('people 建档失败：' + e.toString());
  }

  // 连发合并：先攒进 3 秒窗口，窗口结束才答一次。
  final burstKey = chatKey + '|' + uid;
  _burst.putIfAbsent(burstKey, () => <String>[]).add(text);
  _burstTimer[burstKey]?.cancel();
  _burstTimer[burstKey] = Timer(const Duration(milliseconds: _burstWindowMs), () {
    unawaited(_flushBurst(burstKey, chatKey, uid, who));
  });
  _processing.remove(id);
}

Future<void> _flushBurst(
    String burstKey, String chatKey, String uid, String who) async {
  _burstTimer.remove(burstKey);
  final parts = _burst.remove(burstKey) ?? const <String>[];
  if (parts.isEmpty) return;
  if (parts.length > 1) _log('连发合并 ' + parts.length.toString() + ' 条：' + parts.join(' / '));
  final text = parts.join('\n');
  final reply = await _answer(chatKey, (who.isEmpty ? '' : who + '：') + text,
      historyTail: text, speakerQQ: uid, speakerName: who);
  if (reply.isEmpty) {
    _log('回复为空 ' + chatKey);
    return;
  }
  final list = _ctx[chatKey] ?? <Map<String, String>>[];
  list.add({'role': 'user', 'content': text});
  list.add({'role': 'assistant', 'content': reply});
  while (list.length > 12) list.removeAt(0);
  _ctx[chatKey] = list;
  _saveContext();
  final sent = await _send(chatKey, reply);
  if (sent) _chatEvents.add({'kind': 'out', 'text': reply});
  if (sent) {
    _seen.add(chatKey + '|' + DateTime.now().millisecondsSinceEpoch.toString());
    _saveSeen();
    // 按人记一条：跨会话合并靠这个，不靠会话上下文。
    final said = text.trim();
    if (said.isNotEmpty && uid.isNotEmpty) {
      _people?.addFact(uid, said.length > 40 ? said.substring(0, 40) : said);
    }
  }
}

void _scheduleReconnect() {
  if (_polling) return;
  _retryTimer?.cancel();
  final seconds = math.min(30, 1 << math.min(5, _failures));
  _log('WS 断开，' +
      seconds.toString() +
      ' 秒后重连（第 ' +
      _failures.toString() +
      ' 次）');
  _retryTimer = Timer(Duration(seconds: seconds), () {
    _failures += 1;
    if (_failures >= 5) {
      _startPolling();
    } else {
      unawaited(_connect());
    }
  });
}

Future<void> _connect() async {
  if (_polling) return;
  final login = await _postApi('/get_login_info', {});
  String loginUser = '';
  final ld = login?['data'];
  if (ld is Map) loginUser = (ld['user_id'] ?? '').toString();
  _log('login uin=' + loginUser);
  final cfg = _onebotWs(loginUser);
  if (cfg == null) {
    _log('找不到 onebot ws 配置，继续重试');
    _scheduleReconnect();
    return;
  }
  final token = cfg['token'].toString();
  final uri = Uri.parse('ws://127.0.0.1:' +
      cfg['port'].toString() +
      '/?access_token=' +
      Uri.encodeComponent(token));
  try {
    final ws = await WebSocket.connect(uri.toString(),
            headers: {'Authorization': 'Bearer ' + token})
        .timeout(const Duration(seconds: 10));
    _ws = ws;
    _failures = 0;
    _log('WS 已连接 port=' + uri.port.toString());
    ws.listen((raw) {
      try {
        final v = jsonDecode(raw.toString());
        if (v is Map && (v['post_type'] ?? '') == 'message') {
          unawaited(_handleMessage(Map<String, dynamic>.from(v)));
        }
      } catch (e) {
        _log('WS 消息解析失败：' + e.toString());
      }
    }, onDone: () {
      _log('WS 关闭');
      _ws = null;
      _scheduleReconnect();
    }, onError: (Object e) {
      _log('WS 错误：' + e.toString());
      _ws = null;
      _scheduleReconnect();
    }, cancelOnError: true);
  } catch (e) {
    _log('WS 连接失败：' + e.toString());
    _scheduleReconnect();
  }
}

void _startPolling() {
  if (_polling) return;
  _polling = true;
  _retryTimer?.cancel();
  _log('WS 连续失败，切轮询兜底（每 3 秒）');
  _pollTimer?.cancel();
  _pollTimer =
      Timer.periodic(const Duration(seconds: 3), (_) => unawaited(_pollOnce()));
}

Future<void> _pollOnce() async {
  final chats = _whitelist().toList();
  for (final key in chats) {
    final private = key.startsWith('private:');
    final id = int.tryParse(key.substring(key.indexOf(':') + 1)) ?? 0;
    if (id == 0) continue;
    final cursor = _seq[key] ?? 0;
    final body = <String, Object?>{'count': 20};
    body[(private ? 'user_id' : 'group_id')] = id;
    if (cursor > 0) body['message_seq'] = cursor;
    final r = await _postApi(
        private ? '/get_friend_msg_history' : '/get_group_msg_history', body);
    final data = r?['data'];
    final list = data is Map ? data['messages'] : data;
    if (list is! List) continue;
    for (final item in list) {
      if (item is! Map) continue;
      final seq = int.tryParse((item['message_seq'] ?? 0).toString()) ?? 0;
      if (seq > 0 && seq <= (_seq[key] ?? 0)) continue;
      final time = int.tryParse((item['time'] ?? 0).toString()) ?? 0;
      if (_startedAt != null &&
          time > 0 &&
          time < _startedAt!.millisecondsSinceEpoch ~/ 1000) continue;
      final e = Map<String, dynamic>.from(item);
      e['message_type'] = private ? 'private' : 'group';
      e.putIfAbsent('user_id', () => private ? id : 0);
      unawaited(_handleMessage(e));
    }
  }
}

// 只给测试用：不启动网络，只验解析/过滤规则。
String debugChatKey(Map<String, dynamic> e) => _chatFromEvent(e);
String debugTextOf(dynamic message) => _textOf(message);
String debugDedupeKey(Map<String, dynamic> e) =>
    (e['message_id'] ?? e['message_seq'] ?? '').toString();

Future<void> startDesktopQqService() async {
  _log('startDesktopQqService 被调用');
  if (_started) return;
  if (Platform.environment.containsKey('FLUTTER_TEST') &&
      !const bool.fromEnvironment('LIVE_QQ_TEST')) return;
  _started = true;
  _startedAt = DateTime.now();
  // 心跳必须先于任何可能阻塞的初始化（读人设/资产失败也不能让它不写）。
  _writeHeartbeat();
  // ★ 契约（主人 2026-11-19 明确）：重启后 3 秒内必须有一次心跳，之后每 6 分钟变一次。
  //   旧实现是「启动写一次 + 每 5 分钟」——启动那次可能早于文件系统就绪，
  //   而 5 分钟和约定的 6 分钟也不一致。这里补一次 3 秒内的兜底写，并把周期改 6 分钟。
  _heartbeatBootTimer?.cancel();
  _heartbeatBootTimer = Timer(const Duration(seconds: 3), _writeHeartbeat);
  _heartbeatTimer?.cancel();
  _heartbeatTimer =
      Timer.periodic(const Duration(minutes: 6), (_) => _writeHeartbeat());
  try {
    await _loadConfig();
  } catch (e) {
    _log('初始化失败（心跳仍在写）：' + e.toString());
  }
  _log('桌面独立收答启动');
  unawaited(_connect());
}
