// 按人记的记忆（people.json）：同一个 QQ 号在私聊和群里是同一份记忆。
//
// 为什么单独一层：按会话记会让"私聊里聊过的"和"群里聊过的"互相看不见；
// 按 qqId 合并，才不会出现"换了个窗口就不认人"。
import 'dart:convert';
import 'dart:io';

/// 说话的人是谁：唯一判据是发送者 QQ + 场景，不看会话。
class Actor {
  const Actor({
    required this.qqId,
    required this.nickname,
    required this.isOwner,
    required this.isPrivate,
    required this.chatKey,
  });
  final String qqId;
  final String nickname;
  final bool isOwner;
  final bool isPrivate;
  final String chatKey;

  /// 给模型看的一行。所有注入都从这里出，别再各写一份。
  String get identityLine =>
      isOwner ? '当前说话的是 主人(' + (nickname.isEmpty ? '大星' : nickname) + ')'
              : '当前说话的是 群友(' + (nickname.isEmpty ? qqId : nickname) + ')';
}

/// 会话冲突：同一个 sessionId 同时挂在主人私聊和别处的。
class SessionConflict {
  const SessionConflict(this.sessionId, this.owners);
  final String sessionId;
  final List<String> owners;
  String get text => '会话冲突：' + sessionId + ' 同时绑了 ' + owners.join(' 和 ');
}

class PersonEntry {
  PersonEntry({
    required this.qqId,
    required this.names,
    required this.role,
    required this.facts,
    required this.lastSeen,
    required this.displayName,
    required this.seenIn,
  });
  final String qqId;
  final List<String> names;
  final String role;
  final List<String> facts;
  final String lastSeen;
  final String displayName;
  final List<String> seenIn;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'qqId': qqId,
        'names': names,
        'role': role,
        'facts': facts,
        'lastSeen': lastSeen,
        'displayName': displayName,
        'seenIn': seenIn,
      };

  static PersonEntry fromJson(Map<String, dynamic> j) => PersonEntry(
        qqId: (j['qqId'] ?? '').toString(),
        names: ((j['names'] as List?) ?? const [])
            .map((e) => e.toString())
            .toList(),
        role: (j['role'] ?? 'guest').toString(),
        facts: ((j['facts'] as List?) ?? const [])
            .map((e) => e.toString())
            .toList(),
        lastSeen: (j['lastSeen'] ?? '').toString(),
        displayName: (j['displayName'] ?? '').toString(),
        seenIn: ((j['seenIn'] as List?) ?? const [])
            .map((e) => e.toString())
            .toList(),
      );
}

/// 一个 QQ 号对应一份档案；聊天记录按 qqId 合并，不按会话。
class PeopleStore {
  PeopleStore(this.file);
  final File file;
  final Map<String, PersonEntry> _byQQ = <String, PersonEntry>{};
  bool _loaded = false;

  void _load() {
    if (_loaded) return;
    _loaded = true;
    try {
      if (!file.existsSync()) return;
      final raw = jsonDecode(file.readAsStringSync());
      if (raw is! Map) return;
      for (final e in ((raw['people'] as List?) ?? const [])) {
        if (e is! Map) continue;
        final p = PersonEntry.fromJson(Map<String, dynamic>.from(e));
        if (p.qqId.isNotEmpty) _byQQ[p.qqId] = p;
      }
      // 老格式只有 owner、people 是空的：把 owner 补成一条，别让人以为没档案。
      final ownerRaw = raw['owner'];
      if (ownerRaw is Map) {
        final o = PersonEntry.fromJson(Map<String, dynamic>.from(ownerRaw));
        if (o.qqId.isNotEmpty && !_byQQ.containsKey(o.qqId)) {
          _byQQ[o.qqId] = PersonEntry(
            qqId: o.qqId,
            names: o.names.isEmpty ? const <String>['大星', '主人'] : o.names,
            role: 'owner',
            facts: o.facts,
            lastSeen: o.lastSeen,
            displayName: o.displayName.isEmpty ? '大星' : o.displayName,
            seenIn: o.seenIn.isEmpty ? <String>['private:' + o.qqId] : o.seenIn,
          );
        }
      }
    } catch (_) {}
  }

