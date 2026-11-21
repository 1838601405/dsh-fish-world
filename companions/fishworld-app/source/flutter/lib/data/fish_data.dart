import 'dart:convert';

import 'package:flutter/services.dart';

import 'bridge.dart';

/// 「鱼的世界」只读快照 —— 数据层。
///
/// 契约见 docs/蓝鲸娘-Flutter-鱼的世界同步-20261107.md 第四节。
/// 读取顺序：本机桥 GET /api/fish/snapshot → 打包快照 assets/data/fish_snapshot.json
/// → 空态。**任何一步拿不到都不编造数据**，页面自己显示空态文案。
///
/// 本文件只做「解析 + 抓取」，页面与主题都留在 lib/fish/ 里。

// ---------- 解析小工具（后端字段缺失时不抛，给空值） ----------
String _s(Object? v) => v == null ? '' : v.toString();

int _i(Object? v) {
  if (v is int) return v;
  if (v is num) return v.toInt();
  return int.tryParse(_s(v)) ?? 0;
}

double _d(Object? v) {
  if (v is num) return v.toDouble();
  return double.tryParse(_s(v)) ?? 0;
}

bool _b(Object? v) => v == true || _s(v) == 'true';

Map<String, dynamic> _m(Object? v) {
  if (v is Map) {
    return v.map((k, val) => MapEntry(k.toString(), val));
  }
  return const <String, dynamic>{};
}

List<Map<String, dynamic>> _lm(Object? v) {
  if (v is! List) return const <Map<String, dynamic>>[];
  return [
    for (final e in v)
      if (e is Map) e.map((k, val) => MapEntry(k.toString(), val)),
  ];
}

List<String> _ls(Object? v) {
  if (v is! List) return const <String>[];
  return [for (final e in v) _s(e)];
}

/// 数字转展示文本：整数不带小数点，小数原样。
String _numText(Object? v) {
  if (v is int) return '$v';
  if (v is num) return v == v.roundToDouble() ? v.toInt().toString() : '$v';
  return _s(v);
}

/// 时间戳折成「MM-dd HH:mm」；解析不了就原样返回。
String shortFishTime(String iso) {
  if (iso.isEmpty) return '';
  if (iso.length >= 16 && iso[4] == '-' && iso[10] == 'T') {
    return '${iso.substring(5, 10)} ${iso.substring(11, 16)}';
  }
  return iso;
}

// ---------- 鱼的世界：模型 ----------

/// 成长阶段（总览 / 鱼的成长 / 鱼的状态共用）。
class FishStage {
  final String id;
  final String name;
  final String desc;
  final int min;
  final String nextName;
  final int nextMin;
  final int toNext;
  final double progress;
  const FishStage({
    this.id = '',
    this.name = '',
    this.desc = '',
    this.min = 0,
    this.nextName = '',
    this.nextMin = 0,
    this.toNext = 0,
    this.progress = 0,
  });
  factory FishStage.fromJson(Object? raw) {
    final j = _m(raw);
    final next = _m(j['next']);
    return FishStage(
      id: _s(j['id']),
      name: _s(j['name']),
      desc: _s(j['desc']),
      min: _i(j['min']),
      nextName: _s(next['name']),
      nextMin: _i(next['min']),
      toNext: _i(j['toNext']),
      progress: _d(j['progress']),
    );
  }
  bool get isEmpty => name.isEmpty && desc.isEmpty;
}

/// 总览里用到的计数。
class FishOverview {
  final FishStage stage;
  final int diaryTotal;
  final int diaryPending;
  final int diaryToday;
  final int wishesPending;
  final int wishesTotal;
  final int growthTotal;
  final int memoryMemories;
  final int memoryKnowledge;
  final bool qqInstalled;
  final bool qqEnabled;
  final bool qqDryRun;
  const FishOverview({
    this.stage = const FishStage(),
    this.diaryTotal = 0,
    this.diaryPending = 0,
    this.diaryToday = 0,
    this.wishesPending = 0,
    this.wishesTotal = 0,
    this.growthTotal = 0,
    this.memoryMemories = 0,
    this.memoryKnowledge = 0,
    this.qqInstalled = false,
    this.qqEnabled = false,
    this.qqDryRun = false,
  });
  factory FishOverview.fromJson(Object? raw) {
    final j = _m(raw);
    final diary = _m(j['diary']);
    final wishes = _m(j['wishes']);
    final growth = _m(j['growth']);
    final memory = _m(j['memory']);
    final qq = _m(j['qq']);
    return FishOverview(
      stage: FishStage.fromJson(j['stage']),
      diaryTotal: _i(diary['total']),
      diaryPending: _i(diary['pending']),
      diaryToday: _i(diary['today']),
      wishesPending: _i(wishes['pending']),
      wishesTotal: _i(wishes['total']),
      growthTotal: _i(growth['total']),
      memoryMemories: _i(memory['memories']),
      memoryKnowledge: _i(memory['knowledge']),
      qqInstalled: _b(qq['installed']),
      qqEnabled: _b(qq['enabled']),
      qqDryRun: _b(qq['dryRun']),
    );
  }
}

class FishDayCount {
  final String day;
  final int count;
  const FishDayCount({this.day = '', this.count = 0});
  factory FishDayCount.fromJson(Object? raw) {
    final j = _m(raw);
    return FishDayCount(day: _s(j['day']), count: _i(j['count']));
  }
}

