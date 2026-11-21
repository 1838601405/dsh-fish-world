import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../bento.dart';
import '../data/bridge.dart';
import '../data/fish_data.dart';
import '../data/local_store.dart';
import '../theme/whale_tokens.dart';
import 'fish_common.dart';
// ignore_for_file: prefer_interpolation_to_compose_strings

/// 鱼的记忆 · P1 记忆册骨架。
///
/// 这一版只读：记忆卡片 / 筛选 / 详情是自己的；知识库沿用旧检索卡。
/// 写入、待确认、忘记、关系图都留给 P2/P3，不在本页偷偷改数据。
class FishMemoryPage extends StatefulWidget {
  const FishMemoryPage({super.key});

  @override
  State<FishMemoryPage> createState() => _FishMemoryPageState();
}

class _FishMemoryPageState extends State<FishMemoryPage> {
  late Future<FishSnapshot> _future = FishWorld.load();
  final TextEditingController _search = TextEditingController();
  String _query = '';
  String _kind = 'all';
  String _source = '';
  String _status = '';
  String _sort = 'recent';
  int _tracesScanned = 0;
  bool _byDay = true;
  final Set<String> _expandedDays = {};
  final Map<String, GlobalKey> _dayKeys = {};
  String _highlightDay = '';
  int _tab = 0;
  String? _selectedId;
  String? _busyId;
  final Map<String, double> _cardHeights = {};
  final Map<String, int> _cardSpans = {};
  bool _resizing = false;

  @override
  void initState() {
    super.initState();
    _byDay = readLocal('fish.memory.byDay') != 'all';
    try {
      final tab = Uri.base.queryParameters['tab'];
      if (tab == 'ledger') _tab = 2;
      if (tab == 'kb' || tab == 'knowledge') _tab = 1;
    } catch (_) {}
  }

  void _setByDay(bool v) {
    setState(() => _byDay = v);
    writeLocal('fish.memory.byDay', v ? 'day' : 'all');
  }

  void _reload() {
    setState(() => _future = FishWorld.reload());
  }

  Future<void> _markPending(FishMemoryEntry m) async {
    if (_busyId != null) return;
    setState(() => _busyId = m.id);
    final r = await bridgeFishMemoryAction(m.id, 'pending');
    if (!mounted) return;
    setState(() => _busyId = null);
    final ok = r != null && r['ok'] == true;
    final messenger = ScaffoldMessenger.maybeOf(context);
    messenger?.showSnackBar(SnackBar(
      content: Text(ok ? '已标记待确认；下次整理时她会看到' : '没标成：${r?['error'] ?? '没连上主程序'}'),
      duration: const Duration(seconds: 2),
    ));
    if (ok) _reload();
  }

