// ignore_for_file: deprecated_member_use, avoid_web_libraries_in_flutter
import 'dart:async';
import 'dart:convert';
import 'dart:html' as html;

/// 浏览器里打主程序的本机桥：默认 7799，被占时主程序会退到 7798..7790，这里探测一次。
String _base = 'http://127.0.0.1:7799';
bool _baseReady = false;
Future<String> _ensureBase() async {
  if (_baseReady) return _base;
  for (var port = 7799; port >= 7790; port--) {
    try {
      final req = html.HttpRequest();
      req.open('GET', 'http://127.0.0.1:$port/api/health');
      final done = req.onLoad.first;
      final fail = req.onError.first;
      req.send();
      await Future.any([done, fail]).timeout(const Duration(milliseconds: 500));
      if (req.status == 200) {
        _base = 'http://127.0.0.1:$port';
        break;
      }
    } catch (e) {/* 这个端口不通，试下一个 */}
  }
  _baseReady = true;
  return _base;
}

Future<Map<String, dynamic>?> bridgeChat(
    List<Map<String, String>> messages) async {
  // 面板同源走鱼世界自己的聊天路由；旧 /api/chat 只在没有直连时兜底。
  final direct = await _postJson('/dsh-fish-world/fishworld/chat', {'messages': messages});
  if (direct != null) return direct;
  try {
    final req = html.HttpRequest();
    req.open('POST', '${await _ensureBase()}/api/chat');
    req.setRequestHeader('content-type', 'application/json');
    final done = req.onLoad.first;
    final fail = req.onError.first;
    req.send(jsonEncode({'messages': messages}));
    await Future.any([done, fail]).timeout(const Duration(seconds: 70));
    if (req.status != 200) return {'ok': false, 'error': 'HTTP ${req.status}'};
    final j = jsonDecode(req.responseText ?? '{}');
    return j is Map<String, dynamic> ? j : null;
  } catch (e) {
    return null;
  }
}
Future<Map<String, dynamic>?> bridgeModelConfig() async {
  final direct = await _getJson('/dsh-fish-world/fishworld/model/config');
  if (direct != null) return direct;
  try {
    final req = html.HttpRequest();
    req.open('GET', '${await _ensureBase()}/api/model/config');
    final done = req.onLoad.first;
    final fail = req.onError.first;
    req.send();
    await Future.any([done, fail]).timeout(const Duration(seconds: 8));
    if (req.status != 200) return null;
    final j = jsonDecode(req.responseText ?? '{}');
    return j is Map<String, dynamic> ? j : null;
  } catch (e) {
    return null;
  }
}

Future<Map<String, dynamic>?> bridgeModelConfigSave(
    {String? baseUrl, String? model, String? apiKey}) async {
  final body = <String, Object?>{};
  if (baseUrl != null) body['baseUrl'] = baseUrl;
  if (model != null) body['model'] = model;
  if (apiKey != null && apiKey.isNotEmpty) body['apiKey'] = apiKey;
  return _postFirst('/dsh-fish-world/fishworld/model/config', '${await _ensureBase()}/api/model/config', body);
}

Future<Map<String, dynamic>?> bridgeFeedback(
    String action, String detail) async {
  final direct = await _postJson('/dsh-fish-world/fishworld/feedback', {'action': action, 'detail': detail});
  if (direct != null) return direct;
  try {
    final req = html.HttpRequest();
    req.open('POST', '${await _ensureBase()}/api/feedback');
    req.setRequestHeader('content-type', 'application/json');
    final done = req.onLoad.first;
    final fail = req.onError.first;
    req.send(jsonEncode({'action': action, 'detail': detail}));
    await Future.any([done, fail]).timeout(const Duration(seconds: 20));
    if (req.status != 200) return null;
    final j = jsonDecode(req.responseText ?? '{}');
    return j is Map<String, dynamic> ? j : null;
  } catch (e) {
    return null;
  }
}