/// 鱼的状态：最新记忆摘要。
class FishStatus {
  final String day;
  final String at;
  final int count;
  final int chars;
  final String text;
  final String oneLine;
  final List<FishDayCount> history;
  const FishStatus({
    this.day = '',
    this.at = '',
    this.count = 0,
    this.chars = 0,
    this.text = '',
    this.oneLine = '',
    this.history = const <FishDayCount>[],
  });
  factory FishStatus.fromJson(Object? raw) {
    final j = _m(raw);
    return FishStatus(
      day: _s(j['day']),
      at: _s(j['at']),
      count: _i(j['count']),
      chars: _i(j['chars']),
      text: _s(j['text']),
      oneLine: _s(j['oneLine']),
      history: [for (final e in _lm(j['history'])) FishDayCount.fromJson(e)],
    );
  }
}

class FishDiaryComment {
  final String at;
  final String who;
  final String text;
  final String quote;
  final String respondedAt;
  const FishDiaryComment(
      {this.at = '', this.who = '', this.text = '', this.quote = '', this.respondedAt = ''});
  factory FishDiaryComment.fromJson(Object? raw) {
    final j = _m(raw);
    return FishDiaryComment(
      at: _s(j['at']),
      who: _s(j['who']),
      text: _s(j['text']),
      quote: _s(j['quote']),
      respondedAt: _s(j['respondedAt']),
    );
  }
}

class FishDiaryEntry {
  final String id;
  final String date;
  final String at;
  final String who;
  final String status;
  final String text;
  final List<FishDiaryComment> comments;
  const FishDiaryEntry({
    this.id = '',
    this.date = '',
    this.at = '',
    this.who = '',
    this.status = '',
    this.text = '',
    this.comments = const <FishDiaryComment>[],
  });
  factory FishDiaryEntry.fromJson(Object? raw) {
    final j = _m(raw);
    return FishDiaryEntry(
      id: _s(j['id']),
      date: _s(j['date']),
      at: _s(j['at']),
      who: _s(j['who']),
      status: _s(j['status']),
      text: _s(j['text']),
      comments: [
        for (final e in _lm(j['comments'])) FishDiaryComment.fromJson(e)
      ],
    );
  }
  String get statusLabel {
    switch (status) {
      case 'approved':
        return '已批准';
      case 'pending':
        return '待确认';
      case 'rejected':
        return '已拒绝';
      default:
        return status;
    }
  }
}

class FishDiary {
  final int total;
  final int pending;
  final List<FishDiaryEntry> items;
  const FishDiary(
      {this.total = 0,
      this.pending = 0,
      this.items = const <FishDiaryEntry>[]});
  factory FishDiary.fromJson(Object? raw) {
    final j = _m(raw);
    return FishDiary(
      total: _i(j['total']),
      pending: _i(j['pending']),
      items: [for (final e in _lm(j['items'])) FishDiaryEntry.fromJson(e)],
    );
  }
}

class FishWish {
  final String id;
  final String day;
  final String at;
  final String kind;
  final String urgency;
  final String status;
  final String text;
  final String reply;
  const FishWish({
    this.id = '',
    this.day = '',
    this.at = '',
    this.kind = '',
    this.urgency = '',
    this.status = '',
    this.text = '',
    this.reply = '',
  });
  factory FishWish.fromJson(Object? raw) {
    final j = _m(raw);
    return FishWish(
      id: _s(j['id']),
      day: _s(j['day']),
      at: _s(j['at']),
      kind: _s(j['kind']),
      urgency: _s(j['urgency']),
      status: _s(j['status']),
      text: _s(j['text']),
      reply: _s(j['reply']),
    );
  }
  String get statusLabel {
    switch (status) {
      case 'pending':
        return '待处理';
      case 'approved':
        return '已同意';
      case 'rejected':
        return '已拒绝';
      default:
        return status;
    }
  }

  /// 请求的类别是自由文本，只把常见的翻成人话，其余照原样（不吞鱼的话）。
  String get kindLabel {
    switch (kind) {
      case 'wish':
        return '请求';
      case 'persona':
        return '想改自己的设定';
      case 'collect':
        return '想收的东西';
      case 'habit':
        return '想改的相处方式';
      default:
        return kind.isEmpty ? '请求' : kind;
    }
  }
}

class FishWishes {
  final int pending;
  final int total;
  final List<FishWish> items;
  final List<String> stickers;
  final String voice;
  const FishWishes({
    this.pending = 0,
    this.total = 0,
    this.items = const <FishWish>[],
    this.stickers = const <String>[],
    this.voice = '',
  });
  factory FishWishes.fromJson(Object? raw) {
    final j = _m(raw);
    return FishWishes(
      pending: _i(j['pending']),
      total: _i(j['total']),
      items: [for (final e in _lm(j['items'])) FishWish.fromJson(e)],
      stickers: [for (final e in _lm(j['stickers'])) _s(e['name'])],
      voice: _s(j['voice']),
    );
  }
}