  void _save() {
    try {
      file.parent.createSync(recursive: true);
      final items = _byQQ.values.map((e) => e.toJson()).toList();
      // owner 段保留原有 sessionId 等字段，只把 displayName / qqId 对齐。
      Map<String, dynamic> owner = <String, dynamic>{};
      try {
        if (file.existsSync()) {
          final old = jsonDecode(file.readAsStringSync());
          if (old is Map && old['owner'] is Map) {
            owner = Map<String, dynamic>.from(old['owner'] as Map);
          }
        }
      } catch (_) {}
      for (final p in _byQQ.values) {
        if (p.role != 'owner') continue;
        owner['qqId'] = p.qqId;
        owner['displayName'] = p.displayName;
        if (!(owner['names'] is List)) owner['names'] = p.names;
      }
      file.writeAsStringSync(
        const JsonEncoder.withIndent('  ').convert(<String, dynamic>{
          'version': 1,
          'owner': owner,
          'people': items,
          'updatedAt': DateTime.now().toUtc().toIso8601String(),
        }),
        flush: true,
      );
    } catch (_) {}
  }

  PersonEntry? get(String qqId) {
    _load();
    return _byQQ[qqId];
  }

  List<PersonEntry> get all {
    _load();
    return _byQQ.values.toList();
  }

  /// 见到一个人：没档就建，有档就补昵称 / 补 seenIn。
  PersonEntry seen({
    required String qqId,
    required String nickname,
    required String chatKey,
    bool isOwner = false,
  }) {
    _load();
    final nick = nickname.trim();
    final now = DateTime.now().toIso8601String();
    final old = _byQQ[qqId];
    final names = <String>[...old?.names ?? const <String>[]];
    if (nick.isNotEmpty && !names.contains(nick)) names.add(nick);
    final seenIn = <String>[...old?.seenIn ?? const <String>[]];
    if (chatKey.isNotEmpty && !seenIn.contains(chatKey)) seenIn.add(chatKey);
    final entry = PersonEntry(
      qqId: qqId,
      names: names,
      role: isOwner ? 'owner' : (old?.role ?? 'guest'),
      facts: old?.facts ?? const <String>[],
      lastSeen: now,
      displayName: isOwner
          ? (old?.displayName.isNotEmpty == true ? old!.displayName : (nick.isEmpty ? '大星' : nick))
          : (old?.displayName ?? ''),
      seenIn: seenIn,
    );
    _byQQ[qqId] = entry;
    _save();
    return entry;
  }

  /// 记一条关于这个人的事实（最多留 12 条，最老的挤出去）。
  void addFact(String qqId, String fact) {
    _load();
    final old = _byQQ[qqId];
    if (old == null) return;
    final t = fact.trim();
    if (t.isEmpty || old.facts.contains(t)) return;
    final facts = <String>[...old.facts, t];
    while (facts.length > 12) {
      facts.removeAt(0);
    }
    _byQQ[qqId] = PersonEntry(
      qqId: old.qqId,
      names: old.names,
      role: old.role,
      facts: facts,
      lastSeen: old.lastSeen,
      displayName: old.displayName,
      seenIn: old.seenIn,
    );
    _save();
  }

  /// 说话的人是谁。owner 必须在私聊里；群里同号也只算“主人（群场景）”，
  /// 不当主人私聊处理——会话只是投递地址，不是身份。
  Actor actorOf(String qqId,
      {required String chatKey, String nickname = ''}) {
    _load();
    final isPrivate = chatKey.startsWith('private:');
    final isOwner = qqId.isNotEmpty && qqId == ownerQQ && isPrivate;
    final p = get(qqId);
    final name = (nickname.isNotEmpty
            ? nickname
            : (p?.displayName.isNotEmpty == true
                ? p!.displayName
                : (p == null || p.names.isEmpty ? qqId : p.names.last)))
        .trim();
    return Actor(
      qqId: qqId,
      nickname: name,
      isOwner: isOwner,
      isPrivate: isPrivate,
      chatKey: chatKey,
    );
  }