  Future<void> _forget(FishMemoryEntry m) async {
    if (_busyId != null) return;
    final sure = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('忘记这条记忆？'),
        content: const Text('记忆册里会隐藏它；原始条目仍保留在备份里，不会直接删掉。'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('算了')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('忘记')),
        ],
      ),
    );
    if (sure != true || !mounted) return;
    setState(() => _busyId = m.id);
    final r = await bridgeFishMemoryAction(m.id, 'forget');
    if (!mounted) return;
    setState(() => _busyId = null);
    final ok = r != null && r['ok'] == true;
    final messenger = ScaffoldMessenger.maybeOf(context);
    messenger?.showSnackBar(SnackBar(
      content: Text(ok ? '已从记忆册忘记' : '没忘成：${r?['error'] ?? '没连上主程序'}'),
      duration: const Duration(seconds: 2),
    ));
    if (ok) _reload();
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<FishSnapshot>(
      future: _future,
      builder: (ctx, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return _memorySkeleton(context);
        }
        final data = snap.data ?? FishSnapshot.empty();
        if (snap.hasError || !data.ok) {
          return _emptyPage(context, snap.error?.toString() ?? '还没读到鱼的记忆。');
        }
        return _content(context, data);
      },
    );
  }

  Widget _content(BuildContext context, FishSnapshot data) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _header(context, data),
          const SizedBox(height: 12),
          Expanded(
              child: _tab == 0
                  ? _memoryTab(context, data)
                  : (_tab == 1 ? _knowledgeTab(context, data) : _ledgerTab(context, data))),
        ],
      ),
    );
  }

  Widget _header(BuildContext context, FishSnapshot data) {
    final scheme = Theme.of(context).colorScheme;
    final memories = data.memory.memories.where((m) => m.domain != 'ledger').toList();
    final core = memories.where((m) => m.kind == 'profile' || m.category == 'stable_profile').length;
    final week = _weekCount(memories);
    final pending = memories.where((m) => m.status == 'pending').length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('鱼的世界  /  鱼的记忆',
            style: TextStyle(fontSize: WhaleTokens.fsCaption, color: scheme.onSurfaceVariant)),
        const SizedBox(height: 8),
        Row(children: [
          Text('鱼的记忆', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: scheme.onSurface)),
          const SizedBox(width: 9),
          _dateButton(context),
          const SizedBox(width: 5),
          _pill(context, '记忆册'),
          const SizedBox(width: 10),
          Text('她记得的事，不是笔记',
              style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurfaceVariant)),
          const Spacer(),
          _tabButton(context, '记忆册', 0),
          const SizedBox(width: 4),
          _tabButton(context, '知识库', 1),
          const SizedBox(width: 4),
          _tabButton(context, '工作账', 2),
          const SizedBox(width: 8),
          _dayToggle(context),
          const SizedBox(width: 8),
          _sortMenu(context),
          const SizedBox(width: 6),
          _dateButton(context),
          const SizedBox(width: 10),
          SizedBox(
            width: 210,
            height: 32,
            child: TextField(
              controller: _search,
              onChanged: (v) => setState(() => _query = v.trim()),
              style: const TextStyle(fontSize: WhaleTokens.fsSmall),
              decoration: InputDecoration(
                isDense: true,
                hintText: '搜记忆、标签…',
                hintStyle: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurfaceVariant),
                prefixIcon: Icon(Icons.search, size: 16, color: scheme.onSurfaceVariant),
                contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: BorderSide(color: scheme.outlineVariant)),
                enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: BorderSide(color: scheme.outlineVariant)),
              ),
            ),
          ),
        ]),
        const SizedBox(height: 12),
        LayoutBuilder(builder: (_, box) {
          final columns = box.maxWidth >= 760 ? 4 : 2;
          const gap = 12.0;
          final w = (box.maxWidth - gap * (columns - 1)) / columns;
          return Wrap(spacing: gap, runSpacing: gap, children: [
            SizedBox(width: w, child: _overviewStat(context, Icons.psychology_outlined, '总记忆', memories.length.toString(), pending > 0 ? '待确认 $pending' : '条')),
            SizedBox(width: w, child: _overviewStat(context, Icons.push_pin_outlined, '核心', core.toString(), '条')),
            SizedBox(width: w, child: _overviewStat(context, Icons.history, '本周想起', week.toString(), '条')),
            SizedBox(width: w, child: _overviewStat(context, Icons.storage_outlined, '知识库', data.memory.knowledgeEntries.toString(), '条')),
          ]);
        }),
      ],
    );
  }

  Widget _overviewStat(BuildContext context, IconData icon, String label, String value, String sub) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      constraints: const BoxConstraints(minHeight: 76),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(WhaleTokens.rXl),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(icon, size: 15, color: scheme.onSurfaceVariant),
          const SizedBox(width: 6),
          Text(label, style: TextStyle(fontSize: WhaleTokens.fsCaption, color: scheme.onSurfaceVariant)),
        ]),
        const SizedBox(height: 4),
        Text(value, style: TextStyle(fontSize: WhaleTokens.fsPage, fontWeight: FontWeight.w600, color: scheme.onSurface, fontFeatures: const [FontFeature.tabularFigures()])),
        Text(sub, style: TextStyle(fontSize: WhaleTokens.fsCaption, color: scheme.onSurfaceVariant)),
      ]),
    );
  }

  void _sortItems(List<FishMemoryEntry> items) {
    switch (_sort) {
      case 'oldest':
        items.sort((a, b) => _dateValue(a.at).compareTo(_dateValue(b.at)));
        break;
      case 'importance':
        items.sort((a, b) {
          final byImp = b.importance.compareTo(a.importance);
          if (byImp != 0) return byImp;
          return _dateValue(b.at).compareTo(_dateValue(a.at));
        });
        break;
      case 'recall':
        items.sort((a, b) {
          final byHits = b.hits.compareTo(a.hits);
          if (byHits != 0) return byHits;
          return _dateValue(b.lastUsedAt).compareTo(_dateValue(a.lastUsedAt));
        });
        break;
      case 'recent':
      default:
        items.sort((a, b) => _dateValue(b.at).compareTo(_dateValue(a.at)));
        break;
    }
  }

  int _dateValue(String raw) =>
      DateTime.tryParse(raw)?.millisecondsSinceEpoch ?? 0;

  String _timeLabel(String raw) {
    final t = DateTime.tryParse(raw)?.toLocal();
    if (t == null) return '';
    final now = DateTime.now();
    final diff = now.difference(t);
    String two(int n) => n.toString().padLeft(2, '0');
    if (diff.inMinutes < 1) return '刚刚';
    final sameDay =
        t.year == now.year && t.month == now.month && t.day == now.day;
    if (sameDay) return '今天 ${two(t.hour)}:${two(t.minute)}';
    final yesterday = now.subtract(const Duration(days: 1));
    if (t.year == yesterday.year &&
        t.month == yesterday.month &&
        t.day == yesterday.day) {
      return '昨天 ${two(t.hour)}:${two(t.minute)}';
    }
    if (t.year == now.year) {
      return '${t.month}月${t.day}日';
    }
    return '${t.year}年${t.month}月${t.day}日';
  }

  Widget _dayToggle(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    Widget one(String label, bool on, VoidCallback tap) => InkWell(
          onTap: tap,
          borderRadius: BorderRadius.circular(7),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            decoration: BoxDecoration(color: on ? scheme.primaryContainer.withValues(alpha: .45) : Colors.transparent, borderRadius: BorderRadius.circular(7)),
            child: Text(label, style: TextStyle(fontSize: 10, color: on ? scheme.primary : scheme.onSurfaceVariant, fontWeight: on ? FontWeight.w600 : FontWeight.w400)),
          ),
        );
    return Container(
      decoration: BoxDecoration(border: Border.all(color: scheme.outlineVariant), borderRadius: BorderRadius.circular(8)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [one('按天', _byDay, () => _setByDay(true)), one('全部', !_byDay, () => _setByDay(false))]),
    );
  }

  Widget _dateButton(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return IconButton(
      tooltip: '按日期查',
      visualDensity: VisualDensity.compact,
      icon: Icon(Icons.calendar_month_outlined, size: 16, color: scheme.onSurfaceVariant),
      onPressed: () => _pickDay(context),
    );
  }

  Widget _sortMenu(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return PopupMenuButton<String>(
      tooltip: '排序方式',
      initialValue: _sort,
      onSelected: (v) => setState(() => _sort = v),
      itemBuilder: (_) => const [
        PopupMenuItem(value: 'recent', child: Text('最近发生')),
        PopupMenuItem(value: 'importance', child: Text('最重要')),
        PopupMenuItem(value: 'recall', child: Text('最近想起')),
      ],
      child: Container(
        height: 32,
        padding: const EdgeInsets.symmetric(horizontal: 9),
        decoration: BoxDecoration(
          color: scheme.surface,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: scheme.outlineVariant),
        ),
        child: Row(children: [
          Icon(Icons.sort, size: 14, color: scheme.onSurfaceVariant),
          const SizedBox(width: 5),
          Text(_sortLabel(),
              style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant)),
          const SizedBox(width: 2),
          Icon(Icons.keyboard_arrow_down,
              size: 14, color: scheme.onSurfaceVariant),
        ]),
      ),
    );
  }

  String _sortLabel() {
    switch (_sort) {
      case 'importance':
        return '最重要';
      case 'recall':
        return '最近想起';
      case 'oldest':
        return '最早发生';
      default:
        return '最近发生';
    }
  }

  Widget _ledgerTab(BuildContext context, FishSnapshot data) {
    final scheme = Theme.of(context).colorScheme;
    final rows = data.memory.memories.where((m) => m.domain == 'ledger').toList();
    if (rows.isEmpty) {
      return Center(
        child: Text('工作账还没有归属数据。\n分堆确认后，把公务条目迁进来。', textAlign: TextAlign.center, style: TextStyle(fontSize: WhaleTokens.fsSmall, height: 1.6, color: scheme.onSurfaceVariant)),
      );
    }
    return _cards(context, rows, _selected(rows));
  }

  Widget _memoryTab(BuildContext context, FishSnapshot data) {
    _tracesScanned = data.memory.tracesScanned;
    final all = data.memory.memories.where((m) => m.domain != 'ledger').toList();
    final items = all.where((m) {
      if (_kind != 'all') {
        if (_kind == 'profile') {
          if (!(m.kind == 'profile' || m.category == 'stable_profile')) {
            return false;
          }
        } else if (m.kind != _kind && m.category != _kind) {
          return false;
        }
      }
      if (_source.isNotEmpty) {
        final src = _source == 'note' ? (m.sourceType == 'note' || m.sourceType == 'diary') : m.sourceType == _source;
        if (!src) return false;
      }
      if (_status == 'pinned' && !m.pinned) return false;
      if (_status == 'pending' && m.status != 'pending') return false;
      if (_status == 'never' && !m.neverRecalled) return false;
      if (_status == 'faded' && !_isFaded(m)) return false;
      if (_query.isEmpty) return true;
      final hay = '${m.text} ${m.tags.join(' ')} ${m.category} ${m.kind}';
      return hay.toLowerCase().contains(_query.toLowerCase());
    }).toList();
    _sortItems(items);
    _lastAll = items;
    final selected = _selected(items);
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.arrowLeft): () => _setByDay(true),
        const SingleActivator(LogicalKeyboardKey.arrowRight): () => _setByDay(false),
      },
      child: Focus(
        autofocus: false,
        child: LayoutBuilder(
      builder: (ctx, box) {
        final narrow = box.maxWidth < 860;
        if (narrow) {
          return ListView(
            children: [
              _filters(context, all),
              const SizedBox(height: 10),
              SizedBox(height: 360, child: _memoryBody(context, items, selected)),
              const SizedBox(height: 10),
              _detail(context, selected),
            ],
          );
        }
        return Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(width: 196, child: _filters(context, all)),
            const SizedBox(width: 10),
            Expanded(child: _memoryBody(context, items, selected)),
            const SizedBox(width: 10),
            SizedBox(width: 300, child: _detail(context, selected)),
          ],
        );
      },
    ),
      ),
    );
  }

  Widget _filters(BuildContext context, List<FishMemoryEntry> all) {
    final scheme = Theme.of(context).colorScheme;
    const kinds = [
      ['all', '全部记忆'],
      ['profile', '核心'],
      ['fact', '事实'],
      ['promise', '约定'],
      ['preference', '偏好'],
      ['event', '经历'],
      ['insight', '洞察'],
    ];
    return _HoverScroll(
      builder: (controller) => Container(
        decoration: BoxDecoration(
          color: scheme.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: scheme.outlineVariant),
        ),
        padding: const EdgeInsets.fromLTRB(10, 14, 10, 10),
        child: SingleChildScrollView(
          controller: controller,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _sectionLabel(context, 'FILTER'),
              for (final k in kinds) _filterRow(context, k[0], k[1], all),
              const SizedBox(height: 14),
              _sectionLabel(context, '来源'),
              _sideFilter(context, 'chat', '聊天', all),
              _sideFilter(context, 'note', '日记', all),
              _sideFilter(context, 'manual', '手动', all),
              const SizedBox(height: 14),
              _sectionLabel(context, '状态'),
              _sideFilter(context, 'pinned', '已钉住', all),
              _sideFilter(context, 'pending', '待确认', all),
              _sideFilter(context, 'never', '从未被想起', all),
              _sideFilter(context, 'faded', '很久没想起', all),
              if (_tracesScanned > 0)
                Padding(
                  padding: const EdgeInsets.only(top: 6, left: 2),
                  child: Text('基于最近 ' + _tracesScanned.toString() + ' 条检索记录',
                      style: TextStyle(fontSize: 9, color: scheme.onSurfaceVariant.withValues(alpha: .7))),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _filterRow(BuildContext context, String kind, String label,
      List<FishMemoryEntry> all) {
    final scheme = Theme.of(context).colorScheme;
    final on = _kind == kind;
    final count = kind == 'all'
        ? all.length
        : all
            .where((m) =>
                m.kind == kind ||
                (kind == 'profile' && m.category == 'stable_profile'))
            .length;
    void activate() => setState(() => _kind = kind);
    return Focus(
      onKeyEvent: (node, event) => _filterKey(event, activate),
      child: InkWell(
      focusColor: scheme.primary.withValues(alpha: .14),
      borderRadius: BorderRadius.circular(7),
      onTap: activate,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        decoration: BoxDecoration(
            color: on
                ? scheme.primaryContainer.withValues(alpha: .45)
                : Colors.transparent,
            borderRadius: BorderRadius.circular(7)),
        child: Row(
          children: [
            Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(
                    color: scheme.onSurfaceVariant, shape: BoxShape.circle)),
            const SizedBox(width: 7),
            Expanded(
                child: Text(label,
                    style: TextStyle(
                        fontSize: WhaleTokens.fsSmall,
                        color: on ? scheme.primary : scheme.onSurface,
                        fontWeight: on ? FontWeight.w600 : FontWeight.w400))),
            Text('$count',
                style: _num(
                    TextStyle(fontSize: 10, color: scheme.onSurfaceVariant))),
          ],
        ),
      ),
    ),
    );
  }



  Widget _sideFilter(BuildContext context, String key, String label, List<FishMemoryEntry> all) {
    final scheme = Theme.of(context).colorScheme;
    final on = (_source == key) || (_status == key);
    final count = all.where((m) {
      if (key == 'chat' || key == 'note' || key == 'manual') {
        return key == 'note' ? (m.sourceType == 'note' || m.sourceType == 'diary') : m.sourceType == key;
      }
      if (key == 'pinned') return m.pinned;
      if (key == 'pending') return m.status == 'pending';
      if (key == 'never') return m.neverRecalled;
      return _isFaded(m);
    }).length;
    void activate() {
      if (count == 0) return;
      setState(() {
        if (_source == key) { _source = ''; return; }
        if (_status == key) { _status = ''; return; }
        if (key == 'chat' || key == 'note' || key == 'manual') { _source = key; } else { _status = key; }
      });
    }
    return Focus(
      onKeyEvent: (node, event) => _filterKey(event, activate),
      child: InkWell(
      focusColor: scheme.primary.withValues(alpha: .14),
      borderRadius: BorderRadius.circular(7),
      onTap: activate,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        decoration: BoxDecoration(
          color: on ? scheme.primaryContainer.withValues(alpha: .45) : Colors.transparent,
          borderRadius: BorderRadius.circular(7),
        ),
        child: Row(children: [
          // 与类型区同规格：7px 实心圆点；0 项只降透明度，保留本色相。
          Container(
              width: 7,
              height: 7,
              decoration: BoxDecoration(
                  color: scheme.onSurfaceVariant.withValues(alpha: count == 0 ? .35 : .9),
                  shape: BoxShape.circle)),
          const SizedBox(width: 7),
          Expanded(child: Text(label, style: TextStyle(fontSize: WhaleTokens.fsSmall, color: on ? scheme.primary : scheme.onSurface.withValues(alpha: count == 0 ? .55 : 1), fontWeight: on ? FontWeight.w600 : FontWeight.w400))),
          Text('$count', style: _num(TextStyle(fontSize: 10, color: scheme.onSurfaceVariant.withValues(alpha: count == 0 ? .55 : 1)))),
        ]),
      ),
    ),
    );
  }

  KeyEventResult _filterKey(KeyEvent event, VoidCallback tap) {
    final k = event.logicalKey;
    if (k == LogicalKeyboardKey.arrowUp || k == LogicalKeyboardKey.arrowDown) {
      FocusScope.of(context).focusInDirection(k == LogicalKeyboardKey.arrowUp ? TraversalDirection.up : TraversalDirection.down);
      return KeyEventResult.handled;
    }
    if (k == LogicalKeyboardKey.enter || k == LogicalKeyboardKey.space) {
      tap();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  bool _isFaded(FishMemoryEntry m) {
    if (m.neverRecalled) return false; // 「从未」单独一行，不和「很久没想起」重叠
    final t = DateTime.tryParse(m.lastUsedAt);
    return t == null || DateTime.now().difference(t).inDays > 90;
  }

  Widget _memoryBody(BuildContext context, List<FishMemoryEntry> items, FishMemoryEntry? selected) {
    if (!_byDay) return _cards(context, items, selected);
    return _dayGroups(context, items, selected);
  }

  Widget _dayGroups(BuildContext context, List<FishMemoryEntry> items, FishMemoryEntry? selected) {
    final scheme = Theme.of(context).colorScheme;
    if (items.isEmpty) {
      return Center(child: Text(items.isEmpty && _kind == 'all' && _query.isEmpty && _source.isEmpty && _status.isEmpty ? '我还没记住什么。' : '这个筛法下没有记忆。', style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurfaceVariant)));
    }
    final groups = <String, List<FishMemoryEntry>>{};
    for (final m in items) {
      final day = m.at.length >= 10 ? m.at.substring(0, 10) : (m.at.isEmpty ? '未知日期' : m.at);
      groups.putIfAbsent(day, () => []).add(m);
    }
    final keys = groups.keys.toList()..sort((a, b) => _sort == 'oldest' ? a.compareTo(b) : b.compareTo(a));
    final latest = keys.first;
    final expanded = _expandedDays.isEmpty ? <String>{latest} : _expandedDays;
    return _HoverScroll(builder: (controller) => SingleChildScrollView(
      controller: controller,
      padding: const EdgeInsets.only(right: 2),
      child: Column(children: [
        for (final day in keys) ...[
          Container(
            key: _dayKeys.putIfAbsent(day, () => GlobalKey()),
            margin: const EdgeInsets.only(bottom: 9),
            decoration: BoxDecoration(
              color: _highlightDay == day ? scheme.primaryContainer.withValues(alpha: .30) : scheme.surface,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: _highlightDay == day ? scheme.primary : scheme.outlineVariant, width: _highlightDay == day ? 1.5 : 1),
            ),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Focus(
                onKeyEvent: (node, event) {
                  if (event.logicalKey == LogicalKeyboardKey.enter || event.logicalKey == LogicalKeyboardKey.space) {
                    setState(() {
                      if (_expandedDays.isEmpty) _expandedDays.add(latest);
                      if (_expandedDays.contains(day)) { _expandedDays.remove(day); } else { _expandedDays.add(day); }
                    });
                    return KeyEventResult.handled;
                  }
                  return KeyEventResult.ignored;
                },
                child: InkWell(
                focusColor: scheme.primary.withValues(alpha: .12),
                borderRadius: BorderRadius.circular(11),
                onTap: () => setState(() {
                  if (_expandedDays.isEmpty) _expandedDays.add(latest);
                  if (_expandedDays.contains(day)) { _expandedDays.remove(day); } else { _expandedDays.add(day); }
                }),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(12, 10, 10, 9),
                  child: Row(children: [
                    Text(_dayLabel(day), style: TextStyle(fontSize: WhaleTokens.fsSub, fontWeight: FontWeight.w700, color: scheme.onSurface)),
                    const SizedBox(width: 8),
                    Text('${groups[day]!.length} 条', style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant, fontFeatures: const [FontFeature.tabularFigures()])),
                    const Spacer(),
                    Icon(expanded.contains(day) ? Icons.expand_less : Icons.expand_more, size: 18, color: scheme.onSurfaceVariant),
                  ]),
                ),
              ),
              ),
              if (!expanded.contains(day))
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 0, 12, 11),
                  child: Text(groups[day]!.take(2).map((m) => m.text).join(' · '), maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11, height: 1.5, color: scheme.onSurfaceVariant)),
                )
              else
                AnimatedSize(
                  duration: const Duration(milliseconds: 180),
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(10, 0, 10, 8),
                    child: Column(children: [
                      for (final m in groups[day]!)
                        SizedBox(height: 154, child: Padding(padding: const EdgeInsets.only(bottom: 6), child: _memoryCard(context, m, selected?.id == m.id))),
                    ]),
                  ),
                ),
            ]),
          ),
        ],
      ]),
    ));
  }

  String _dayLabel(String day) {
    final t = DateTime.tryParse(day);
    if (t == null) return day;
    return '${t.month}月${t.day}日';
  }

  Future<void> _pickDay(BuildContext context) async {
    final all = _lastAll;
    final days = all.map((m) => m.at.length >= 10 ? m.at.substring(0, 10) : '').where((d) => d.isNotEmpty).toSet();
    final picked = await showDialog<String>(context: context, builder: (_) => _MemoryDayPicker(days: days));
    if (picked == null || !mounted) return;
    setState(() {
      _byDay = true;
      _expandedDays.add(picked);
      _highlightDay = picked;
    });
    writeLocal('fish.memory.byDay', 'day');
    Future.delayed(const Duration(milliseconds: 80), () {
      final c = _dayKeys[picked]?.currentContext;
      if (c != null) Scrollable.ensureVisible(c, duration: const Duration(milliseconds: 220), alignment: .1);
    });
    Future.delayed(const Duration(milliseconds: 1500), () { if (mounted) setState(() => _highlightDay = ''); });
  }

  List<FishMemoryEntry> _lastAll = const [];

  Widget _cards(BuildContext context, List<FishMemoryEntry> items,
      FishMemoryEntry? selected) {
    if (items.isEmpty) {
      return Center(
          child: Text(items.isEmpty && _kind == 'all' && _query.isEmpty && _source.isEmpty && _status.isEmpty ? '我还没记住什么。' : '这个筛法下没有记忆。',
              style: TextStyle(
                  fontSize: WhaleTokens.fsSmall,
                  color: Theme.of(context).colorScheme.onSurfaceVariant)));
    }
    return _HoverScroll(
      builder: (controller) => _cardsList(context, items, selected, controller),
    );
  }

  Widget _cardsList(BuildContext context, List<FishMemoryEntry> items,
      FishMemoryEntry? selected, ScrollController controller) {
    return LayoutBuilder(builder: (ctx, box) {
      final columns = box.maxWidth < 560 ? 1 : 2;
      const gap = 10.0;
      final halfWidth = columns == 1 ? box.maxWidth : (box.maxWidth - gap) / 2;
      final heights = List<double>.filled(columns, 0);
      final placed = <_PlacedMemory>[];
      for (final item in items) {
        final span = columns == 1 ? 1 : (_cardSpans[item.id] ?? 1).clamp(1, 2);
        final h = (_cardHeights[item.id] ?? 154.0).clamp(120.0, 520.0);
        if (span == 2) {
          final top = heights.reduce(math.max);
          placed.add(_PlacedMemory(item, 0, top, h, box.maxWidth, selected?.id == item.id));
          for (var i = 0; i < columns; i++) {
            heights[i] = top + h + gap;
          }
        } else {
          var col = 0;
          for (var i = 1; i < columns; i++) {
            if (heights[i] < heights[col]) col = i;
          }
          placed.add(_PlacedMemory(item, col, heights[col], h, halfWidth, selected?.id == item.id));
          heights[col] += h + gap;
        }
      }
      final total = heights.isEmpty ? 0.0 : heights.reduce(math.max) - gap;
      return SingleChildScrollView(
        controller: controller,
        physics: _resizing ? const NeverScrollableScrollPhysics() : null,
        padding: const EdgeInsets.only(right: 2),
        child: SizedBox(
          height: total < 0 ? 0 : total,
          child: Stack(children: [
            for (final p in placed)
              Positioned(
                left: p.col * (p.width + gap),
                top: p.top,
                width: p.width,
                height: p.height,
                child: _memoryCard(context, p.item, p.selected),
              ),
          ]),
        ),
      );
    });
  }

  void _resize(String id, double delta) {
    final current = _cardHeights[id] ?? 154.0;
    setState(() {
      _cardHeights[id] = (current + delta).clamp(120.0, 520.0);
    });
  }

  void _resizeSpan(String id, int delta) {
    final current = _cardSpans[id] ?? 1;
    final next = (current + delta).clamp(1, 2);
    if (next == current) return;
    setState(() => _cardSpans[id] = next);
  }

  Widget _memoryCard(BuildContext context, FishMemoryEntry m, bool selected) {
    return _MemoryCard(
      summary: _summary(m.text),
      kindLabel: _kindLabel(m.kind),
      kindColor: Theme.of(context).colorScheme.onSurfaceVariant,
      timeLabel: _timeLabel(m.at),
      tagText: m.tags.isEmpty ? _sourceLabel(m) : m.tags.take(2).join(' · '),
      pinned: m.pinned,
      hits: m.hits,
      status: _statusText(m.status),
      selected: selected,
      onTap: () => setState(() => _selectedId = m.id),
      onResize: (delta) => _resize(m.id, delta),
      onResizeWidth: (delta) => _resizeSpan(m.id, delta),
      onResizeStart: () => setState(() => _resizing = true),
      onResizeEnd: () => setState(() => _resizing = false),
    );
  }

  String _summary(String text) {
    final clean = text.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (clean.isEmpty) return '（空记忆）';
    final first = clean.split(RegExp(r'[。！？!?；;]')).first.trim();
    final line = first.isEmpty ? clean : first;
    return line.length > 36 ? line.substring(0, 36) + '…' : line;
  }

  Widget _detail(BuildContext context, FishMemoryEntry? m) {
    final scheme = Theme.of(context).colorScheme;
    if (m == null) {
      return Container(
        decoration: BoxDecoration(
            color: scheme.surface,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: scheme.outlineVariant)),
        child: Center(
            child: Text('点一条记忆看详情',
                style: TextStyle(
                    fontSize: WhaleTokens.fsSmall,
                    color: scheme.onSurfaceVariant))),
      );
    }
    return _HoverScroll(
      builder: (controller) => _DetailPane(
        key: ValueKey(m.id),
        item: m,
        kindLabel: _kindLabel(m.kind),
        kindColor: Theme.of(context).colorScheme.onSurfaceVariant,
        sourceLabel: _sourceLabel(m),
        controller: controller,
        busy: _busyId == m.id,
        onPending: () => _markPending(m),
        onForget: () => _forget(m),
      ),
    );
  }

  Widget _knowledgeTab(BuildContext context, FishSnapshot data) {
    return SingleChildScrollView(
      child: Column(children: [
        Align(
          alignment: Alignment.centerLeft,
          child: Text('知识库是规则、梗、称呼和外观约定；和“她经历过的记忆”分开。',
              style: TextStyle(
                  fontSize: WhaleTokens.fsSmall,
                  color: Theme.of(context).colorScheme.onSurfaceVariant)),
        ),
        const SizedBox(height: 12),
        Center(child: _KbSearchCard()),
      ]),
    );
  }

  Widget _memorySkeleton(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    Widget block(double h) => Container(
      height: h,
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.35),
        borderRadius: BorderRadius.circular(WhaleTokens.rLg),
      ),
    );
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(WhaleTokens.gap, WhaleTokens.gap, WhaleTokens.gap, 104),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        block(34),
        const SizedBox(height: 12),
        Row(children: [
          for (var i = 0; i < 4; i++) ...[
            Expanded(child: block(76)),
            if (i < 3) const SizedBox(width: 12),
          ],
        ]),
        const SizedBox(height: 16),
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(flex: 2, child: block(420)),
          const SizedBox(width: 10),
          Expanded(flex: 3, child: block(420)),
          const SizedBox(width: 10),
          Expanded(flex: 2, child: block(420)),
        ]),
      ]),
    );
  }

  Widget _emptyPage(BuildContext context, String error) {
    return Center(
      child: Container(
        constraints: const BoxConstraints(maxWidth: 440),
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surface,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
                color: Theme.of(context).colorScheme.outlineVariant)),
        child: Text('还没读到鱼的记忆。\n$error',
            style: TextStyle(
                fontSize: WhaleTokens.fsBody,
                color: Theme.of(context).colorScheme.onSurfaceVariant)),
      ),
    );
  }

  Widget _tabButton(BuildContext context, String text, int index) {
    final scheme = Theme.of(context).colorScheme;
    final on = _tab == index;
    return InkWell(
      borderRadius: BorderRadius.circular(7),
      onTap: () => setState(() => _tab = index),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
            color: on
                ? scheme.primaryContainer.withValues(alpha: .5)
                : Colors.transparent,
            borderRadius: BorderRadius.circular(7)),
        child: Text(text,
            style: TextStyle(
                fontSize: WhaleTokens.fsSmall,
                color: on ? scheme.primary : scheme.onSurfaceVariant,
                fontWeight: on ? FontWeight.w700 : FontWeight.w400)),
      ),
    );
  }

  Widget _pill(BuildContext context, String text) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
        decoration: BoxDecoration(
            color: scheme.primaryContainer.withValues(alpha: .45),
            borderRadius: BorderRadius.circular(999)),
        child: Text(text,
            style: TextStyle(
                fontSize: 9,
                color: scheme.primary,
                fontWeight: FontWeight.w600)));
  }

  TextStyle _num(TextStyle style) =>
      style.copyWith(fontFeatures: const [FontFeature.tabularFigures()]);

  Widget _sectionLabel(BuildContext context, String text) {
    return Text(text,
        style: TextStyle(
            fontSize: 9,
            letterSpacing: .08,
            color: Theme.of(context).colorScheme.onSurfaceVariant,
            fontWeight: FontWeight.w700));
  }

  FishMemoryEntry? _selected(List<FishMemoryEntry> items) {
    if (items.isEmpty) return null;
    for (final m in items) {
      if (m.id == _selectedId) return m;
    }
    return items.first;
  }

  int _weekCount(List<FishMemoryEntry> items) {
    final now = DateTime.now();
    var n = 0;
    for (final m in items) {
      final t = DateTime.tryParse(m.at);
      if (t != null && now.difference(t).inDays <= 7) n++;
    }
    return n;
  }

  String _kindLabel(String kind) {
    switch (kind) {
      case 'profile':
        return '核心';
      case 'fact':
        return '事实';
      case 'promise':
        return '约定';
      case 'preference':
        return '偏好';
      case 'insight':
        return '洞察';
      case 'event':
      default:
        return '经历';
    }
  }



  String _sourceLabel(FishMemoryEntry m) {
    switch (m.sourceType) {
      case 'chat':
        return '聊天';
      case 'note':
        return '日记 / 笔记';
      case 'manual':
        return '手动';
      case 'import':
        return '导入';
      default:
        return '旧数据 · 来源未标';
    }
  }
}

