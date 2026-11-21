// 回归：拖拽 feedback 挂在页面级 Overlay，切页必须一起销毁。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/app_shell.dart';

void main() {
  testWidgets('拖起后切页，拖拽幽灵随旧 Overlay 消失', (tester) async {
    Widget page(String key, Widget child) => MaterialApp(
          home: RoutePageOverlay(key: ValueKey(key), child: child),
        );
    await tester.pumpWidget(page(
      'a',
      const Center(
        child: Draggable<String>(
          data: 'x',
          feedback: Material(child: Text('ghost')),
          child: Text('handle'),
        ),
      ),
    ));
    final gesture = await tester.startGesture(tester.getCenter(find.text('handle')));
    await tester.pump();
    await gesture.moveBy(const Offset(40, 40));
    await tester.pump();
    expect(find.text('ghost'), findsOneWidget, reason: '拖拽 feedback 没进页内 Overlay');

    await tester.pumpWidget(page('b', const Text('page b')));
    await tester.pump();
    expect(find.text('ghost'), findsNothing, reason: '切页后旧拖拽 feedback 还在');
    await gesture.up();
  });
}
