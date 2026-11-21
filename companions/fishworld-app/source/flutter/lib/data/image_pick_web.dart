// ignore_for_file: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:async';
import 'dart:convert';
import 'dart:html' as html;

/// 让用户选一张本地图，返回 base64（不含 data: 前缀）。取消返回空串。
Future<String> pickImageBase64() async {
  final input = html.FileUploadInputElement()..accept = 'image/*';
  input.click();
  final done = Completer<String>();
  input.onChange.listen((_) {
    final files = input.files;
    if (files == null || files.isEmpty) { if (!done.isCompleted) done.complete(''); return; }
    final reader = html.FileReader();
    reader.readAsDataUrl(files.first);
    reader.onLoadEnd.listen((_) {
      final raw = (reader.result ?? '').toString();
      final i = raw.indexOf(',');
      if (!done.isCompleted) done.complete(i >= 0 ? raw.substring(i + 1) : '');
    });
    reader.onError.listen((_) { if (!done.isCompleted) done.complete(''); });
  });
  return done.future.timeout(const Duration(minutes: 3), onTimeout: () => '');
}