  /// 会话冲突检查：一个 sessionId 不能同时属于主人私聊和别人。
  List<SessionConflict> sessionConflicts() {
    _load();
    final bySid = <String, Map<String, List<String>>>{};
    for (final p in _byQQ.values) {
      for (final key in p.seenIn) {
        final sid = _sessionOf(key);
        if (sid.isEmpty) continue;
        bySid.putIfAbsent(sid, () => <String, List<String>>{});
        bySid[sid]!.putIfAbsent(key, () => <String>[]).add(p.qqId);
      }
    }
    final out = <SessionConflict>[];
    final ownerKey = ownerQQ.isEmpty ? '' : 'private:' + ownerQQ;
    bySid.forEach((sid, chats) {
      final keys = chats.keys.toList();
      if (keys.length < 2) return;
      // 只有“主人私聊”和“别处”共用同一个会话才算真冲突。
      final hasOwner = ownerKey.isNotEmpty && keys.contains(ownerKey);
      if (!hasOwner) return;
      out.add(SessionConflict(sid, keys));
    });
    return out;
  }

  // 会话到 sessionId 的映射由调用方注入（桌面版从 chats.json 读）。
  String Function(String chatKey) _sessionResolver = (_) => '';
  void useSessionResolver(String Function(String chatKey) f) {
    _sessionResolver = f;
  }

  String _sessionOf(String chatKey) => _sessionResolver(chatKey);

  /// 主人 QQ（从 owner 段或 role=owner 的条目里取）。
  String get ownerQQ {
    _load();
    for (final e in _byQQ.values) {
      if (e.role == 'owner' && e.qqId.isNotEmpty) return e.qqId;
    }
    return '';
  }

  /// 拼给模型看的「发送者是谁」。
  /// 判据只有一条：sender 的 qqId == owner 的 qqId 就是主人。
  /// 这里写死一句话，不让模型自己猜——猜就是「大星是谁」的来源。
  /// 拼给模型看的「谁在说话」+ 他跟我说过的事。
  /// 身份那一行只认 actorOf，不认会话。
  String promptFor(String qqId, {String nickname = '', String chatKey = ''}) {
    final a = actorOf(qqId, chatKey: chatKey, nickname: nickname);
    final p = get(qqId);
    final alias = <String>[
      ...?p?.names,
      if (nickname.isNotEmpty) nickname,
    ].where((n) => n != a.nickname).toSet().toList();
    final sb = StringBuffer();
    sb.write('\n\n【谁在说话】' + a.identityLine + '。');
    if (a.isOwner) {
      sb.write('（QQ ' + qqId + '，这是私聊）');
      if (alias.isNotEmpty) sb.write('，别名：' + alias.join('、'));
      sb.write('。他问「' +
          (a.nickname.isEmpty ? '大星' : a.nickname) +
          '是谁」时，回答就是他自己（你啊 / 你自己），不要说没印象、不要当成第三个人。');
    } else if (!a.isPrivate) {
      sb.write('（QQ ' + qqId + '，这是群聊；他没被绑成主人，别叫他主人）');
      if (alias.isNotEmpty) sb.write('，也叫：' + alias.join('、'));
      sb.write('。');
    } else {
      sb.write('（QQ ' + qqId + '，这是私聊；他不是主人，别叫他主人）');
      if (alias.isNotEmpty) sb.write('，也叫：' + alias.join('、'));
      sb.write('。');
    }
    if (p != null && p.facts.isNotEmpty) {
      sb.write('\n你们之前聊过：' + p.facts.take(5).join('；') + '。');
    }
    return sb.toString();
  }
}
