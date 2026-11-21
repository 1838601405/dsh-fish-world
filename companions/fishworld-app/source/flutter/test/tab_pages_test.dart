import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/pages.dart';
import 'package:whale_girl/fish/fish_collections.dart';
import 'package:whale_girl/fish/fish_diary.dart';
import 'package:whale_girl/fish/fish_growth.dart';
import 'package:whale_girl/fish/fish_memory.dart';
import 'package:whale_girl/fish/fish_overview.dart';
import 'package:whale_girl/fish/fish_profile.dart';
import 'package:whale_girl/fish/fish_qq.dart';
import 'package:whale_girl/fish/fish_status.dart';
import 'package:whale_girl/fish/fish_wishes.dart';

void main() {
  final pages = <String, Widget>{
    '总览': const FishOverviewPage(),
    '鱼的状态': const FishStatusPage(),
    '鱼的记忆': const FishMemoryPage(),
    '鱼的日记': const FishDiaryPage(),
    '鱼的成长': const FishGrowthPage(),
    '鱼的请求': const FishWishesPage(),
    '鱼的收藏': const FishCollectionsPage(),
    '鱼的设定': const FishProfilePage(),
    '鱼与世界': const FishPlatformsPage(),
    '鱼的笔记': const NotesPage(),
    '关于': const AboutPage(),
  };
  for (final entry in pages.entries) {
    testWidgets('Tab 扫页：' + entry.key, (tester) async {
      tester.view.physicalSize = const Size(1500, 1000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: entry.value)));
      await tester.pump(const Duration(milliseconds: 500));
      var changes = 0;
      Object? last;
      for (var i = 0; i < 24; i++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pump(const Duration(milliseconds: 10));
        final f = tester.binding.focusManager.primaryFocus;
        if (f != null && f != last) changes++;
        last = f;
      }
      expect(tester.takeException(), isNull, reason: entry.key);
      // ignore: avoid_print
      print('TAB-PAGE ' + entry.key + ' focusChanges=' + changes.toString());
    });
  }
}