class FishGrowthEntry {
  final String id;
  final String day;
  final String at;
  final String kind;
  final String text;
  final String quote;
  final String sourceType;
  final String sourceId;
  final int revision;
  final String status;
  const FishGrowthEntry({
    this.id = '',
    this.day = '',
    this.at = '',
    this.kind = '',
    this.text = '',
    this.quote = '',
    this.sourceType = '',
    this.sourceId = '',
    this.revision = 1,
    this.status = '',
  });
  factory FishGrowthEntry.fromJson(Object? raw) {
    final j = _m(raw);
    final source = _m(j['source']);
    return FishGrowthEntry(
      id: _s(j['id']),
      day: _s(j['day']),
      at: _s(j['at']),
      kind: _s(j['kind']),
      text: _s(j['text']),
      quote: _s(j['quote']),
      sourceType: _s(source['type']),
      sourceId: _s(source['id']),
      revision: _i(j['revision']),
      status: _s(j['status']),
    );
  }
  String get kindLabel {
    switch (kind) {
      case 'insight':
        return '认识';
      case 'next':
        return '下次怎么做';
      case 'milestone':
        return '里程碑';
      default:
        return kind;
    }
  }
}

class FishGrowth {
  final FishStage stage;
  final int total;
  final int days;
  final int todayCount;
  final int dailyLimit;
  final String firstDay;
  final String lastDay;
  final Map<String, int> byKind;
  final List<FishStage> stages;
  final List<FishGrowthEntry> items;
  const FishGrowth({
    this.stage = const FishStage(),
    this.total = 0,
    this.days = 0,
    this.todayCount = 0,
    this.dailyLimit = 2,
    this.firstDay = '',
    this.lastDay = '',
    this.byKind = const <String, int>{},
    this.stages = const <FishStage>[],
    this.items = const <FishGrowthEntry>[],
  });
  factory FishGrowth.fromJson(Object? raw) {
    final j = _m(raw);
    final byKind = _m(j['byKind']);
    final items = [for (final e in _lm(j['items'])) FishGrowthEntry.fromJson(e)];
    // 旧快照只导出 items（firstDay/lastDay 缺失）时，用条目日期兜底；
    // 不然 hero 有记录、节奏卡却显示空。
    final itemDays = [...{for (final e in items) if (e.day.isNotEmpty) e.day}]..sort();
    final first = _s(j['firstDay']).isEmpty && itemDays.isNotEmpty ? itemDays.first : _s(j['firstDay']);
    final last = _s(j['lastDay']).isEmpty && itemDays.isNotEmpty ? itemDays.last : _s(j['lastDay']);
    final days = _i(j['days']) == 0 && itemDays.isNotEmpty ? itemDays.length : _i(j['days']);
    return FishGrowth(
      stage: FishStage.fromJson(j['stage']),
      total: _i(j['total']) == 0 && items.isNotEmpty ? items.length : _i(j['total']),
      days: days,
      todayCount: _i(j['todayCount']),
      dailyLimit: _i(j['dailyLimit']) == 0 ? 2 : _i(j['dailyLimit']),
      firstDay: first,
      lastDay: last,
      byKind: {for (final e in byKind.entries) e.key: _i(e.value)},
      stages: [for (final e in _lm(j['stages'])) FishStage.fromJson(e)],
      items: items,
    );
  }
  int kindCount(String kind) => byKind[kind] ?? items.where((e) => e.kind == kind).length;
}

class FishPersona {
  final String id;
  final String name;
  final String preview;
  final int length;
  final String avatar;
  final bool hasImage;
  const FishPersona({
    this.id = '',
    this.name = '',
    this.preview = '',
    this.length = 0,
    this.avatar = '',
    this.hasImage = false,
  });
  factory FishPersona.fromJson(Object? raw) {
    final j = _m(raw);
    return FishPersona(
      id: _s(j['id']),
      name: _s(j['name']),
      preview: _s(j['preview']),
      length: _i(j['length']),
      avatar: _s(j['avatar']),
      hasImage: _b(j['hasImage']),
    );
  }
}

class FishMemoryEntry {
  final String id;
  final String text;
  final String at;
  final String category;
  final String kind;
  final List<String> tags;
  final String sourceType;
  final String sourceRef;
  final double importance;
  final bool pinned;
  final int hits;
  final String lastUsedAt;
  final bool neverRecalled;
  final String lastConfirmedAt;
  final String status;
  final String domain;
  const FishMemoryEntry({
    this.id = '',
    this.text = '',
    this.at = '',
    this.category = '',
    this.kind = '',
    this.tags = const <String>[],
    this.sourceType = '',
    this.sourceRef = '',
    this.importance = 0,
    this.pinned = false,
    this.hits = 0,
    this.lastUsedAt = '',
    this.neverRecalled = true,
    this.lastConfirmedAt = '',
    this.status = 'active',
    this.domain = 'memory',
  });
  factory FishMemoryEntry.fromJson(Object? raw) {
    final j = _m(raw);
    final category = _s(j['category']);
    final source = j['source'];
    final sourceMap = source is Map ? _m(source) : const <String, dynamic>{};
    return FishMemoryEntry(
      id: _s(j['id']),
      text: _s(j['text']),
      at: _s(j['at']),
      category: category,
      kind: _s(j['kind']).isNotEmpty
          ? _s(j['kind'])
          : _kindFromCategory(category),
      tags: _ls(j['tags']),
      sourceType: sourceMap.isNotEmpty ? _s(sourceMap['type']) : _s(source),
      sourceRef: _s(sourceMap['ref']),
      importance: _d(j['importance']),
      pinned: _b(j['pinned']),
      hits: _i(j['hits']),
      lastUsedAt: _s(j['lastUsedAt']),
      neverRecalled: j['neverRecalled'] == null ? _s(j['lastUsedAt']).isEmpty : _b(j['neverRecalled']),
      lastConfirmedAt: _s(j['lastConfirmedAt']),
      status: _s(j['status']).isEmpty ? 'active' : _s(j['status']),
      domain: _s(j['domain']).isEmpty ? 'memory' : _s(j['domain']),
    );
  }
}