/// 鱼的世界只读快照（GET /api/fish/snapshot）。
/// 只读接口只允许 GET；超时 / 非 200 / 解析失败都返回 null，由 fish_data 回落打包快照。
Future<Map<String, dynamic>?> bridgeFishSnapshot() async {
  final direct = await _getJson('/dsh-fish-world/fishworld/snapshot');
  if (direct != null) return direct;
  try {
    final req = html.HttpRequest();
    req.open('GET', '${await _ensureBase()}/api/fish/snapshot');
    final done = req.onLoad.first;
    final fail = req.onError.first;
    req.send();
    await Future.any([done, fail]).timeout(const Duration(seconds: 8));
    if (req.status != 200) return null;
    final j = jsonDecode(req.responseText ?? '{}');
    return j is Map<String, dynamic> ? j : null;
  } catch (e) {
    return null;
  }
}

/// QQ 单一状态机（GET /api/qq/state）。
Future<Map<String, dynamic>?> bridgeQqState() async {
  final direct = await _getJson('/dsh-fish-world/fishworld/qq/state');
  if (direct != null) return direct;
  return _getJson('${await _ensureBase()}/api/qq/state');
}

Future<Map<String, dynamic>?> bridgeQqStatus() async {
  final direct = await _getJson('/dsh-fish-world/fishworld/qq/status');
  if (direct != null) return direct;
  try {
    final req = html.HttpRequest();
    req.open('GET', '${await _ensureBase()}/api/qq/status');
    final done = req.onLoad.first;
    final fail = req.onError.first;
    req.send();
    await Future.any([done, fail]).timeout(const Duration(seconds: 8));
    if (req.status != 200) return null;
    final j = jsonDecode(req.responseText ?? '{}');
    return j is Map<String, dynamic> ? j : null;
  } catch (e) {
    return null;
  }
}

/// QQ 接收开关（POST /api/qq/recv，action = start / stop）。
Future<Map<String, dynamic>?> bridgeQqRecv(String action) async {
  final direct = await _postJson('/dsh-fish-world/fishworld/qq/recv', {'action': action});
  if (direct != null) return direct; // 有响应就以它为准
  try {
    final req = html.HttpRequest();
    req.open('POST', '${await _ensureBase()}/api/qq/recv');
    req.setRequestHeader('content-type', 'application/json');
    final done = req.onLoad.first;
    final fail = req.onError.first;
    req.send(jsonEncode({'action': action}));
    await Future.any([done, fail]).timeout(const Duration(seconds: 8));
    if (req.status != 200) {
      try {
        final body = jsonDecode(req.responseText ?? '');
        if (body is Map && (body['error'] ?? '').toString().isNotEmpty) return {'ok': false, 'error': body['error'].toString()};
      } catch (_) {}
      return {'ok': false, 'error': 'HTTP ${req.status}'};
    }
    final j = jsonDecode(req.responseText ?? '{}');
    return j is Map<String, dynamic> ? j : null;
  } catch (e) {
    return null;
  }
}

Future<Map<String, dynamic>?> _getJson(String url) async {
  try {
    final req = html.HttpRequest();
    req.open('GET', url);
    final done = req.onLoad.first;
    final fail = req.onError.first;
    req.send();
    await Future.any([done, fail]).timeout(const Duration(seconds: 8));
    if (req.status != 200) return null;
    final j = jsonDecode(req.responseText ?? '{}');
    return j is Map<String, dynamic> ? j : null;
  } catch (e) {
    return null;
  }
}

Future<Map<String, dynamic>?> _postFirst(String direct, String legacy, Map<String, Object?> body) async {
  final r = await _postJson(direct, body);
  if (r != null) return r;
  return _postJson(legacy, body);
}

