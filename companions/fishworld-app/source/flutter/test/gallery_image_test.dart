import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/data/gallery_image_common.dart' hide galleryRemove, galleryUndo;
import 'package:whale_girl/data/gallery_image_io.dart';

void main() {
  test('桌面图库路径按 鱼之宝库/图库 解析', () async {
    final tmp = await Directory.systemTemp.createTemp('gallery-test-');
    final dir = Directory(tmp.path + Platform.pathSeparator + '鱼之宝库' + Platform.pathSeparator + '图库');
    await dir.create(recursive: true);
    final f = File(dir.path + Platform.pathSeparator + 'a.png');
    await f.writeAsBytes([1, 2, 3]);
    expect(galleryLocalPath([tmp.path], 'a.png'), f.path);
    expect(galleryLocalPath([tmp.path], 'missing.png'), isNull);
    expect(galleryProviderFor('a.png', [tmp.path]), isNotNull);
    await tmp.delete(recursive: true);
  });

  test('name 含目录/绝对路径直接拒绝', () {
    expect(galleryLocalPath([], '../x.png'), isNull);
    expect(galleryLocalPath([], 'a/b.png'), isNull);
    expect(galleryLocalPath([], r'a\b.png'), isNull);
    expect(galleryLocalPath([], 'C:\\Windows\\x.png'), isNull);
    expect(safeGalleryName('正常.png'), true);
  });

  test('桌面删除进回收站，撤销回到图库', () async {
    final tmp = await Directory.systemTemp.createTemp('gallery-del-');
    final dir = Directory(tmp.path + Platform.pathSeparator + '鱼之宝库' + Platform.pathSeparator + '图库');
    await dir.create(recursive: true);
    final f = File(dir.path + Platform.pathSeparator + 'del.png');
    await f.writeAsBytes([1, 2, 3]);
    final r = await galleryRemove('del.png', [tmp.path]);
    expect(r?['ok'], true);
    expect(f.existsSync(), false);
    final recycled = r!['recycled'].toString();
    expect(File(recycled).existsSync(), true);
    final u = await galleryUndo(recycled, 'del.png');
    expect(u?['ok'], true);
    expect(f.existsSync(), true);
    // 回收站里的副本在 Windows 上可能还被句柄占着，删不掉只是清理失败，
    // 不代表产品坏了 —— 别让它把这个用例判红（实测偶发 errno 145）。
    try {
      await tmp.delete(recursive: true);
    } catch (_) {}
  });

  testWidgets('没图时是统一占位，不裂图', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: SizedBox(width: 100, height: 100, child: GalleryThumb(name: '坏图.png', roots: [])))));
    expect(find.text('坏图.png'), findsOneWidget);
    expect(find.byIcon(Icons.image_outlined), findsOneWidget);
  });
}
