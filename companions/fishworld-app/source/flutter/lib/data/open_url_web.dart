// ignore_for_file: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:html' as html;

/// 新标签打开登录页；被拦截返回 false。
bool openUrl(String url) {
  html.window.open(url, '_blank');
  return true;
}