Future<Map<String, dynamic>?> _postJson(
    String url, Map<String, Object?> body) async {
  try {
    final req = html.HttpRequest();
    req.open('POST', url);
    req.setRequestHeader('content-type', 'application/json');
    final done = req.onLoad.first;
    final fail = req.onError.first;
    req.send(jsonEncode(body));
    await Future.any([done, fail]).timeout(const Duration(seconds: 8));
    // 404/501 是「没有这个接口」，立刻短路，别等满超时。
    if (req.status == 404) return {'ok': false, 'error': 'HTTP 404', 'notFound': true};
    if (req.status != 200) {
      // 优先把后端给的 error 原文带出来，别只剩一个状态码。
      try {
        final body = jsonDecode(req.responseText ?? '');
        if (body is Map && (body['error'] ?? '').toString().isNotEmpty) {
          return {'ok': false, 'error': body['error'].toString()};
        }
      } catch (_) {}
      return {'ok': false, 'error': 'HTTP ${req.status}'};
    }
    final j = jsonDecode(req.responseText ?? '{}');
    return j is Map<String, dynamic> ? j : null;
  } catch (e) {
    return null;
  }
}

Future<Map<String, dynamic>?> bridgeFishDiaryComment(
        String id, String text, {String quote = ''}) async =>
await _postFirst('/dsh-fish-world/fishworld/fish/diary/comment', '${await _ensureBase()}/api/fish/diary/comment',  {
      'id': id,
      'text': text,
      'actorName': '主人',
      if (quote.trim().isNotEmpty) 'quote': quote,
    });

/// 鱼的记忆轻量干预：pending = 标记待确认；forget = 从记忆册忘记。
Future<Map<String, dynamic>?> bridgeFishMemoryAction(
        String id, String action) async =>
await _postFirst('/dsh-fish-world/memory/action', '${await _ensureBase()}/api/fish/memory/action', 
        {'id': id, 'action': action});

Future<Map<String, dynamic>?> bridgeFishWishDecision(
        String id, String decision) async =>
await _postFirst('/dsh-fish-world/fishworld/fish/wishes/approve', '${await _ensureBase()}/api/fish/wishes/approve', 
        {'id': id, 'decision': decision});
Future<Map<String, dynamic>?> bridgeDiaryDates(String month) async {
  final direct = await _getJson('/dsh-fish-world/diary/dates?month=${Uri.encodeComponent(month)}');
  if (direct != null) return direct;
  try {
    final req = html.HttpRequest();
    req.open('GET', '${await _ensureBase()}/api/diary/dates?month=${Uri.encodeComponent(month)}');
    final done = req.onLoad.first;
    final fail = req.onError.first;
    req.send();
    await Future.any([done, fail]).timeout(const Duration(seconds: 8));
    if (req.status != 200) return null;
    final j = jsonDecode(req.responseText ?? '{}');
    return j is Map<String, dynamic> ? j : null;
  } catch (e) { return null; }
}

Future<Map<String, dynamic>?> bridgeDiaryDay(String date) async {
  final direct = await _getJson('/dsh-fish-world/diary/day?date=${Uri.encodeComponent(date)}');
  if (direct != null) return direct;
  try {
    final req = html.HttpRequest();
    req.open('GET', '${await _ensureBase()}/api/diary/day?date=${Uri.encodeComponent(date)}');
    final done = req.onLoad.first;
    final fail = req.onError.first;
    req.send();
    await Future.any([done, fail]).timeout(const Duration(seconds: 8));
    if (req.status != 200) return null;
    final j = jsonDecode(req.responseText ?? '{}');
    return j is Map<String, dynamic> ? j : null;
  } catch (e) { return null; }
}

Future<Map<String, dynamic>?> bridgeFishDiaryDecision(
        String id, String decision) async =>
await _postFirst('/dsh-fish-world/fishworld/fish/diary/approve', '${await _ensureBase()}/api/fish/diary/approve', 
        {'id': id, 'decision': decision});

Future<Map<String, dynamic>?> bridgeFishGrowthRevise(
        String id, String text) async =>
