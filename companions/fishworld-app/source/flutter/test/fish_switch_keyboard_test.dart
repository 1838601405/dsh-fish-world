import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/fish/ui_kit/ui_kit.dart';

void main() {
  testWidgets('FishSwitch：Tab 聚焦后 Enter 切换', (tester) async {
    bool? changed;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: Center(child: FishSwitch(value: false, onChanged: (v) => changed = v))),
    ));
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(changed, isTrue);
  });
}
