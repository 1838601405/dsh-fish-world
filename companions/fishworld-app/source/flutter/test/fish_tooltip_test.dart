// 回归：统一 FishTooltip 在切页时随页面 Overlay 销毁，不留残留。
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/app_shell.dart';
import 'package:whale_girl/fish_tooltip.dart';

void main() {
  testWidgets('切页后 tooltip 不残留', (tester) async {
    Widget page(String key) => MaterialApp(
          home: RoutePageOverlay(
            key: ValueKey(key),
            child: const Center(
              child: FishTooltip(message: '这页的提示', child: Text('handle')),
            ),
          ),
        );
    await tester.pumpWidget(page('a'));
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(find.text('handle')));
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.text('这页的提示'), findsOneWidget, reason: 'tooltip 没出现');

    await tester.pumpWidget(page('b'));
    await tester.pump();
    expect(find.text('这页的提示'), findsNothing, reason: '切页后 tooltip 还挂着');
    await mouse.removePointer();
  });
}
