import 'dart:io';

/// 桌面启动参数/环境变量：--theme=light 或 FISH_THEME=light。
/// 只用于截图/测试；正式默认仍是深色。
String bootTheme() {
  try {
    for (final a in Platform.executableArguments) {
      if (a.startsWith('--theme=')) return a.substring('--theme='.length);
    }
    return Platform.environment['FISH_THEME'] ?? '';
  } catch (_) {
    return '';
  }
}