await _postFirst('/dsh-fish-world/fishworld/fish/growth/revise', '${await _ensureBase()}/api/fish/growth/revise', 
        {'id': id, 'text': text});

Future<Map<String, dynamic>?> bridgeFishGrowthRetract(String id) async =>
await _postFirst('/dsh-fish-world/fishworld/fish/growth/retract', '${await _ensureBase()}/api/fish/growth/retract',  {'id': id});



Future<Map<String, dynamic>?> bridgeQqField(String key, Object? value) async {
  final direct = await _postJson('/dsh-fish-world/fishworld/qq/field', {'key': key, 'value': value});
  if (direct != null) return direct;
  return _postJson('${await _ensureBase()}/api/qq/field', {'key': key, 'value': value});
}

/// 桥超窗未投的消息（2026-11-20 主人要求 A）。
///
/// 「投不进去就丢掉」以前只写桥自己的日志，主人看不到 —— 这里给面板一条读的路。
/// DSH 面板同源走 /dsh-fish-world/qq/undelivered，旧 7799 桥没有这条就返回 null。
Future<Map<String, dynamic>?> bridgeQqUndelivered() async {
  final direct = await _getJson('/dsh-fish-world/qq/undelivered');
  if (direct != null) return direct;
  return _getJson('${await _ensureBase()}/api/qq/undelivered');
}

/// 手动补投：给 id 补一条，给 all=true 补全部。
Future<Map<String, dynamic>?> bridgeQqRedeliver({String? id, bool all = false}) async {
  final body = <String, dynamic>{
    'action': 'redeliver',
    'all': all,
    if (id != null && id.isNotEmpty) 'id': id,
  };
  final direct = await _postJson('/dsh-fish-world/qq/undelivered', body);
  if (direct != null) return direct;
  return _postJson('${await _ensureBase()}/api/qq/undelivered', body);
}

/// 读鱼自己的群聊 / 好友，用于白名单勾选。
/// DSH 面板同源走 /dsh-fish-world/qq/chat；旧 7799 桥再退回 /api/qq/chat。
/// 拉起 QQ 协议端（SnowLuma）：POST /dsh-fish-world/protocol。
Future<Map<String, dynamic>?> bridgeStickerWishes() async {
  final direct = await _getJson('/dsh-fish-world/world/sticker-wishes');
  if (direct != null) return direct;
  return _getJson('${await _ensureBase()}/api/world/sticker-wishes');
}

Future<Map<String, dynamic>?> bridgeStickerWishDecide(String id, bool accept) async {
  final direct = await _postJson('/dsh-fish-world/world/sticker-wishes', {'id': id, 'accept': accept});
  if (direct != null) return direct;
  return _postJson('${await _ensureBase()}/api/world/sticker-wishes', {'id': id, 'accept': accept});
}

String fishPortraitUrl({num? mood, Map<String, int> dims = const {}}) {
  final base = Uri.base;
  final origin = base.hasScheme ? base.origin : 'http://127.0.0.1:7799';
  final q = <String>[];
  if (mood != null) q.add('mood=' + mood.toString());
  dims.forEach((k, v) => q.add('d_' + Uri.encodeComponent(k) + '=' + v.toString()));
  return origin + '/dsh-fish-world/fish/portrait' + (q.isEmpty ? '' : '?' + q.join('&'));
}

String stickerWishImageUrl(String id) {
  final base = Uri.base;
  final origin = base.hasScheme ? (base.origin) : 'http://127.0.0.1:7799';
  return origin + '/dsh-fish-world/sticker-wish-image?id=' + Uri.encodeComponent(id);
}

Future<Map<String, dynamic>?> bridgeProtocolStatus() async {
  final direct = await _getJson('/dsh-fish-world/protocol');
  if (direct != null) return direct;
  return _getJson('${await _ensureBase()}/api/protocol');
}

Future<Map<String, dynamic>?> bridgeQqProbeLogin() async {
  final direct = await _getJson('/dsh-fish-world/fishworld/qq/probe-login');
  if (direct != null) return direct;
  return _getJson('${await _ensureBase()}/api/qq/probe-login');
}