String _kindFromCategory(String category) {
  switch (category) {
    case 'stable_profile':
      return 'profile';
    case 'promise':
    case 'promises':
      return 'promise';
    case 'preference':
      return 'preference';
    case 'insight':
      return 'insight';
    case 'event':
      return 'event';
    default:
      return category.isEmpty ? 'event' : category;
  }
}

class FishRecord {
  final String id;
  final String day;
  final String at;
  final String text;
  const FishRecord({this.id = '', this.day = '', this.at = '', this.text = ''});
  factory FishRecord.fromJson(Object? raw) {
    final j = _m(raw);
    return FishRecord(
      id: _s(j['id']),
      day: _s(j['day']),
      at: _s(j['at']),
      text: _s(j['text']),
    );
  }
}

class FishCollectionItem {
  final String name;
  final String url;
  final String note;
  final String kind;
  final String id;
  final String displayName;
  final List<String> tags;
  final int addedAt;
  final int useCount;
  final bool auto;
  const FishCollectionItem({
    this.name = '',
    this.url = '',
    this.note = '',
    this.kind = '',
    this.id = '',
    this.displayName = '',
    this.tags = const <String>[],
    this.addedAt = 0,
    this.useCount = 0,
    this.auto = false,
  });
  factory FishCollectionItem.fromJson(Object? raw) {
    final j = _m(raw);
    return FishCollectionItem(
      name: _s(j['name']),
      url: _s(j['url']),
      note: _s(j['note']),
      kind: _s(j['kind']),
      id: _s(j['id']),
      displayName: _s(j['displayName']),
      tags: [for (final e in (j['tags'] as List? ?? const [])) _s(e)],
      addedAt: _i(j['addedAt']),
      useCount: _i(j['useCount']),
      auto: _b(j['auto']),
    );
  }
}

/// 图库 / 网站链接都是「总数 + 前 N 条」。
class FishCollection {
  final int total;
  final List<FishCollectionItem> items;
  const FishCollection(
      {this.total = 0, this.items = const <FishCollectionItem>[]});
  factory FishCollection.fromJson(Object? raw) {
    final j = _m(raw);
    return FishCollection(
      total: _i(j['total']),
      items: [for (final e in _lm(j['items'])) FishCollectionItem.fromJson(e)],
    );
  }
  bool get isEmpty => items.isEmpty;
}

class FishMemory {
  final int knowledgeEntries;
  final int knowledgeChars;
  final String knowledgeUpdatedAt;
  final String knowledgeFile;
  final List<FishPersona> personas;
  final String active;
  final int memoriesTotal;
  final int tracesScanned;
  final List<FishMemoryEntry> memories;
  final List<FishRecord> records;
  final FishCollection gallery;
  final FishCollection links;
  final String digestDay;
  final int digestCount;
  final int digestChars;
  const FishMemory({
    this.knowledgeEntries = 0,
    this.knowledgeChars = 0,
    this.knowledgeUpdatedAt = '',
    this.knowledgeFile = '',
    this.personas = const <FishPersona>[],
    this.active = '',
    this.memoriesTotal = 0,
    this.tracesScanned = 0,
    this.memories = const <FishMemoryEntry>[],
    this.records = const <FishRecord>[],
    this.gallery = const FishCollection(),
    this.links = const FishCollection(),
    this.digestDay = '',
    this.digestCount = 0,
    this.digestChars = 0,
  });
  factory FishMemory.fromJson(Object? raw) {
    final j = _m(raw);
    final knowledge = _m(j['knowledge']);
    final memories = _m(j['memories']);
    final digest = _m(j['digest']);
    return FishMemory(
      knowledgeEntries: _i(knowledge['entries']),
      knowledgeChars: _i(knowledge['chars']),
      knowledgeUpdatedAt: _s(knowledge['updatedAt']),
      knowledgeFile: _s(knowledge['file']),
      personas: [for (final e in _lm(j['personas'])) FishPersona.fromJson(e)],
      active: _s(j['active']),
      memoriesTotal: _i(memories['total']),
      tracesScanned: _i(memories['tracesScanned']),
      memories: [
        for (final e in _lm(memories['items'])) FishMemoryEntry.fromJson(e)
      ],
      records: [for (final e in _lm(j['records'])) FishRecord.fromJson(e)],
      gallery: FishCollection.fromJson(j['gallery']),
      links: FishCollection.fromJson(j['links']),
      digestDay: _s(digest['day']),
      digestCount: _i(digest['count']),
      digestChars: _i(digest['chars']),
    );
  }
}

class FishStorage {
  final String label;
  final String path;
  const FishStorage({this.label = '', this.path = ''});
  factory FishStorage.fromJson(Object? raw) {
    final j = _m(raw);
    return FishStorage(label: _s(j['label']), path: _s(j['path']));
  }
}

