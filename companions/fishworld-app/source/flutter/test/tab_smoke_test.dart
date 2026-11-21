import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/main.dart';

void main() {
  testWidgets('Tab 连按 40 次不抛异常，焦点仍在树内', (tester) async {
    tester.view.physicalSize = const Size(1500, 1000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(const WhaleGirlApp());
    await tester.pump(const Duration(milliseconds: 300));
    for (var i = 0; i < 40; i++) {
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump(const Duration(milliseconds: 10));
    }
    expect(tester.takeException(), isNull);
    expect(tester.binding.focusManager.primaryFocus, isNotNull);
  });
}
