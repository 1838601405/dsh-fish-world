import 'dart:io';

/// 桌面端：用系统默认浏览器打开。
bool openUrl(String url) {
  try {
    Process.run('cmd', ['/c', 'start', '', url], runInShell: true);
    return true;
  } catch (_) {
    return false;
  }
}
