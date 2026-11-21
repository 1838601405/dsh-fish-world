import 'package:flutter/foundation.dart';

enum MessageRole { ai, user }

class ChatMessage {
  final String id;
  final MessageRole role;
  final String text;
  final DateTime time;
  final bool isProactive;
  const ChatMessage({required this.id, required this.role, required this.text, required this.time, this.isProactive = false});
}

/// 全局对话流：侧栏气泡之外的「一句原话」都落到这里，聊天面板直接展示。
final List<ChatMessage> chatFeed = [
  ChatMessage(id: 'm1', role: MessageRole.ai, text: '嗨，我是蓝鲸娘～', time: DateTime.now(), isProactive: true),
  ChatMessage(id: 'm2', role: MessageRole.user, text: '今天天气怎么样？', time: DateTime.now()),
];

final ValueNotifier<int> chatFeedTick = ValueNotifier<int>(0);

void addChatMessage(String text, {MessageRole role = MessageRole.ai, bool proactive = false}) {
  final t = text.trim();
  if (t.isEmpty) return;
  chatFeed.add(ChatMessage(id: 'm' + (chatFeed.length + 1).toString(), role: role, text: t, time: DateTime.now(), isProactive: proactive));
  chatFeedTick.value = chatFeedTick.value + 1;
}

void clearChatFeed() {
  chatFeed.clear();
  chatFeedTick.value = chatFeedTick.value + 1;
}