Future<Map<String, dynamic>?> bridgeProtocolStop() async {
  final direct = await _postJson('/dsh-fish-world/protocol', const {'action': 'stop'});
  if (direct != null) return direct;
  return _postJson('${await _ensureBase()}/api/protocol', const {'action': 'stop'});
}

Future<Map<String, dynamic>?> bridgeProtocolStart() async {
  final direct = await _postJson('/dsh-fish-world/protocol', const {});
  if (direct != null) return direct; // 有响应就以它为准，只有完全没响应才退回旧桥
  return _postJson('${await _ensureBase()}/api/protocol', const {});
}

Future<Map<String, dynamic>?> bridgeQqTargets() async {
  final direct = await _postJson('/dsh-fish-world/qq/chat', {'action': 'targets'});
  if (direct != null) return direct; // 有响应就以它为准，只有完全没响应才退回旧桥
  return _postJson('${await _ensureBase()}/api/qq/chat', {'action': 'targets'});
}

Future<Map<String, dynamic>?> bridgeBiliConfig({required bool enabled}) async {
  final direct = await _postJson('/dsh-fish-world/fishworld/bili/config', {'enabled': enabled});
  if (direct != null) return direct;
  return _postJson('${await _ensureBase()}/api/bili/config', {'enabled': enabled});
}

Future<Map<String, dynamic>?> bridgeBiliField(String key, Object? value) async {
  final direct = await _postJson('/dsh-fish-world/fishworld/bili/field', {'key': key, 'value': value});
  if (direct != null) return direct;
  return _postJson('${await _ensureBase()}/api/bili/field', {'key': key, 'value': value});
}

Future<Map<String, dynamic>?> bridgeQqConfig(
    {bool? enabled, String? baseUrl, String? token, bool? atOnly}) async {
  final body = <String, Object?>{};
  if (enabled != null) body['enabled'] = enabled;
  if (baseUrl != null && baseUrl.trim().isNotEmpty) {
    body['baseUrl'] = baseUrl.trim();
  }
  if (token != null && token.trim().isNotEmpty) body['token'] = token.trim();
  if (atOnly != null) body['atOnly'] = atOnly;
  final direct = await _postJson('/dsh-fish-world/fishworld/qq/config', body);
  if (direct != null) return direct;
  return _postJson('${await _ensureBase()}/api/qq/config', body);
}

Future<Map<String, dynamic>?> bridgeFishGalleryRemove(String name) async =>
    _postFirst('/dsh-fish-world/fishworld/fish/gallery/remove', '${await _ensureBase()}/api/fish/gallery/remove', {'name': name});

/// 改名 / 改标签：POST /dsh-fish-world/stickers/update（后端留痕已做）。
Future<Map<String, dynamic>?> bridgeActivityRecord({required String platform, required String kind, String text = '', String actor = 'fish'}) async {
  final body = <String, Object?>{'platform': platform, 'kind': kind, 'text': text, 'actor': actor};
  final direct = await _postJson('/dsh-fish-world/world/activity', body);
  if (direct != null) return direct; // 有响应就以它为准，只有完全没响应才退回旧桥
  return _postJson('${await _ensureBase()}/api/world/activity', body);
}

Future<Map<String, dynamic>?> bridgeStickerUpdate({String id = '', String? name, List<String>? tags}) async {
  final body = <String, Object?>{'id': id};
  if (name != null) body['name'] = name;
  if (tags != null) body['tags'] = tags;
  final direct = await _postJson('/dsh-fish-world/stickers/update', body);
  if (direct != null) return direct; // 有响应就以它为准，只有完全没响应才退回旧桥
  return _postJson('${await _ensureBase()}/api/stickers/update', body);
}
Future<Map<String, dynamic>?> bridgeKbSearch(String q, {String status = ''}) async {
  try {
    final req = html.HttpRequest();
    final extra = status.isEmpty ? '' : '&status=${Uri.encodeComponent(status)}';
    req.open('GET',
        '${await _ensureBase()}/api/fish/kb/search?q=${Uri.encodeComponent(q)}$extra');
    final done = req.onLoad.first;
    final fail = req.onError.first;
    req.send();
    await Future.any([done, fail]).timeout(const Duration(seconds: 20));
    if (req.status != 200) return null;
    final j = jsonDecode(req.responseText ?? '{}');
    return j is Map<String, dynamic> ? j : null;
  } catch (e) {
    return null;
  }
}

