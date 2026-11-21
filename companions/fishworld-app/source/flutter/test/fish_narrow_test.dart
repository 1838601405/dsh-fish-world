// 窄屏（390×844）卡片不溢出回归：日记/请求/成长/记忆/收藏/QQ 各泵一次，有溢出即 takeException 非空。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/fish/fish_collections.dart';
import 'package:whale_girl/fish/fish_diary.dart';
import 'package:whale_girl/fish/fish_growth.dart';
import 'package:whale_girl/fish/fish_memory.dart';
import 'package:whale_girl/fish/fish_qq.dart';
import 'package:whale_girl/fish/fish_wishes.dart';

void main() {
  final pages = <String, Widget>{
    '鱼的日记': const FishDiaryPage(),
    '鱼的请求': const FishWishesPage(),
    '鱼的成长': const FishGrowthPage(),
    '鱼的记忆': const FishMemoryPage(),
    '鱼的收藏': const FishCollectionsPage(),
    '鱼与世界': const FishPlatformsPage(),
  };
  for (final entry in pages.entries) {
    testWidgets('窄屏不溢出：${entry.key}', (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: entry.value)));
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pump(const Duration(milliseconds: 500));
      // 各页可能是 FishCard 卡片墙，也可能是自定义布局；断言页面本身渲染出来。
      expect(find.byWidget(entry.value), findsOneWidget, reason: '${entry.key} 没渲染出页面');
      expect(tester.takeException(), isNull, reason: '${entry.key} 在 390 宽溢出');
      // 清掉页面（尤其 QQ 页的 4s 轮询 Timer）
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump(const Duration(milliseconds: 50));
    });
  }
}