class _HoverScroll extends StatefulWidget {
  final Widget Function(ScrollController controller) builder;
  const _HoverScroll({required this.builder});

  @override
  State<_HoverScroll> createState() => _HoverScrollState();
}

class _HoverScrollState extends State<_HoverScroll> {
  final ScrollController _controller = ScrollController();
  bool _hover = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: ScrollConfiguration(
        behavior: ScrollConfiguration.of(context).copyWith(scrollbars: false),
        child: Scrollbar(
          controller: _controller,
          thumbVisibility: _hover,
          trackVisibility: false,
          thickness: 3,
          radius: const Radius.circular(3),
          child: widget.builder(_controller),
        ),
      ),
    );
  }
}

class _ResizeGripPainter extends CustomPainter {
  final Color color;
  const _ResizeGripPainter({required this.color});

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color.withValues(alpha: 0.45)
      ..strokeWidth = 1.2
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round;
    for (var i = 0; i < 3; i++) {
      final inset = 5.0 + i * 4;
      canvas.drawLine(
        Offset(size.width - inset, size.height - 4),
        Offset(size.width - 4, size.height - inset),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _ResizeGripPainter oldDelegate) => oldDelegate.color != color;
}

class _PlacedMemory {
  final FishMemoryEntry item;
  final int col;
  final double top;
  final double height;
  final double width;
  final bool selected;
  const _PlacedMemory(this.item, this.col, this.top, this.height, this.width, this.selected);
}

class _MemoryCard extends StatefulWidget {
  final String summary;
  final String kindLabel;
  final Color kindColor;
  final String timeLabel;
  final String tagText;
  final bool pinned;
  final int hits;
  final String status;
  final bool selected;
  final VoidCallback onTap;
  final ValueChanged<double> onResize;
  final ValueChanged<int> onResizeWidth;
  final VoidCallback onResizeStart;
  final VoidCallback onResizeEnd;

