import 'dart:convert';

import 'package:flutter/services.dart';

/// Web 预览：没有本地文件系统，读打包快照；写操作明确拒绝。
Future<List<Map<String, dynamic>>> readLocalNotes() async {
  try {
    final raw = await rootBundle.loadString('assets/data/notes.json');
    final j = jsonDecode(raw);
    final list = j is Map ? (j['items'] as List?) ?? const [] : (j as List);
    return [for (final e in list) Map<String, dynamic>.from(e as Map)];
  } catch (_) {
    return const [];
  }
}

Future<Map<String, dynamic>> saveLocalNote({String? id, required String title, required String body, required String folder}) async =>
    {'ok': false, 'error': '网页预览不能保存到本地'};
Future<Map<String, dynamic>> deleteLocalNote(String id) async => {'ok': false, 'error': '网页预览不能删除本地笔记'};
Future<Map<String, dynamic>> moveLocalNote(String id, String folder) async => {'ok': false, 'error': '网页预览不能移动本地笔记'};
