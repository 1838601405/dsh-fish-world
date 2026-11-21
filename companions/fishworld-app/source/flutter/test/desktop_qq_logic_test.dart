import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/desktop/qq_service_io.dart';

void main() {
  test('QQ 事件转 chatKey：只认私聊/群', () {
    expect(debugChatKey({'message_type': 'private', 'user_id': 10001}),
        'private:10001');
    expect(debugChatKey({'message_type': 'group', 'group_id': 681145756}),
        'group:681145756');
    expect(debugChatKey({'message_type': 'guild', 'user_id': 1}), '');
  });

  test('白名单过滤：未开启的 chatKey 不进', () {
    final allow = <String>{'group:681145756'};
    expect(allowChatKey(allow, 'group:681145756'), isTrue);
    expect(allowChatKey(allow, 'group:999'), isFalse);
    expect(allowChatKey(allow, 'private:10001'), isFalse);
  });

  test('数组段只取 text，图片段不混进来', () {
    expect(
        debugTextOf([
          {
            'type': 'text',
            'data': {'text': '在吗'}
          },
          {
            'type': 'image',
            'data': {'file': 'x.png'}
          },
        ]),
        '在吗');
  });

  test('去重键优先 message_id，其次 message_seq', () {
    expect(debugDedupeKey({'message_id': 12, 'message_seq': 9}), '12');
    expect(debugDedupeKey({'message_seq': 9}), '9');
  });
}