  const _MemoryCard({
    required this.summary,
    required this.kindLabel,
    required this.kindColor,
    required this.timeLabel,
    required this.tagText,
    required this.pinned,
    required this.hits,
    required this.status,
    required this.selected,
    required this.onTap,
    required this.onResize,
    required this.onResizeWidth,
    required this.onResizeStart,
    required this.onResizeEnd,
  });

  @override
  State<_MemoryCard> createState() => _MemoryCardState();
}

class _MemoryCardState extends State<_MemoryCard> {
  bool _hover = false;
  double _lastY = 0;
  double _dragDx = 0;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final lifted = _hover || widget.selected;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onHorizontalDragStart: (_) => _dragDx = 0,
        onHorizontalDragUpdate: (d) {
          _dragDx += d.delta.dx;
          if (_dragDx.abs() < 36) return;
          widget.onResizeWidth(_dragDx > 0 ? 1 : -1);
          _dragDx = 0;
        },
        onHorizontalDragEnd: (_) => _dragDx = 0,
        onHorizontalDragCancel: () => _dragDx = 0,
        child: InkWell(
        borderRadius: BorderRadius.circular(11),
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          curve: Curves.easeOut,
          transform: Matrix4.translationValues(0, lifted ? -2 : 0, 0),
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 9),
          decoration: bentoCardDecoration(context, hover: lifted, selected: widget.selected),
          child: Stack(children: [
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: [
                  Container(
                      width: 7,
                      height: 7,
                      decoration: BoxDecoration(
                          color: widget.kindColor, shape: BoxShape.circle)),
                  const SizedBox(width: 6),
                  Text(widget.kindLabel,
                      style: TextStyle(
                          fontSize: 10, color: scheme.onSurfaceVariant)),
                  if (widget.pinned) ...[
                    const SizedBox(width: 4),
                    Icon(Icons.push_pin_outlined,
                        size: 12, color: scheme.primary),
                  ],
                  if (widget.status == 'pending') ...[
                    const SizedBox(width: 5),
                    Container(
                      padding:
                          const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                      decoration: BoxDecoration(
                          color: scheme.tertiaryContainer,
                          borderRadius: BorderRadius.circular(4)),
                      child: Text('待确认',
                          style: TextStyle(
                              fontSize: 8, color: scheme.onTertiaryContainer)),
                    ),
                  ],
                  const Spacer(),
                  AnimatedSwitcher(
                    duration: const Duration(milliseconds: 120),
                    child: _hover
                        ? Text('详情 ›',
                            key: const ValueKey('detail'),
                            style: TextStyle(
                                fontSize: 10,
                                color: scheme.primary,
                                fontWeight: FontWeight.w600))
                        : Text(widget.timeLabel,
                            key: const ValueKey('time'),
                            style: TextStyle(
                                fontSize: 10,
                                color: scheme.onSurfaceVariant,
                                fontFeatures: const [
                                  FontFeature.tabularFigures()
                                ])),
                  ),
                ]),
                const SizedBox(height: 6),
                Expanded(
                  child: Text(
                    widget.summary,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        fontSize: 13, height: 1.55, color: scheme.onSurface),
                  ),
                ),
                const SizedBox(height: 5),
                Row(children: [
                  Expanded(
                    child: Text(widget.tagText,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                            fontSize: 9, color: scheme.onSurfaceVariant)),
                  ),
                  const SizedBox(width: 6),
                  Icon(Icons.bolt_outlined,
                      size: 11,
                      color: widget.hits > 10
                          ? scheme.tertiary
                          : scheme.onSurfaceVariant),
                  const SizedBox(width: 2),
                  Text(widget.hits > 0 ? '被想起 ${widget.hits}' : '未想起',
                      style: TextStyle(
                          fontSize: 9,
                          fontFeatures: const [FontFeature.tabularFigures()],
                          color: widget.hits > 10
                              ? scheme.tertiary
                              : scheme.onSurfaceVariant)),
                  const SizedBox(width: 24),
                ]),
              ],
            ),
            Positioned(
              right: 0,
              bottom: 0,
              child: IgnorePointer(
                ignoring: !_hover,
                child: AnimatedOpacity(
                  opacity: _hover ? 1 : 0,
                  duration: const Duration(milliseconds: 120),
                  child: Semantics(
                label: '拖动调整大小：左右切单列/通栏，上下改高度',
                child: MouseRegion(
                  cursor: SystemMouseCursors.resizeUpLeftDownRight,
                  child: Listener(
                    behavior: HitTestBehavior.opaque,
                    onPointerDown: (_) => _dragDx = 0,
                    onPointerUp: (_) => _dragDx = 0,
                    onPointerCancel: (_) => _dragDx = 0,
                    child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onVerticalDragStart: (d) {
                      _lastY = d.globalPosition.dy;
                      widget.onResizeStart();
                    },
                    onVerticalDragUpdate: (d) {
                      final dy = d.globalPosition.dy - _lastY;
                      if (dy == 0) return;
                      _lastY = d.globalPosition.dy;
                      widget.onResize(dy);
                    },
                    onVerticalDragEnd: (_) => widget.onResizeEnd(),
                    onVerticalDragCancel: () => widget.onResizeEnd(),
                    child: SizedBox(
                      width: 28,
                      height: 28,
                      child: CustomPaint(painter: _ResizeGripPainter(color: scheme.onSurfaceVariant)),
                    ),
                  ),
                  ),
                ),
              ),
              ),
              ),
            ),
          ]),
        ),
      ),
      ),
    );
  }
}