class FishProfile {
  final String name;
  final String ownerTitle;
  final String personaFile;
  final String personaText;
  final int personaLength;
  final String active;
  final List<FishPersona> roles;
  final List<FishStorage> storage;
  const FishProfile({
    this.name = '',
    this.ownerTitle = '',
    this.personaFile = '',
    this.personaText = '',
    this.personaLength = 0,
    this.active = '',
    this.roles = const <FishPersona>[],
    this.storage = const <FishStorage>[],
  });
  factory FishProfile.fromJson(Object? raw) {
    final j = _m(raw);
    return FishProfile(
      name: _s(j['name']),
      ownerTitle: _s(j['ownerTitle']),
      personaFile: _s(j['personaFile']),
      personaText: _s(j['personaText']),
      personaLength: _i(j['personaLength']),
      active: _s(j['active']),
      roles: [for (final e in _lm(j['roles'])) FishPersona.fromJson(e)],
      storage: [for (final e in _lm(j['storage'])) FishStorage.fromJson(e)],
    );
  }

  FishPersona? get currentRole {
    for (final r in roles) {
      if (r.id == active) return r;
    }
    return roles.isEmpty ? null : roles.first;
  }
}

/// QQ 平台的一行能力开关（只读展示；19 项由后端给，前端不硬编条数）。
class FishField {
  final String key;
  final String label;
  final String kind;
  final String hint;
  final String unit;
  final bool danger;
  final Object? value;
  final String group;
  final List<Map<String, String>> options;
  final num? min;
  final num? max;
  final num? step;
  const FishField({
    this.key = '',
    this.label = '',
    this.kind = 'text',
    this.hint = '',
    this.unit = '',
    this.danger = false,
    this.value,
    this.group = '',
    this.options = const [],
    this.min,
    this.max,
    this.step,
  });
  factory FishField.fromJson(Object? raw) {
    final j = _m(raw);
    return FishField(
      key: _s(j['key']),
      label: _s(j['label']),
      kind: _s(j['kind']).isEmpty ? 'text' : _s(j['kind']),
      hint: _s(j['hint']),
      unit: _s(j['unit']),
      danger: _b(j['danger']),
      value: j['value'],
      group: _s(j['group']),
      min: j['min'] is num ? j['min'] as num : null,
      max: j['max'] is num ? j['max'] as num : null,
      step: j['step'] is num ? j['step'] as num : null,
      options: [
        for (final e in _lm(j['options']))
          {'value': _s(_m(e)['value']), 'label': _s(_m(e)['label'])}
      ],
    );
  }

  bool get isBool => kind == 'bool';
  bool get isNumber =>
      kind == 'num' || kind == 'number' || (!isBool && value is num);

  /// bool 显开 / 关；num 显值 + 单位；text 显文本；缺数据显「—」。
  String get displayValue {
    if (isBool) return value == true ? '开' : '关';
    if (value == null) return '—';
    if (value is bool) return value == true ? '开' : '关';
    final text = value is num ? _numText(value) : _s(value);
    if (text.isEmpty) return '—';
    if (unit.isEmpty) return text;
    return text.endsWith(unit) ? text : '$text $unit';
  }
}

class FishChatTarget {
  final String type;
  final String id;
  final String title;
  final String session;
  final String mode;
  const FishChatTarget({
    this.type = '',
    this.id = '',
    this.title = '',
    this.session = '',
    this.mode = '',
  });
  factory FishChatTarget.fromJson(Object? raw) {
    final j = _m(raw);
    return FishChatTarget(
      type: _s(j['type']),
      id: _s(j['id']),
      title: _s(j['title']),
      session: _s(j['session']),
      mode: _s(j['mode']),
    );
  }
  String get typeLabel {
    switch (type) {
      case 'private':
        return '私聊';
      case 'group':
        return '群';
      default:
        return type.isEmpty ? '目标' : type;
    }
  }

  String get modeLabel {
    switch (mode) {
      case 'shy':
        return '社恐';
      case 'quiet':
        return '安静';
      case 'normal':
        return '正常';
      case 'active':
        return '活跃';
      case 'frenzy':
        return '狂热';
      default:
        return mode.isEmpty ? '—' : mode;
    }
  }
}

class FishBinding {
  final String type;
  final String number;
  final String title;
  const FishBinding({this.type = '', this.number = '', this.title = ''});
  factory FishBinding.fromJson(Object? raw) {
    final j = _m(raw);
    return FishBinding(
      type: _s(j['类型']).isEmpty ? _s(j['type']) : _s(j['类型']),
      number: _s(j['号码']).isEmpty ? _s(j['number']) : _s(j['号码']),
      title: _s(j['称呼']).isEmpty ? _s(j['title']) : _s(j['称呼']),
    );
  }
}

class FishQqActivity {
  final String day;
  final int days;
  final int total;
  final Map<String, int> byType;
  final bool capped;
  const FishQqActivity({
    this.day = '',
    this.days = 0,
    this.total = 0,
    this.byType = const <String, int>{},
    this.capped = false,
  });
  factory FishQqActivity.fromJson(Object? raw) {
    final j = _m(raw);
    final byTypeRaw = _m(j['byType']);
    return FishQqActivity(
      day: _s(j['day']),
      days: _i(j['days']),
      total: _i(j['total']),
      byType: {
        for (final e in byTypeRaw.entries) e.key: _i(e.value),
      },
      capped: _b(j['capped']),
    );
  }
}

