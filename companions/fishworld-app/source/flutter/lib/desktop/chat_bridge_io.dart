import 'dart:io';

import 'qq_service_io.dart';

Future<Map<String, dynamic>?> chatReply(
    List<Map<String, String>> history) async {
  final text = history.isEmpty ? '' : (history.last['content'] ?? '');
  final reply = await desktopLocalChat(text);
  if (reply.isEmpty) return null;
  return {'ok': true, 'reply': reply};
}

Stream<Map<String, String>> get chatEvents => desktopQqEvents;