class _DetailPane extends StatefulWidget {
  final FishMemoryEntry item;
  final String kindLabel;
  final Color kindColor;
  final String sourceLabel;
  final ScrollController? controller;
  final bool busy;
  final VoidCallback? onPending;
  final VoidCallback? onForget;

  const _DetailPane({
    super.key,
    required this.item,
    required this.kindLabel,
    required this.kindColor,
    required this.sourceLabel,
    this.controller,
    this.busy = false,
    this.onPending,
    this.onForget,
  });

  @override
  State<_DetailPane> createState() => _DetailPaneState();
}

class _DetailPaneState extends State<_DetailPane> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final long = widget.item.text.length > 110;
    return Container(
      decoration: BoxDecoration(
          color: scheme.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: scheme.outlineVariant)),
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      child: SingleChildScrollView(
        controller: widget.controller,
        child:
            Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            Text('记忆详情',
                style: TextStyle(
                    fontSize: 10,
                    letterSpacing: .08,
                    fontWeight: FontWeight.w700,
                    color: scheme.onSurfaceVariant)),
            const Spacer(),
            Icon(Icons.lock_outline, size: 12, color: scheme.onSurfaceVariant),
          ]),
          const SizedBox(height: 7),
          Text(widget.kindLabel,
              style: TextStyle(
                  fontSize: 10,
                  color: widget.kindColor,
                  fontWeight: FontWeight.w700)),
          const SizedBox(height: 7),
          Text(widget.item.text,
              maxLines: _expanded ? null : 4,
              overflow: _expanded ? null : TextOverflow.ellipsis,
              style: TextStyle(
                  fontSize: 14, height: 1.8, color: scheme.onSurface)),
          if (long)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                onPressed: () => setState(() => _expanded = !_expanded),
                style: TextButton.styleFrom(
                    padding: EdgeInsets.zero,
                    minimumSize: const Size(0, 26),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap),
                child: Text(_expanded ? '收起' : '展开全文',
                    style: TextStyle(fontSize: 10, color: scheme.primary)),
              ),
            ),
          if (widget.item.tags.isNotEmpty) ...[
            const SizedBox(height: 8),
            Wrap(spacing: 5, runSpacing: 5, children: [
              for (final t in widget.item.tags)
                Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                    decoration: BoxDecoration(
                        color: scheme.surfaceContainerHighest
                            .withValues(alpha: .55),
                        borderRadius: BorderRadius.circular(5)),
                    child: Text(t,
                        style: TextStyle(
                            fontSize: 9, color: scheme.onSurfaceVariant))),
            ]),
          ],
          const SizedBox(height: 14),
          Divider(color: scheme.outlineVariant, height: 1),
          const SizedBox(height: 13),
          Text('来源与属性',
              style: TextStyle(
                  fontSize: 10,
                  letterSpacing: .08,
                  fontWeight: FontWeight.w700,
                  color: scheme.onSurfaceVariant)),
          const SizedBox(height: 8),
          _row(context, '来源', widget.sourceLabel),
          _row(context, '写入', shortFishTime(widget.item.at)),
          _row(context, '上次想起', widget.item.neverRecalled || widget.item.lastUsedAt.isEmpty ? '从未' : shortFishTime(widget.item.lastUsedAt)),
          _row(context, '上次确认', shortFishTime(widget.item.lastConfirmedAt)),
          _row(context, '状态', _statusText(widget.item.status)),
          const SizedBox(height: 15),
          Row(children: [
            Expanded(
              child: OutlinedButton.icon(
                onPressed: widget.busy ? null : widget.onPending,
                icon: widget.busy
                    ? const SizedBox(
                        width: 12,
                        height: 12,
                        child: CircularProgressIndicator(strokeWidth: 1.5))
                    : const Icon(Icons.flag_outlined, size: 13),
                label: const Text('标记待确认', style: TextStyle(fontSize: 10)),
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size(0, 30),
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  visualDensity: VisualDensity.compact,
                  side: BorderSide(color: scheme.outlineVariant),
                ),
              ),
            ),
            const SizedBox(width: 7),
            Expanded(
              child: TextButton.icon(
                onPressed: widget.busy ? null : widget.onForget,
                icon: const Icon(Icons.delete_outline, size: 13),
                label: const Text('忘记', style: TextStyle(fontSize: 10)),
                style: TextButton.styleFrom(
                  foregroundColor: scheme.error,
                  minimumSize: const Size(0, 30),
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  visualDensity: VisualDensity.compact,
                ),
              ),
            ),
          ]),
          const SizedBox(height: 11),
          Row(children: [
            Icon(Icons.chat_bubble_outline,
                size: 12, color: scheme.onSurfaceVariant),
            const SizedBox(width: 5),
            Expanded(
                child: Text('正文只读；想纠正她，直接在对话里说',
                    style: TextStyle(
                        fontSize: 9, color: scheme.onSurfaceVariant))),
          ]),
        ]),
      ),
    );
  }

  Widget _row(BuildContext context, String label, String value) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 7),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SizedBox(
            width: 60,
            child: Text(label,
                style:
                    TextStyle(fontSize: 10, color: scheme.onSurfaceVariant))),
        Expanded(
            child: Text(value.isEmpty ? '—' : value,
                style: TextStyle(
                    fontSize: 10,
                    color: scheme.onSurface,
                    fontFeatures: const [FontFeature.tabularFigures()]))),
      ]),
    );
  }
}

