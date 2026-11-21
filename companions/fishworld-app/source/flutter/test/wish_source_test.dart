import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/data/fish_data.dart';
import 'package:whale_girl/data/wish_source_io.dart';
import 'package:whale_girl/fish/fish_wishes.dart';

void main() {
  test('桌面 pending.json 有候选 -> 图文件在才算', () async {
    final tmp = await Directory.systemTemp.createTemp('wish-test-');
    final dir = Directory(tmp.path + Platform.pathSeparator + '鱼的请求' + Platform.pathSeparator + '想收藏');
    await dir.create(recursive: true);
    final img = File(dir.path + Platform.pathSeparator + 'sw-1.png');
    await img.writeAsBytes([1, 2, 3]);
    await File(dir.path + Platform.pathSeparator + 'pending.json').writeAsString(jsonEncode({
      'version': 1,
      'items': [
        {'id': 'sw-1', 'file': 'sw-1.png', 'name': '候选图', 'reason': '因为好看'},
        {'id': 'sw-2', 'file': 'missing.png', 'name': '丢了', 'reason': 'x'},
      ],
    }));
    final r = await stickerWishesLoad([tmp.path]);
    expect(r['ok'], true);
    expect((r['items'] as List).length, 1);
    expect(wishImageProvider('sw-1', 'sw-1.png', [tmp.path]), isNotNull);
    await tmp.delete(recursive: true);
  });

  test('没有目录 -> 空列表，不当错误', () async {
    final r = await stickerWishesLoad(['Z:/definitely-not-here']);
    expect(r['ok'], true);
    expect(r['items'], isEmpty);
    expect(r['soft'], true);
  });

  testWidgets('无候选时显示空态+重试，不出现没连上', (tester) async {
    FishWorld.debugOverride = FishSnapshot.fromJson({'ok': true, 'roots': <String>[], 'wishes': {'items': <Map<String, dynamic>>[]}, 'collections': {'gallery': {'items': <Map<String, dynamic>>[]}}});
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: FishWishesPage())));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
    await tester.pump();
    expect(find.text('这台机器上还没有想收藏的图'), findsOneWidget);
    expect(find.text('重试'), findsOneWidget);
    expect(find.textContaining('没连上'), findsNothing);
    FishWorld.debugOverride = null;
  });
}