Future<Map<String, dynamic>?> bridgeMemeStatus(String id, String status) async =>
    _postFirst('/dsh-fish-world/fishworld/meme/status', '${await _ensureBase()}/api/fish/meme/status', {'id': id, 'status': status});
Future<Map<String, dynamic>?> bridgeKbUpdate(
        Map<String, Object?> fields) async =>
await _postFirst('/dsh-fish-world/fishworld/fish/kb/update', '${await _ensureBase()}/api/fish/kb/update',  fields);
Future<Map<String, dynamic>?> bridgeFishProfileGet() async {
  final direct = await _getJson('/dsh-fish-world/fish/profile');
  if (direct != null) return direct;
  return _getJson('${await _ensureBase()}/api/fish/profile');
}

Future<Map<String, dynamic>?> bridgeFishProfile({String? name, String? ownerTitle, String? persona, String? ownerQQ, String? ownerSession}) async {
  final body = <String, Object?>{};
  if (name != null) body['name'] = name;
  if (ownerTitle != null) body['ownerTitle'] = ownerTitle;
  if (persona != null) body['persona'] = persona;
  if (ownerQQ != null) body['ownerQQ'] = ownerQQ;
  if (ownerSession != null) body['ownerSession'] = ownerSession;
  return _postFirst('/dsh-fish-world/fish/profile', '${await _ensureBase()}/api/fish/profile', body);
}

Future<Map<String, dynamic>?> bridgeFishPersonaGet([String roleId = '']) async {
  final q = roleId.isEmpty ? '' : '?role=' + Uri.encodeComponent(roleId);
  final direct = await _getJson('/dsh-fish-world/fish/persona' + q);
  if (direct != null) return direct;
  return _getJson('${await _ensureBase()}/api/fish/persona' + q);
}

Future<Map<String, dynamic>?> bridgeFishPersonaSave(String roleId, String text) async =>
    _postFirst('/dsh-fish-world/fish/persona', '${await _ensureBase()}/api/fish/persona', {'roleId': roleId, 'text': text});

Future<Map<String, dynamic>?> bridgeFishRoles(String action, {String id = '', String name = '', bool? pinned}) async {
  final body = <String, Object?>{'action': action};
  if (id.isNotEmpty) body['id'] = id;
  if (name.isNotEmpty) body['name'] = name;
  if (pinned != null) body['pinned'] = pinned;
  return _postFirst('/dsh-fish-world/fish/roles', '${await _ensureBase()}/api/fish/roles', body);
}

Future<Map<String, dynamic>?> bridgeFishRoleImage(String id, String base64) async =>
    _postFirst('/dsh-fish-world/fish/roles', '${await _ensureBase()}/api/fish/roles', {'action': 'image', 'id': id, 'base64': base64});

Future<Map<String, dynamic>?> bridgeConfigGet() async {
  final direct = await _getJson('/dsh-fish-world/config');
  if (direct != null) return direct;
  return _getJson('${await _ensureBase()}/api/config');
}

Future<Map<String, dynamic>?> bridgeConfigSave(Map<String, Object?> patch) async =>
    _postFirst('/dsh-fish-world/config', '${await _ensureBase()}/api/config', patch);

Future<Map<String, dynamic>?> bridgeQqChatAction(Map<String, Object?> body) async {
  return _postJson('/dsh-fish-world/qq/chat', body);
}