class _KbSearchCard extends StatefulWidget {
  @override
  State<_KbSearchCard> createState() => _KbSearchCardState();
}

class _KbSearchCardState extends State<_KbSearchCard> {
  final _q = TextEditingController();
  bool _busy = false;
  List<Map<String, dynamic>> _items = const [];
  String _err = '';
  bool _pendingOnly = false;
  String _rev = '';

  @override
  void dispose() {
    _q.dispose();
    super.dispose();
  }

  Future<void> _search({bool pendingOnly = false}) async {
    setState(() {
      _busy = true;
      _err = '';
      _pendingOnly = pendingOnly;
    });
    final r = await bridgeKbSearch(pendingOnly ? '' : _q.text.trim(),
        status: pendingOnly ? 'pending' : '');
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (r == null) {
        _err = '没连上主程序';
        _items = const [];
      } else if (r['ok'] != true) {
        _err = (r['error'] ?? '未知错误').toString();
        _items = const [];
      } else {
        _rev = (r['rev'] ?? '').toString();
        _items = ((r['items'] as List?) ?? const [])
            .map((e) => Map<String, dynamic>.from(e as Map))
            .toList();
      }
    });
  }

  Future<void> _setMemeStatus(Map<String, dynamic> it, String status) async {
    final r = await bridgeMemeStatus((it['id'] ?? '').toString(), status);
    if (!mounted) return;
    final ok = r != null && r['ok'] == true;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(
        content: Text(ok
            ? (status == 'confirmed' ? '已确认，以后能用了' : '已拒绝，不再提')
            : '没改成功：' + (r == null ? '没连上主程序' : (r['error'] ?? '未知错误').toString())),
        duration: const Duration(seconds: 2)));
    if (ok) await _search(pendingOnly: _pendingOnly);
  }

  Future<void> _edit(Map<String, dynamic> it) async {
    final name = TextEditingController(text: (it['name'] ?? '').toString());
    final meaning =
        TextEditingController(text: (it['meaning'] ?? '').toString());
    final usage = TextEditingController(text: (it['usage'] ?? '').toString());
    final avoid = TextEditingController(text: (it['avoid'] ?? '').toString());
    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('编辑「${it['name']}」'),
        content: SizedBox(
          width: 520,
          child: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              TextField(
                  controller: name,
                  decoration: const InputDecoration(
                      labelText: '名称',
                      border: OutlineInputBorder(),
                      isDense: true)),
              const SizedBox(height: 8),
              TextField(
                  controller: meaning,
                  maxLines: 3,
                  decoration: const InputDecoration(
                      labelText: '含义',
                      border: OutlineInputBorder(),
                      isDense: true)),
              const SizedBox(height: 8),
              TextField(
                  controller: usage,
                  maxLines: 2,
                  decoration: const InputDecoration(
                      labelText: '用法',
                      border: OutlineInputBorder(),
                      isDense: true)),
              const SizedBox(height: 8),
              TextField(
                  controller: avoid,
                  maxLines: 2,
                  decoration: const InputDecoration(
                      labelText: '避免',
                      border: OutlineInputBorder(),
                      isDense: true)),
            ]),
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('算了')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('保存')),
        ],
      ),
    );
    if (saved != true) return;
    final r = await bridgeKbUpdate({
      'id': it['id'],
      'name': name.text,
      'meaning': meaning.text,
      'usage': usage.text,
      'avoid': avoid.text,
      'rev': _rev,
    });
    if (!mounted) return;
    if (r != null && r['ok'] == true) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(const SnackBar(
          content: Text('已保存（回读校验通过）'), duration: Duration(seconds: 2)));
      await _search();
    } else {
      final err = r == null ? '没连上主程序' : (r['error'] ?? '未知错误').toString();
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(
          content: Text('没存成：$err'),
          backgroundColor: Theme.of(context).colorScheme.errorContainer));
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return FishCard(
      id: 'mem-kb-search',
      title: '知识库检索 / 编辑',
      note: _items.isEmpty ? '输入关键词查' : '${_items.length} 条结果',
      width: 560,
      height: 420,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Expanded(
            child: TextField(
              controller: _q,
              style: const TextStyle(fontSize: WhaleTokens.fsSmall),
              decoration: const InputDecoration(
                isDense: true,
                hintText: '搜梗 / 外观 / 约定，例如：九转大肠',
                border: OutlineInputBorder(),
                contentPadding:
                    EdgeInsets.symmetric(horizontal: 8, vertical: 8),
              ),
              onSubmitted: (_) => _search(),
            ),
          ),
          const SizedBox(width: 6),
          FilledButton(
              onPressed: _busy ? null : _search,
              child: Text(_busy ? '查…' : '搜索')),
          const SizedBox(width: 6),
          OutlinedButton(
              onPressed: _busy ? null : () => _search(pendingOnly: true),
              child: Text(_pendingOnly ? '待确认中' : '待确认')),
        ]),
        const SizedBox(height: 6),
        if (_err.isNotEmpty)
          Text(_err,
              style: TextStyle(
                  fontSize: WhaleTokens.fsSmall, color: scheme.error)),
        Expanded(
          child: _items.isEmpty
              ? Align(
                  alignment: Alignment.topLeft,
                  child: Text('搜出来点一条就能改名字/含义/用法/避免。',
                      style: TextStyle(
                          fontSize: WhaleTokens.fsSmall,
                          color: scheme.onSurfaceVariant)))
              : ListView.builder(
                  itemCount: _items.length,
                  itemBuilder: (_, i) {
                    final it = _items[i];
                    return ListTile(
                      dense: true,
                      visualDensity: VisualDensity.compact,
                      title: Text((it['name'] ?? '').toString(),
                          style: TextStyle(
                              fontSize: WhaleTokens.fsBody,
                              color: scheme.onSurface)),
                      subtitle: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text((it['meaning'] ?? '').toString(),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                    fontSize: WhaleTokens.fsSmall,
                                    color: scheme.onSurfaceVariant)),
                            // 待确认的要把原句和来源摆出来，不然没法判断该不该收。
                            if ((it['source'] ?? '').toString().isNotEmpty)
                              Text((it['source'] ?? '').toString(),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                      fontSize: WhaleTokens.fsCaption,
                                      color: scheme.onSurfaceVariant
                                          .withValues(alpha: .75))),
                          ]),
                      trailing: (it['status'] ?? '') == 'pending'
                          ? Row(mainAxisSize: MainAxisSize.min, children: [
                              IconButton(
                                  tooltip: '确认',
                                  icon: Icon(Icons.check_circle_outline,
                                      size: 18,
                                      color: WhaleTokens.successFor(
                                          scheme.brightness)),
                                  onPressed: () => _setMemeStatus(it, 'confirmed')),
                              IconButton(
                                  tooltip: '拒绝',
                                  icon: Icon(Icons.cancel_outlined,
                                      size: 18, color: scheme.error),
                                  onPressed: () => _setMemeStatus(it, 'rejected')),
                            ])
                          : Icon(Icons.edit_outlined,
                              size: 15, color: scheme.onSurfaceVariant),
                      onTap: () => _edit(it),
                    );
                  },
                ),
        ),
      ]),
    );
  }
}

