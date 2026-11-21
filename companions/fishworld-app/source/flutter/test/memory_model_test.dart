import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/data/fish_data.dart';

void main() {
  test('旧记忆字段兼容：没有 kind/source 时给安全默认值', () {
    final m = FishMemoryEntry.fromJson({
      'id': 'old-1',
      'text': '旧记忆',
      'at': '2026-11-01T00:00:00Z',
      'category': 'stable_profile',
      'tags': ['旧数据'],
    });
    expect(m.kind, 'profile');
    expect(m.status, 'active');
    expect(m.hits, 0);
    expect(m.pinned, false);
    expect(m.sourceType, '');
    expect(m.text, '旧记忆');
  });

  test('新记忆字段解析：source / hits / status', () {
    final m = FishMemoryEntry.fromJson({
      'id': 'new-1',
      'text': '新记忆',
      'kind': 'promise',
      'source': {'type': 'chat', 'ref': 'msg-1'},
      'importance': 0.8,
      'pinned': true,
      'hits': 3,
      'status': 'active',
    });
    expect(m.kind, 'promise');
    expect(m.sourceType, 'chat');
    expect(m.sourceRef, 'msg-1');
    expect(m.importance, 0.8);
    expect(m.pinned, true);
    expect(m.hits, 3);
  });
}
