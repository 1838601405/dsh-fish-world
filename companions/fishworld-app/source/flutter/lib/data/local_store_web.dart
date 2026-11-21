// ignore_for_file: deprecated_member_use, avoid_web_libraries_in_flutter
import 'dart:html' as html;

String? readLocal(String key) {
  try { return html.window.localStorage[key]; } catch (e) { return null; }
}

void writeLocal(String key, String value) {
  try { html.window.localStorage[key] = value; } catch (e) { /* 忽略 */ }
}
