// 交互动效件的验收：
//   a) 桌宠两个动作同时触发时不互相覆盖
//   b) 输入框聚焦有渐变扫光边框、失焦回静态
//   c) 骨架屏在动（微光流动）、弹层遮罩是压暗（深 55% / 浅 28%）
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/ui_motion.dart';

Widget _host(Widget child) => MaterialApp(home: Scaffold(body: Center(child: child)));

void main() {
  testWidgets('a) 桌宠分层：触发爱心不会打断摆尾，两层同时活着', (tester) async {
    final vsync = const TestVSync();
    final c = LayeredPetController(vsync: vsync, frames: const {
      PetLayer.breathing: 10,
      PetLayer.tail: 10,
      PetLayer.heart: 6,
    });
    addTearDown(c.dispose);
    c.trigger(PetLayer.breathing);
    c.trigger(PetLayer.tail);
    await tester.pumpWidget(_host(LayeredPet(controller: c, size: 80)));
    await tester.pump(const Duration(milliseconds: 50));

    expect(c.isActive(PetLayer.tail), isTrue, reason: '摆尾应在跑');
    // 再叠一层爱心：只加层，不替换
    c.trigger(PetLayer.heart);
    await tester.pump(const Duration(milliseconds: 16));
    expect(c.isActive(PetLayer.tail), isTrue, reason: '叠爱心后摆尾不能被停掉');
    expect(c.isActive(PetLayer.heart), isTrue, reason: '爱心层应同时在跑');
    expect(c.activeLayers, containsAll(<String>[PetLayer.tail, PetLayer.heart]));

    // 爱心跑完自己收，摆尾还在
    await tester.pump(const Duration(seconds: 1));
    expect(c.isActive(PetLayer.heart), isFalse, reason: '爱心是一次性的');
    expect(c.isActive(PetLayer.tail), isTrue, reason: '摆尾是常驻层');
  });

  testWidgets('b) 输入框：聚焦是渐变扫光（painter 在），失焦是静态描边', (tester) async {
    Widget build(bool focused) => _host(FocusSweepBorder(
          focused: focused,
          radius: 14,
          child: const SizedBox(width: 200, height: 40),
        ));

    await tester.pumpWidget(build(false));
    await tester.pump();
    var paint = tester.widget<CustomPaint>(
      find.descendant(of: find.byType(FocusSweepBorder), matching: find.byType(CustomPaint)).first,
    );
    expect(paint.painter, isNull, reason: '失焦不该有扫光 painter（静止零开销）');
    expect(paint.foregroundPainter, isNotNull, reason: '失焦要有一圈静态描边');

    await tester.pumpWidget(build(true));
    await tester.pump(const Duration(milliseconds: 60));
    paint = tester.widget<CustomPaint>(
      find.descendant(of: find.byType(FocusSweepBorder), matching: find.byType(CustomPaint)).first,
    );
    expect(paint.painter, isNotNull, reason: '聚焦要有扫光 painter');

    // 失焦后动画停掉，回到静态
    await tester.pumpWidget(build(false));
    await tester.pump();
    final border = tester.state(find.byType(FocusSweepBorder));
    expect(tester.binding.hasScheduledFrame, isFalse,
        reason: '失焦后不该还在每帧调度（${border.runtimeType}）');
  });

  testWidgets('c1) 骨架屏微光：渐变位置随时间移动', (tester) async {
    await tester.pumpWidget(_host(const ShimmerBox(width: 160, height: 20)));
    await tester.pump();
    Alignment? beginOf() {
      final box = tester.widget<Container>(
        find.descendant(of: find.byType(ShimmerBox), matching: find.byType(Container)).first,
      );
      final decoration = box.decoration as BoxDecoration?;
      return (decoration?.gradient as LinearGradient?)?.begin as Alignment?;
    }

    final first = beginOf();
    await tester.pump(const Duration(milliseconds: 400));
    final second = beginOf();
    expect(first, isNotNull);
    expect(second, isNot(first), reason: '微光要流动，不能是死灰块');
  });

  test('c2) 弹层遮罩是压暗：深 55% / 浅 28%', () {
    expect(scrimOpacityFor(Brightness.dark), closeTo(0.55, 1e-9));
    expect(scrimOpacityFor(Brightness.light), closeTo(0.28, 1e-9));
  });

  testWidgets('c2) 弹层：BackdropFilter + 黑色遮罩（不是提亮）', (tester) async {
    await tester.pumpWidget(_host(
      const AppScrim(
        borderRadius: BorderRadius.zero,
        child: SizedBox(width: 120, height: 80),
      ),
    ));
    await tester.pump();
    expect(find.byType(BackdropFilter), findsOneWidget, reason: '背景要糊，不只是压平');
    final box = tester.widget<ColoredBox>(find.byType(ColoredBox).first);
    final color = box.color;
    expect(color.a, closeTo(0.28, 0.01), reason: '浅色下遮罩 28%');
    expect(color.r, closeTo(0, 0.01));
    expect(color.g, closeTo(0, 0.01));
    expect(color.b, closeTo(0, 0.01), reason: '遮罩是压暗，不是提亮');
  });

  testWidgets('长内容自适应收缩：ShrinkToFit 给一个 maxHeight，不硬裁', (tester) async {
    await tester.pumpWidget(_host(
      ShrinkToFit(
        maxHeightFactor: 0.5,
        child: Container(height: 2000, width: 100, color: Colors.blue),
      ),
    ));
    await tester.pump();
    final size = tester.getSize(find.byType(Container).first);
    final screen = tester.view.physicalSize.height / tester.view.devicePixelRatio;
    expect(size.height, lessThanOrEqualTo(screen * 0.5 + 0.5));
  });
}
