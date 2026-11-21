import '../data/bridge.dart';

Future<Map<String, dynamic>?> chatReply(List<Map<String, String>> history) =>
    bridgeChat(history);

Stream<Map<String, String>> get chatEvents =>
    const Stream<Map<String, String>>.empty();
