import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/data/fish_data.dart';
import 'package:whale_girl/fish/fish_status.dart';

void main() {
  testWidgets('英雄卡只显示一句状态，不显示记忆原文', (tester) async {
    FishWorld.debugOverride = FishSnapshot.fromJson({
      'ok': true,
      'roots': <String>[],
      'overview': {},
      'status': {'day': '2026-11-15', 'text': '【记忆边界】这是记忆条目，不是状态。后面还有一大段。'},
      'mood': {'reason': '在厨房翻仓库，等主人下一个问题。', 'value': 80},
      'collections': {'gallery': {'items': <Map<String, dynamic>>[]}},
      'wishes': {'items': <Map<String, dynamic>>[]},
      'growth': {},
    });
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: FishStatusPage())));
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('在厨房翻仓库，等主人下一个问题。'), findsWidgets);
    FishWorld.debugOverride = null;
  });
}
