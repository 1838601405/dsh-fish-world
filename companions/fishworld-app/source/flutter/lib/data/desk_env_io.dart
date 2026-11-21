import 'dart:io' show Platform;

/// 桌面端：flutter test 会设 FLUTTER_TEST 环境变量。
bool get isUnderFlutterTest => Platform.environment.containsKey('FLUTTER_TEST');