String _statusText(String status) {
  switch (status) {
    case 'active':
      return '正常';
    case 'pending':
      return '待确认';
    case 'forgotten':
      return '已忘记';
    default:
      return status.isEmpty ? '未知' : status;
  }
}
class _MemoryDayPicker extends StatefulWidget {
  final Set<String> days;
  const _MemoryDayPicker({required this.days});

  @override
  State<_MemoryDayPicker> createState() => _MemoryDayPickerState();
}

class _MemoryDayPickerState extends State<_MemoryDayPicker> {
  late DateTime _month = DateTime.now();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final first = DateTime(_month.year, _month.month, 1);
    final start = first.weekday % 7;
    final count = DateTime(_month.year, _month.month + 1, 0).day;
    final cells = <Widget>[];
    for (var i = 0; i < start; i++) cells.add(const SizedBox.shrink());
    for (var d = 1; d <= count; d++) {
      final key = _month.year.toString().padLeft(4, '0') + '-' + _month.month.toString().padLeft(2, '0') + '-' + d.toString().padLeft(2, '0');
      final has = widget.days.contains(key);
      cells.add(InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: () => Navigator.pop(context, key),
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
          Text(d.toString(), style: TextStyle(fontSize: 12, color: has ? scheme.onSurface : scheme.onSurfaceVariant)),
          Container(width: 4, height: 4, decoration: BoxDecoration(color: has ? scheme.primary : Colors.transparent, shape: BoxShape.circle)),
        ]),
      ));
    }
    return AlertDialog(
      title: Row(children: [
        IconButton(onPressed: () => setState(() => _month = DateTime(_month.year, _month.month - 1, 1)), icon: const Icon(Icons.chevron_left, size: 18)),
        Expanded(child: Text(_month.year.toString() + ' 年 ' + _month.month.toString() + ' 月', textAlign: TextAlign.center, style: const TextStyle(fontSize: 14))),
        IconButton(onPressed: () => setState(() => _month = DateTime(_month.year, _month.month + 1, 1)), icon: const Icon(Icons.chevron_right, size: 18)),
      ]),
      content: SizedBox(width: 320, child: GridView.count(crossAxisCount: 7, shrinkWrap: true, physics: const NeverScrollableScrollPhysics(), children: cells)),
    );
  }
}
