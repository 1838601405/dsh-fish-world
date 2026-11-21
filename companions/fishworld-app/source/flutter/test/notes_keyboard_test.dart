import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/pages.dart';
import 'package:whale_girl/notes_canvas.dart';
import 'package:whale_girl/data/whale_data.dart';

void main() {
  testWidgets('鱼的笔记：Enter 打开选中笔记，Esc 关闭', (tester) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: NotesPage(initialNotes: const [
        NoteItem(id: 'n1', title: '测试笔记', body: '正文', folder: ''),
      ])),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('编辑笔记'), findsWidgets);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('编辑笔记'), findsNothing);
  });

  testWidgets('鱼的笔记：Ctrl+S 保存（注入，不写真实文件）', (tester) async {
    var saved = false;
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: NotesPage(
        initialNotes: const [NoteItem(id: 'n1', title: '测试笔记', body: '正文', folder: '')],
        saveNote: ({String? id, required String title, required String body, required String folder}) async {
          saved = true;
          return {'ok': true};
        },
      )),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyS);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(saved, isTrue);
  });

  testWidgets('笔记画布：Alt+方向键移动节点（注入）', (tester) async {
    double? movedX;
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: NotesCanvas(
        items: const [NoteItem(id: 'n1', title: '测试笔记', body: '正文', x: 10, y: 20)],
        onOpen: (_) {},
        onMove: (n, x, y) async { movedX = x; },
      )),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
    await tester.pump();
    expect(movedX, isNotNull);
  });
}