class FishQqLog {
  final String at;
  final String kind;
  final String text;
  const FishQqLog({this.at = '', this.kind = '', this.text = ''});
  factory FishQqLog.fromJson(Object? raw) {
    final j = _m(raw);
    return FishQqLog(at: _s(j['at']), kind: _s(j['kind']), text: _s(j['text']));
  }
  String get kindLabel {
    switch (kind) {
      case 'receive':
        return '收到';
      case 'send':
        return '发送';
      case 'notice':
        return '通知';
      default:
        return kind.isEmpty ? '记录' : kind;
    }
  }
}

class FishQq {
  final bool installed;
  final bool enabled;
  final bool dryRun;
  final Map<String, Object?> config;
  final int enabledCount;
  final int fieldsTotal;
  final List<FishField> fields;
  final List<FishChatTarget> chats;
  final FishQqActivity activity;
  final int todayReceive;
  final int todaySend;
  final int todayGroups;
  final List<FishBinding> bindings;
  final List<FishQqLog> log;
  const FishQq({
    this.installed = false,
    this.enabled = false,
    this.dryRun = false,
    this.config = const <String, Object?>{},
    this.enabledCount = 0,
    this.fieldsTotal = 0,
    this.fields = const <FishField>[],
    this.chats = const <FishChatTarget>[],
    this.activity = const FishQqActivity(),
    this.todayReceive = 0,
    this.todaySend = 0,
    this.todayGroups = 0,
    this.bindings = const <FishBinding>[],
    this.log = const <FishQqLog>[],
  });
  factory FishQq.fromJson(Object? raw) {
    final j = _m(raw);
    final config = _m(j['config']);
    final platform = _m(j['platform']);
    final today = _m(j['today']);
    return FishQq(
      installed: _b(j['installed']),
      enabled: _b(j['enabled']),
      dryRun: _b(j['dryRun']),
      config: config,
      enabledCount: _i(platform['enabledCount']),
      fieldsTotal: _i(platform['total']),
      fields: [for (final e in _lm(platform['fields'])) FishField.fromJson(e)],
      chats: [for (final e in _lm(j['chats'])) FishChatTarget.fromJson(e)],
      activity: FishQqActivity.fromJson(j['activity']),
      todayReceive: _i(today['receive']),
      todaySend: _i(today['send']),
      todayGroups: _i(today['groups']),
      bindings: [for (final e in _lm(config['绑定'])) FishBinding.fromJson(e)],
      log: [for (final e in _lm(j['log'])) FishQqLog.fromJson(e)],
    );
  }

  /// 平台状态的一句话总结（总览 / 鱼与世界共用）。
  String get statusLabel {
    if (!installed) return '插件未安装';
    if (!enabled) return '未启用';
    return dryRun ? '已启用 · 试运行' : '已启用';
  }

  /// 读 config 里的一项，给展示文本：bool → 开/关，空 → 「—」。
  String configText(String key) {
    final value = config[key];
    if (value == null) return '—';
    if (value is bool) return value ? '开' : '关';
    if (value is num) return _numText(value);
    final text = _s(value);
    return text.isEmpty ? '—' : text;
  }

  /// 允许名单的一句话（类型 + 号码/群名）。
  String get chatsSummary {
    if (chats.isEmpty) return '—';
    return chats
        .map((c) => '${c.typeLabel} ${c.title.isEmpty ? c.id : c.title}')
        .join('、');
  }
}

class FishBili {
  final bool installed;
  final bool enabled;
  final int enabledCount;
  final int fieldsTotal;
  final List<FishField> fields;
  final String accountMid;
  final String accountName;
  final String ownerMid;
  final String ownerName;
  const FishBili({
    this.installed = false,
    this.enabled = false,
    this.enabledCount = 0,
    this.fieldsTotal = 0,
    this.fields = const <FishField>[],
    this.accountMid = '',
    this.accountName = '',
    this.ownerMid = '',
    this.ownerName = '',
  });
  factory FishBili.fromJson(Object? raw) {
    final j = _m(raw);
    final platform = _m(j['platform']);
    final account = _m(j['account']);
    final owner = _m(j['owner']);
    return FishBili(
      installed: _b(j['installed']),
      enabled: _b(j['enabled']),
      enabledCount: _i(platform['enabledCount']),
      fieldsTotal: _i(platform['total']),
      fields: [for (final e in _lm(platform['fields'])) FishField.fromJson(e)],
      accountMid: _s(account['mid']),
      accountName: _s(account['name']),
      ownerMid: _s(owner['mid']),
      ownerName: _s(owner['name']),
    );
  }
  String get statusLabel {
    if (!installed) return '插件未安装';
    return enabled ? '已启用' : '未启用';
  }
}


class FishActivityDay {
  final String day;
  final int total;
  final int owner;
  final int fish;
  const FishActivityDay({this.day = '', this.total = 0, this.owner = 0, this.fish = 0});
  factory FishActivityDay.fromJson(Object? raw) {
    final j = _m(raw);
    return FishActivityDay(day: _s(j['day']), total: _i(j['total']), owner: _i(j['owner']), fish: _i(j['fish']));
  }
}

class FishActivityRecord {
  final String at;
  final String day;
  final String platform;
  final String kind;
  final String actor;
  final String text;
  const FishActivityRecord({this.at = '', this.day = '', this.platform = '', this.kind = '', this.actor = '', this.text = ''});
  factory FishActivityRecord.fromJson(Object? raw) {
    final j = _m(raw);
    return FishActivityRecord(at: _s(j['at']), day: _s(j['day']), platform: _s(j['platform']), kind: _s(j['kind']), actor: _s(j['actor']), text: _s(j['text']));
  }
}

