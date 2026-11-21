import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

// 允许名单：好友与群聊分开（三处）。
//   1. 添加区拆两组：群号→group:<id>，QQ 号→private:<id>，校验分开
//   2. 列表显示类型徽标，群/好友各一组各自计数
//   3. 「从 QQ 选择」弹层分两段，各自全选/反选，好友读不到单独提示
//
// 源码级判据：整页首帧拉真实 IO，widget 测试会挂死（既有约定）。
// 另有函数级判据：直接调 dialog 的选中逻辑，验两段互不牵连。
void main() {
  final src = File('lib/fish/fish_qq.dart').readAsStringSync();

  group('① 添加区拆两组', () {
    test('群和好友各一套输入框 + 各自添加方法', () {
      expect(src.contains('_addGroupChat'), isTrue);
      expect(src.contains('_addFriendChat'), isTrue);
      // 旧的合并版 _addChat 必须消失，否则两条路会并存
      expect(src.contains('Future<void> _addChat('), isFalse,
          reason: '旧的单入口 _addChat 要拆掉，不能留两条并存的路');
    });

    test('群：校验群号 → chatKey=group:<id>', () {
      final idx = src.indexOf('Future<void> _addGroupChat(');
      final body = src.substring(idx, idx + 900);
      expect(body.contains("'群号要填 5–12 位数字'"), isTrue);
      expect(body.contains("'chatKey': 'group:' + id"), isTrue);
    });

    test('好友：校验 QQ 号 → chatKey=private:<id>', () {
      final idx = src.indexOf('Future<void> _addFriendChat(');
      final body = src.substring(idx, idx + 1100);
      expect(body.contains("'QQ 号要填 5–12 位数字'"), isTrue);
      expect(body.contains("'chatKey': 'private:' + id"), isTrue);
    });

    test('好友有独立控制器（QQ 号 + 备注）', () {
      expect(src.contains('final _friendCtl = TextEditingController();'), isTrue);
      expect(src.contains('final _friendNameCtl = TextEditingController();'), isTrue);
      expect(src.contains('_friendCtl.dispose();'), isTrue);
      expect(src.contains('_friendNameCtl.dispose();'), isTrue);
    });

    test('添加区渲染两行，各自带标签', () {
      expect(src.contains("label: '群聊',"), isTrue);
      expect(src.contains("label: '好友',"), isTrue);
      expect(src.contains("idHint: '群号（5–12 位数字）'"), isTrue);
      expect(src.contains("idHint: 'QQ 号（5–12 位数字）'"), isTrue);
    });

    test('好友填了主人自己的号要当场拦（不然会被静默剔除）', () {
      final idx = src.indexOf('Future<void> _addFriendChat(');
      final body = src.substring(idx, idx + 1100);
      expect(body.contains("'这是主人自己的号，不用加白名单'"), isTrue);
    });
  });

  group('② 列表显示类型 + 分组计数', () {
    test('类型真源是 chatKey 前缀，不另存字段', () {
      expect(src.contains('static bool _isGroupKey(Map<String, Object?> m)'), isTrue);
      expect(src.contains("startsWith('group:')"), isTrue);
    });

    test('每条有类型徽标，文案是「群」/「好友」', () {
      expect(src.contains("child: Text(isGroup ? '群' : '好友',"), isTrue);
    });

    test('条目显示「群 · 名」/「好友 · 名」，小字给号码', () {
      expect(src.contains("? (_isGroupKey(m) ? '群 ' : '好友 ') +"), isTrue);
      expect(src.contains(": (_isGroupKey(m) ? '群 · ' : '好友 · ') + name,"), isTrue);
      expect(src.contains("Text((_isGroupKey(m) ? '群号 ' : 'QQ ') +"), isTrue);
    });

    test('列表分两段，各自计数；顶部合计「N 个群 / M 个好友」', () {
      expect(src.contains("_groupHeader('群聊', groups.length)"), isTrue);
      expect(src.contains("_groupHeader('好友', friends.length)"), isTrue);
      expect(src.contains("g.toString() + ' 个群 / ' + f.toString() + ' 个好友'"), isTrue);
    });
  });

  group('③ 「从 QQ 选择」弹层分两段', () {
    test('两段各有标题行（含已选 x/y + 全选/反选）', () {
      expect(src.contains('Widget _sectionHeader(String label, List<String> keys)'), isTrue);
      expect(src.contains("_sectionHeader('群聊', groupKeys)"), isTrue);
      expect(src.contains("_sectionHeader('好友', friendKeys)"), isTrue);
      expect(src.contains('void _selectAllIn(Iterable<String> keys)'), isTrue);
      expect(src.contains('void _clearIn(Iterable<String> keys)'), isTrue);
    });

    test('好友读不到时单独提示，不并进「群和好友都没读到」', () {
      expect(src.contains('final friendsMissing = _friends.isEmpty &&'), isTrue);
      expect(src.contains("'好友没读到（群读到了）。"), isTrue);
      // 只有两段都空才是「都没读到」。
      // 用正则跨空白匹配（源码换行/缩进会被格式化工具改，别钉死空格数）。
      expect(RegExp(r'final groupsMissing = _groups\.isEmpty\s*&&\s*_friends\.isEmpty')
          .hasMatch(src), isTrue,
          reason: '「都没读到」必须要求两段同时为空');
    });

    test('底部保留合计「已选 N 项」', () {
      expect(src.contains("Text('已选 ' + _selected.length.toString() + ' 项'"), isTrue);
    });
  });

  group('顺带：主人那行保持只读、不和群/好友混排', () {
    test('主人仍在「连接」卡里作为只读属性行', () {
      expect(src.contains("label: '主人 QQ', value: qq.configText('私聊QQ')"), isTrue);
    });

    test('主人号会被名单剔除（不混进列表）', () {
      expect(src.contains("key == 'private:' + _ownerQQValue"), isTrue);
      expect(src.contains("if (ownerQQ.isNotEmpty && key == 'private:' + ownerQQ) continue;"),
          isTrue);
    });
  });
}