Future<Map<String, dynamic>?> bridgeQqChatMode(String chatKey, String mode) async {
  final direct = await _postJson('/dsh-fish-world/qq/chat', {'action': 'mode', 'chatKey': chatKey, 'mode': mode});
  if (direct != null) return direct;
  return _postJson('${await _ensureBase()}/api/qq/chat', {'action': 'mode', 'chatKey': chatKey, 'mode': mode});
}

Future<Map<String, dynamic>?> bridgeQqInbox() async {
  final direct = await _getJson('/dsh-fish-world/fishworld/qq/inbox');
  if (direct != null) return direct;
  try {
    final req = html.HttpRequest();
    req.open('GET', '${await _ensureBase()}/api/qq/inbox');
    final done = req.onLoad.first;
    final fail = req.onError.first;
    req.send();
    await Future.any([done, fail]).timeout(const Duration(seconds: 15));
    if (req.status != 200) return null;
    final j = jsonDecode(req.responseText ?? '{}');
    return j is Map<String, dynamic> ? j : null;
  } catch (e) {
    return null;
  }
}

Future<Map<String, dynamic>?> bridgeQqForward(String id) async =>
    _postFirst('/dsh-fish-world/fishworld/qq/forward', '${await _ensureBase()}/api/qq/forward', {'id': id});
Future<Map<String, dynamic>?> bridgeNotes() async {
  final direct = await _getJson('/dsh-fish-world/fishworld/notes');
  if (direct != null) return direct;
  try {
    final req = html.HttpRequest();
    req.open('GET', '${await _ensureBase()}/api/notes');
    final done = req.onLoad.first;
    final fail = req.onError.first;
    req.send();
    await Future.any([done, fail]).timeout(const Duration(seconds: 15));
    if (req.status != 200) return null;
    final j = jsonDecode(req.responseText ?? '{}');
    return j is Map<String, dynamic> ? j : null;
  } catch (e) {
    return null;
  }
}

Future<Map<String, dynamic>?> bridgeNoteSave({String? id, required String title, required String body, required String folder, double? x, double? y}) async {
  final payload = <String, dynamic>{'title': title, 'body': body, 'folder': folder};
  if (id != null && id.isNotEmpty) payload['id'] = id;
  final direct = await _postJson('/dsh-fish-world/fishworld/notes/save', payload);
  if (direct != null) return direct;
  return _postJson('${await _ensureBase()}/api/notes/save', payload);
}

Future<Map<String, dynamic>?> bridgeNoteDelete(String id) async {
  final direct = await _postJson('/dsh-fish-world/fishworld/notes/delete', {'id': id});
  if (direct != null) return direct;
  return _postJson('${await _ensureBase()}/api/notes/delete', {'id': id});
}

Future<Map<String, dynamic>?> bridgeNoteMove(String id, String folder) async =>
    _postFirst('/dsh-fish-world/fishworld/notes/move', '${await _ensureBase()}/api/notes/move', {'id': id, 'folder': folder});

/// 探测本机桥是否可用：拿不到就说明是本地预览（无 DSH 宿主）。
Future<bool> bridgeHealth() async {
  // 判据：任一鱼世界接口能通就不算本地预览。
  // /api/health 在 DSH 里需要鉴权（401），不能拿它当唯一证据。
  for (final url in [
    '/dsh-fish-world/health',
    '/dsh-fish-world/fishworld/snapshot',
    '/api/health',
    Uri.base.resolve('api/health').toString(),
  ]) {
    if (await _ping(url)) return true;
  }
  return false;
}

Future<bool> _ping(String url) async {
  try {
    final req = html.HttpRequest();
    req.open('GET', url);
    final done = req.onLoad.first;
    final fail = req.onError.first;
    req.send();
    await Future.any([done, fail]).timeout(const Duration(seconds: 2));
    return req.status == 200;
  } catch (_) {
    return false;
  }
}
