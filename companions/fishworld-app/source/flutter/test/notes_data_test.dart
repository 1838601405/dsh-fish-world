import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/data/notes_local_io.dart';
import 'package:whale_girl/data/notes_source_common.dart';
import 'package:whale_girl/data/notes_source_io.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('插件版加载链', () {
    test('桥有数据优先', () async {
      final got = await loadNotesChain(
        bridge: () async => {'ok': true, 'items': [{'id': 'b1', 'title': '桥'}]},
        asset: () async => [{'id': 'a1', 'title': '快照'}],
      );
      expect(got.source, 'bridge');
      expect(got.items.single['title'], '桥');
    });

    test('桥没数据回落 assets', () async {
      final got = await loadNotesChain(
        bridge: () async => null,
        asset: () async => [{'id': 'a1', 'title': '快照'}],
      );
      expect(got.source, 'asset');
      expect(got.items.length, 1);
    });

    test('桥和 assets 都没有 -> 空态，不是 error', () async {
      final got = await loadNotesChain(
        bridge: () async => null,
        asset: () async => null,
      );
      expect(got.source, 'empty');
      expect(got.items, isEmpty);
      expect(got.notice, '本地还没有笔记数据');
    });
  });

  group('桌面本地笔记', () {
    late Directory tmp;
    setUp(() async {
      tmp = await Directory.systemTemp.createTemp('fish-notes-');
      useNotesDirForTest(tmp.path);
    });
    tearDown(() async {
      resetNotesDirForTest();
      try { await tmp.delete(recursive: true); } catch (_) {}
    });

    test('首次读取与 assets 条数一致，写入后回读一致', () async {
      final asset = jsonDecode(await File('assets/data/notes.json').readAsString()) as Map<String, dynamic>;
      final assetCount = (asset['items'] as List).length;
      final first = await readLocalNotes();
      expect(first.length, assetCount);
      final r = await saveLocalNote(title: '测试写入', body: '正文', folder: '测试');
      expect(r['ok'], true);
      final again = await readLocalNotes();
      expect(again.any((e) => e['title'] == '测试写入'), true);
      expect(await File(tmp.path + Platform.pathSeparator + 'notes.json.bak').exists(), true);
      expect(await File(tmp.path + Platform.pathSeparator + 'notes.json.tmp').exists(), false);
    });

    test('删除进回收站，不直接丢', () async {
      final r = await saveLocalNote(title: '待删除', body: '正文', folder: '测试');
      final id = (r['item'] as Map)['id'].toString();
      final del = await deleteLocalNote(id);
      expect(del['ok'], true);
      final recycle = Directory(tmp.path + Platform.pathSeparator + '回收站');
      expect(await recycle.exists(), true);
      expect((await recycle.list().toList()).isNotEmpty, true);
      final left = await readLocalNotes();
      expect(left.any((e) => e['id'] == id), false);
    });

    test('未知高版本 -> 只读并提示', () async {
      final f = File(tmp.path + Platform.pathSeparator + 'notes.json');
      await f.writeAsString('{"version":2,"items":[]}');
      resetNotesDirForTest();
      useNotesDirForTest(tmp.path);
      final items = await readLocalNotes();
      expect(items, isEmpty);
      expect(canWrite, false);
      expect(readOnlyReason.contains('v2'), true);
      final r = await saveLocalNote(title: 'x', body: 'y', folder: 'z');
      expect(r['ok'], false);
    });
    test('写后重启仍在；移动后分组变化', () async {
      final saved = await saveLocalNote(title: '重启测试', body: '正文', folder: '原分组');
      final id = (saved['item'] as Map)['id'].toString();
      resetNotesDirForTest();
      useNotesDirForTest(tmp.path);
      final reopened = await readLocalNotes();
      expect(reopened.any((e) => e['id'] == id), true);
      final moved = await moveLocalNote(id, '新分组');
      expect(moved['ok'], true);
      final after = await readLocalNotes();
      expect(after.firstWhere((e) => e['id'] == id)['folder'], '新分组');
    });

    test('桌面 NotesSource 写入后重启读得到', () async {
      final saved = await NotesSource.save(title: '界面保存', body: '正文', folder: '测试');
      expect(saved?['ok'], true);
      resetNotesDirForTest();
      useNotesDirForTest(tmp.path);
      final got = await NotesSource.load();
      expect(got.items.any((e) => e['title'] == '界面保存'), true);
    });

    test('锁被占用 -> 只读，写被拒绝', () async {
      final lock = File(tmp.path + Platform.pathSeparator + 'notes.lock');
      final raf = await lock.open(mode: FileMode.append);
      await raf.lock(FileLock.exclusive);
      resetNotesDirForTest();
      useNotesDirForTest(tmp.path);
      try {
        await readLocalNotes();
        expect(canWrite, false);
        expect(readOnlyReason.contains('另一个窗口'), true);
        final r = await saveLocalNote(title: 'x', body: 'y', folder: 'z');
        expect(r['ok'], false);
      } finally {
        await raf.unlock();
        await raf.close();
      }
    });

  });
}