class FishWorldActivity {
  final int total;
  final int days;
  final String firstDay;
  final List<FishActivityDay> perDay;
  final List<FishActivityRecord> recent;
  final String today;
  final List<int> todayHours;
  const FishWorldActivity({this.total = 0, this.days = 0, this.firstDay = '', this.perDay = const [], this.recent = const [], this.today = '', this.todayHours = const []});
  factory FishWorldActivity.fromJson(Object? raw) {
    final j = _m(raw);
    return FishWorldActivity(
      total: _i(j['total']),
      days: _i(j['days']),
      firstDay: _s(_m(j['first'])['day']),
      perDay: [for (final e in _lm(j['perDay'])) FishActivityDay.fromJson(e)],
      recent: [for (final e in _lm(j['recent'])) FishActivityRecord.fromJson(e)],
      today: _s(j['today']),
      todayHours: [for (final e in (j['todayHours'] as List? ?? const [])) _i(e)],
    );
  }
}


class FishMoodEvent {
  final int at;
  final int delta;
  final String reason;
  const FishMoodEvent({this.at = 0, this.delta = 0, this.reason = ''});
  factory FishMoodEvent.fromJson(Object? raw) {
    final j = _m(raw);
    return FishMoodEvent(at: _i(j['at']), delta: _i(j['delta']), reason: _s(j['reason']));
  }
}

class FishMoodPoint {
  final int at;
  final int mood;
  final int delta;
  const FishMoodPoint({this.at = 0, this.mood = 0, this.delta = 0});
  factory FishMoodPoint.fromJson(Object? raw) {
    final j = _m(raw);
    return FishMoodPoint(at: _i(j['at']), mood: _i(j['mood']), delta: _i(j['delta']));
  }
}

class FishMood {
  final int? value;
  final Map<String, int> dims;
  final String reason;
  final int updatedAt;
  final List<FishMoodPoint> timeline;
  final List<FishMoodEvent> events;
  const FishMood({this.value, this.dims = const {}, this.reason = '', this.updatedAt = 0, this.timeline = const [], this.events = const []});
  bool get hasData => value != null || timeline.isNotEmpty || reason.isNotEmpty;
  factory FishMood.fromJson(Object? raw) {
    final j = _m(raw);
    final dims = _m(j['dims']);
    return FishMood(
      value: j['value'] is num ? (j['value'] as num).toInt() : null,
      dims: {for (final e in dims.entries) e.key: _i(e.value)},
      reason: _s(j['reason']),
      updatedAt: _i(j['updatedAt']),
      timeline: [for (final e in _lm(j['timeline'])) FishMoodPoint.fromJson(e)],
      events: [for (final e in _lm(j['events'])) FishMoodEvent.fromJson(e)],
    );
  }
}

class FishSnapshot {
  final bool ok;
  final String generatedAt;
  final List<String> roots;
  final List<String> errors;
  final FishOverview overview;
  final FishStatus status;
  final FishDiary diary;
  final FishWishes wishes;
  final FishGrowth growth;
  final FishMemory memory;
  final FishProfile profile;
  final FishQq qq;
  final FishBili bili;
  final FishWorldActivity activity;
  final FishMood mood;
  final FishCollection collectionsGallery;
  final FishCollection collectionsLinks;

  const FishSnapshot({
    this.ok = false,
    this.generatedAt = '',
    this.roots = const <String>[],
    this.errors = const <String>[],
    this.overview = const FishOverview(),
    this.status = const FishStatus(),
    this.diary = const FishDiary(),
    this.wishes = const FishWishes(),
    this.growth = const FishGrowth(),
    this.memory = const FishMemory(),
    this.profile = const FishProfile(),
    this.qq = const FishQq(),
    this.bili = const FishBili(),
    this.activity = const FishWorldActivity(),
    this.mood = const FishMood(),
    this.collectionsGallery = const FishCollection(),
    this.collectionsLinks = const FishCollection(),
  });

  /// 桥和快照都拿不到时的空态：页面据此显示「还没读到」，不拿 0 冒充数据。
  factory FishSnapshot.empty() => const FishSnapshot();

  factory FishSnapshot.fromJson(Map<String, dynamic> json) {
    final collections = _m(json['collections']);
    final errors = <String>[];
    final rawErrors = json['errors'];
    if (rawErrors is List) {
      for (final e in rawErrors) {
        if (e is Map) {
          final section = _s(e['section']);
          final message = _s(e['message']);
          if (section.isEmpty && message.isEmpty) continue;
          errors.add(section.isEmpty ? message : '$section：$message');
        } else if (_s(e).isNotEmpty) {
          errors.add(_s(e));
        }
      }
    }
    return FishSnapshot(
      ok: json['ok'] != false,
      generatedAt: _s(json['generatedAt']),
      roots: _ls(json['roots']),
      errors: errors,
      overview: FishOverview.fromJson(json['overview']),
      status: FishStatus.fromJson(json['status']),
      diary: FishDiary.fromJson(json['diary']),
      wishes: FishWishes.fromJson(json['wishes']),
      growth: FishGrowth.fromJson(json['growth']),
      memory: FishMemory.fromJson(json['memory']),
      profile: FishProfile.fromJson(json['profile']),
      qq: FishQq.fromJson(json['qq']),
      bili: FishBili.fromJson(json['bili']),
      activity: FishWorldActivity.fromJson(json['activity']),
      mood: FishMood.fromJson(json['mood']),
      collectionsGallery: FishCollection.fromJson(collections['gallery']),
      collectionsLinks: FishCollection.fromJson(collections['links']),
    );
  }

