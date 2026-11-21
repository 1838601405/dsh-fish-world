import 'dart:convert';
import 'package:flutter/services.dart';

/// 从导出的快照读取（tools/export_flutter_data.mjs 生成 flutter/assets/data/*.json）。
/// + 以后接 HTTP 桥时，只需换这一层的实现，页面不用动。
class NoteItem {
  final String id;
  final String title;
  final String body;
  final String folder;
  final String mtime;
  final String src;
  final String srcKind;
  final double x;
  final double y;
  final String parent;
  final List<String> links;
  const NoteItem({required this.id, required this.title, this.body = '', this.folder = '', this.mtime = '', this.src = '', this.srcKind = '', this.x = 0, this.y = 0, this.parent = '', this.links = const <String>[]});
  factory NoteItem.fromJson(Map<String, dynamic> j) => NoteItem(
        id: (j['id'] ?? '').toString(),
        title: (j['title'] ?? '').toString(),
        body: (j['body'] ?? '').toString(),
        folder: (j['folder'] ?? '').toString(),
        mtime: (j['mtime'] ?? '').toString(),
        src: (j['src'] ?? '').toString(),
        srcKind: (j['srcKind'] ?? '').toString(),
        x: (j['x'] is num) ? (j['x'] as num).toDouble() : 0,
        y: (j['y'] is num) ? (j['y'] as num).toDouble() : 0,
        parent: (j['parent'] ?? '').toString(),
        links: (j['links'] is List) ? (j['links'] as List).map((e) => e.toString()).toList() : const <String>[],
      );
}

class PersonaItem {
  final String id;
  final String name;
  final String preview;
  final int length;
  const PersonaItem({required this.id, required this.name, required this.preview, required this.length});
  factory PersonaItem.fromJson(Map<String, dynamic> j) => PersonaItem(
        id: (j['id'] ?? '').toString(),
        name: (j['name'] ?? '未命名').toString(),
        preview: (j['preview'] ?? '').toString(),
        length: (j['length'] is int) ? j['length'] as int : int.tryParse((j['length'] ?? '').toString()) ?? 0,
      );
}

class MemorySnapshot {
  final String active;
  final List<PersonaItem> personas;
  const MemorySnapshot({required this.active, required this.personas});
}

class WhaleData {
  static Future<List<NoteItem>> notes() async {
    final s = await rootBundle.loadString('assets/data/notes.json');
    final j = jsonDecode(s) as Map<String, dynamic>;
    final items = (j['items'] as List?) ?? const [];
    return items.map((e) => NoteItem.fromJson(e as Map<String, dynamic>)).toList();
  }

  static Future<MemorySnapshot> memory() async {
    final s = await rootBundle.loadString('assets/data/memory.json');
    final j = jsonDecode(s) as Map<String, dynamic>;
    final list = ((j['personas'] as List?) ?? const [])
        .map((e) => PersonaItem.fromJson(e as Map<String, dynamic>))
        .toList();
    return MemorySnapshot(active: (j['active'] ?? '').toString(), personas: list);
  }
}

class GrowthItem {
  final String day;
  final String kind;
  final String text;
  final String quote;
  const GrowthItem({required this.day, required this.kind, required this.text, required this.quote});
  factory GrowthItem.fromJson(Map<String, dynamic> j) => GrowthItem(
        day: (j['day'] ?? '').toString(),
        kind: (j['kind'] ?? '').toString(),
        text: (j['text'] ?? '').toString(),
        quote: (j['quote'] ?? '').toString(),
      );
}

class SimpleItem {
  final String name;
  const SimpleItem({required this.name});
  factory SimpleItem.fromJson(Map<String, dynamic> j) => SimpleItem(name: (j['name'] ?? '').toString());
}

/// 其余页的数据读取（成长/愿望/图库/链接）——同一套快照机制。
class WhaleDataMore {
  static Future<List<GrowthItem>> growth() async {
    final s = await rootBundle.loadString('assets/data/growth.json');
    final j = jsonDecode(s) as Map<String, dynamic>;
    return ((j['items'] as List?) ?? const [])
        .map((e) => GrowthItem.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  static Future<List<SimpleItem>> simple(String file) async {
    final s = await rootBundle.loadString('assets/data/$file');
    final j = jsonDecode(s) as Map<String, dynamic>;
    return ((j['items'] as List?) ?? const [])
        .map((e) => SimpleItem.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  static Future<List<SimpleItem>> wish() => simple('wish.json');
  static Future<List<SimpleItem>> gallery() => simple('gallery.json');
  static Future<List<SimpleItem>> links() => simple('links.json');
}

class DiaryItem {
  final String date;
  final String who;
  final String status;
  final String text;
  const DiaryItem({required this.date, required this.who, required this.status, required this.text});
  factory DiaryItem.fromJson(Map<String, dynamic> j) => DiaryItem(
        date: (j['date'] ?? '').toString(),
        who: (j['who'] ?? '').toString(),
        status: (j['status'] ?? '').toString(),
        text: (j['text'] ?? '').toString(),
      );
}

/// 日记读取入口
class WhaleDiary {
  static Future<List<DiaryItem>> load() async {
    final s = await rootBundle.loadString('assets/data/diary.json');
    final j = jsonDecode(s) as Map<String, dynamic>;
    return ((j['items'] as List?) ?? const [])
        .map((e) => DiaryItem.fromJson(e as Map<String, dynamic>))
        .toList();
  }
}
