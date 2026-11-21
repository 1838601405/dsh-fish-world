import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/fish/fish_profile.dart';

// 主人绑定卡三态截图：只渲染卡片构造，不跑整页（整页首帧拉真实 IO 会挂死）。
// 一个 testWidgets 只截一态，避免 toImage 在同一个测试里反复 await。
// 说明：这是 widget 渲染器出图，不是真机窗口截图。
Future<void> shotOne(WidgetTester tester, String name,
    {required bool desktop,
    required String ownerQQ,
    required bool binding,
    required String boundQQ,
    required String boundAt,
    required bool failed,
    String replyMode = 'api',
    String failMsg = '本机配置写不进'}) async {
  tester.view.physicalSize = const Size(1400, 320);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  final key = GlobalKey();
  await tester.pumpWidget(MaterialApp(
    theme: ThemeData(
        brightness: Brightness.dark,
        useMaterial3: true,
        fontFamily: 'Msyh',
      ),
    home: RepaintBoundary(
      key: key,
      child: Material(
        color: const Color(0xFF0D111A),
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.start,
            children: buildOwnerBindingCardsForTest(
              desktop: desktop,
              ownerQQ: ownerQQ,
              binding: binding,
              boundQQ: boundQQ,
              boundAt: boundAt,
              failed: failed,
              replyMode: replyMode,
              failMsg: failMsg,
            ),
          ),
        ),
      ),
    ),
  ));
  await tester.pump(const Duration(milliseconds: 60));
  final boundary = key.currentContext!.findRenderObject() as RenderRepaintBoundary;
  final img = await boundary.toImage(pixelRatio: 1);
  final data = await img.toByteData(format: ui.ImageByteFormat.png);
  Directory('E:/WhaleGirl/docs/基准/主人绑定状态-20261121').createSync(recursive: true);
  File('E:/WhaleGirl/docs/基准/主人绑定状态-20261121/' + name)
      .writeAsBytesSync(data!.buffer.asUint8List());
}

Future<void> loadFonts() async {
  final loader = FontLoader('Msyh');
  final bytes = File('C:/Windows/Fonts/msyh.ttc').readAsBytesSync();
  loader.addFont(Future<ByteData>.value(ByteData.view(bytes.buffer)));
  await loader.load();
}

void main() {
  // 只在单独跑这个文件（--dart-define=OWNER_SHOT=true）时截图；
  // 全量跑时跳过，因为 toImage 在批量并发下会让整个套件挂住（实测 15 分钟无进展）。
  //
  // ★ 2026-11-21 按主人验收四条重排：
  //   a 未绑定（中性提示 + 一个输入框，无红/橙）
  //   b 已绑定（绿字 · 号 · 时间 · 模式；按钮是「保存」）
  //   c 失败但输入框保留新号（红字 + 原因）
  //   d 保存中（按钮 loading）
  final only = const bool.fromEnvironment('OWNER_SHOT');

  testWidgets('a 未绑定', (tester) async {
    if (!only) return;
    await loadFonts();
    await shotOne(tester, 'a-unbound.png',
        desktop: true,
        ownerQQ: '',
        binding: false,
        boundQQ: '',
        boundAt: '',
        failed: false);
  }, skip: !only);

  testWidgets('b 已绑定', (tester) async {
    if (!only) return;
    await loadFonts();
    await shotOne(tester, 'b-bound.png',
        desktop: true,
        ownerQQ: '1838601405',
        binding: false,
        boundQQ: '1838601405',
        boundAt: '17:35',
        failed: false,
        replyMode: 'api');
  }, skip: !only);

  testWidgets('c 换号失败（新号仍在原位）', (tester) async {
    if (!only) return;
    await loadFonts();
    // 关键：输入框里是**新号**（没被重置），已绑定行还是**老号**，
    // 同时出现红字原因 —— 这三样要同框，才能证明"失败没动用输入"。
    await shotOne(tester, 'c-failed-keeps-input.png',
        desktop: true,
        ownerQQ: '2100000001',
        binding: false,
        boundQQ: '1838601405',
        boundAt: '17:35',
        failed: true,
        failMsg: '回读是 1838601405，和输入的 2100000001 不一致');
  }, skip: !only);

  testWidgets('d 保存中', (tester) async {
    if (!only) return;
    await loadFonts();
    await shotOne(tester, 'd-saving.png',
        desktop: true,
        ownerQQ: '1838601405',
        binding: true,
        boundQQ: '',
        boundAt: '',
        failed: false);
  }, skip: !only);
}