  /// 收藏页优先用 collections，缺了退回 memory 里同一份数据。
  FishCollection get gallery =>
      collectionsGallery.total > 0 || collectionsGallery.items.isNotEmpty
          ? collectionsGallery
          : memory.gallery;

  FishCollection get links =>
      collectionsLinks.total > 0 || collectionsLinks.items.isNotEmpty
          ? collectionsLinks
          : memory.links;
}

/// 数据入口：桥 → 打包快照 → 空态。
class FishWorld {
  /// 最近一次加载失败的原因；页面用它区分 error 与 empty。
  static String lastError = '';
  static bool _bridgeEmpty = false;
  FishWorld._();

  /// 测试注入用：设了就直接返回它，不走网络与 asset。
  static FishSnapshot? debugOverride;

  static Future<FishSnapshot>? _pending;

  static Future<FishSnapshot> load() {
    final override = debugOverride;
    if (override != null) return Future<FishSnapshot>.value(override);
    return _pending ??= _load();
  }

  /// 记忆动作写完之后的强制刷新：丢掉旧 future，重新走桥 / 快照。
  static Future<FishSnapshot> reload() {
    _pending = null;
    return load();
  }

  static Future<FishSnapshot> _load() async {
    lastError = '';
    _bridgeEmpty = false;
    final fromBridge = await _fromBridge();
    if (fromBridge != null) return fromBridge;
    final fromAsset = await _fromAsset();
    if (fromAsset != null) return fromAsset;
    if (_bridgeEmpty) lastError = '';
    return FishSnapshot.empty();
  }

  static Future<FishSnapshot?> _fromBridge() async {
    try {
      final json = await bridgeFishSnapshot();
      if (json == null) return null;
      if (json['ok'] == false) {
        final err = (json['error'] ?? '').toString();
        if (err.isNotEmpty) lastError = err; else _bridgeEmpty = true;
        return null;
      }
      final live = FishSnapshot.fromJson(json);
      final needsBili = live.bili.accountMid.isEmpty;
      final needsGallery = live.gallery.items.isNotEmpty && live.gallery.items.first.id.isEmpty;
      final needsVoice = live.wishes.voice.isEmpty;
      if (!needsBili && !needsGallery && !needsVoice) return live;
      final asset = await _fromAsset();
      if (asset == null) return live;
      final merged = Map<String, dynamic>.from(json);
      var changed = false;
      if (needsBili && asset.bili.accountMid.isNotEmpty) {
        final biliRaw = Map<String, dynamic>.from((merged['bili'] as Map?) ?? const {});
        biliRaw['account'] = {'mid': asset.bili.accountMid, 'name': asset.bili.accountName};
        biliRaw['owner'] = {'mid': asset.bili.ownerMid, 'name': asset.bili.ownerName};
        merged['bili'] = biliRaw;
        changed = true;
      }
      if (needsGallery && asset.gallery.items.isNotEmpty) {
        final byName = {for (final it in asset.gallery.items) it.name: it};
        final collections = Map<String, dynamic>.from((merged['collections'] as Map?) ?? const {});
        final gallery = Map<String, dynamic>.from((collections['gallery'] as Map?) ?? const {});
        final rawItems = (gallery['items'] as List?) ?? const [];
        gallery['items'] = [
          for (final raw in rawItems)
            if (raw is Map)
              {
                ...Map<String, dynamic>.from(raw),
                if ((raw['id'] ?? '').toString().isEmpty && byName[(raw['name'] ?? '').toString()] != null) ...{
                  'id': byName[(raw['name'] ?? '').toString()]!.id,
                  'displayName': byName[(raw['name'] ?? '').toString()]!.displayName,
                  'tags': byName[(raw['name'] ?? '').toString()]!.tags,
                  'addedAt': byName[(raw['name'] ?? '').toString()]!.addedAt,
                  'useCount': byName[(raw['name'] ?? '').toString()]!.useCount,
                  'auto': byName[(raw['name'] ?? '').toString()]!.auto,
                },
              }
            else raw,
        ];
        collections['gallery'] = gallery;
        merged['collections'] = collections;
        changed = true;
      }
      if (needsVoice && asset.wishes.voice.isNotEmpty) {
        final wishes = Map<String, dynamic>.from((merged['wishes'] as Map?) ?? const {});
        wishes['voice'] = asset.wishes.voice;
        merged['wishes'] = wishes;
        changed = true;
      }
      return changed ? FishSnapshot.fromJson(merged) : live;
    } catch (e) {
      lastError = e.toString();
      return null;
    }
  }

  static Future<FishSnapshot?> _fromAsset() async {
    try {
      final raw = await rootBundle.loadString('assets/data/fish_snapshot.json');
      final decoded = jsonDecode(raw);
      if (decoded is Map) {
        return FishSnapshot.fromJson(
            decoded.map((k, v) => MapEntry(k.toString(), v)));
      }
    } catch (e) {
      // 打包快照不存在或被裁掉：交给空态。
      if (lastError.isEmpty) lastError = e.toString();
    }
    return null;
  }

  /// 测试/重试时清掉进程内缓存（debugOverride 不受影响）。
  static void resetCache() {
    _pending = null;
  }
}
