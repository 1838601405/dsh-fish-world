import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../bento.dart';
import '../data/bridge.dart';
import '../data/fish_data.dart';
import '../theme/whale_tokens.dart';
import '../ui_motion.dart';
import '../fish_nav.dart';

// ignore_for_file: prefer_interpolation_to_compose_strings, curly_braces_in_flow_control_structures, prefer_const_constructors

class FishDiaryPage extends StatefulWidget {
  const FishDiaryPage({super.key});

  @override
  State<FishDiaryPage> createState() => _FishDiaryPageState();
}

class _FishDiaryPageState extends State<FishDiaryPage> {
  @override
  void initState() {
    super.initState();
    final t = FishNav.consumeTarget();
    if (t.isNotEmpty) {
      _selectedDate = t;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _loadDay(t);
      });
    }
  }

  Future<FishSnapshot> _future = FishWorld.load();
  DateTime? _month;
  String _selectedDate = '';
  Map<String, int> _routeDates = {};
  List<FishDiaryEntry> _routeItems = [];
  bool _routeBusy = false;
  String _routeError = '';
  bool _initialized = false;

  void _reload() {
    setState(() => _future = FishWorld.load());
  }

  Future<void> _loadDates(DateTime month) async {
    final r = await bridgeDiaryDates(_monthKey(month));
    if (!mounted) return;
    setState(() {
      _routeDates = r != null && r['ok'] == true && r['counts'] is Map
          ? (r['counts'] as Map).map((k, v) => MapEntry(
              k.toString(), v is int ? v : int.tryParse(v.toString()) ?? 0))
          : {};
    });
  }

  Future<void> _loadDay(String date) async {
    if (date.isEmpty) {
      setState(() {
        _routeItems = [];
      });
      return;
    }
    setState(() {
      _routeBusy = true;
      _routeError = '';
    });
    final r = await bridgeDiaryDay(date);
    if (!mounted) return;
    if (r != null && r['ok'] == true && r['entries'] is List) {
      setState(() {
        _routeItems = [
          for (final e in (r['entries'] as List)) FishDiaryEntry.fromJson(e)
        ];
        _routeBusy = false;
      });
    } else {
      setState(() {
        _routeBusy = false;
        _routeError = (r?['error'] ?? '读取失败').toString();
      });
    }
  }

  Future<void> _decide(String id, String decision) async {
    final r = await bridgeFishDiaryDecision(id, decision);
    if (!mounted) return;
    if (r != null && r['ok'] == true) {
      _reload();
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(
          content: Text(decision == 'approve' ? '已通过（回读校验通过）' : '已退回（回读校验通过）'),
          duration: const Duration(seconds: 2)));
    } else {
      final err = r == null ? '没连上主程序' : (r['error'] ?? '未知错误').toString();
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(
          content: Text('没处理成：' + err),
          backgroundColor: Theme.of(context).colorScheme.errorContainer));
    }
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<FishSnapshot>(
      future: _future,
      builder: (ctx, snap) {
        if (snap.connectionState != ConnectionState.done)
          return _skeleton(context);
        if (snap.hasError) return _emptyPage(context, snap.error.toString());
        final data = snap.data ?? FishSnapshot.empty();
        if (!data.ok)
          return _emptyPage(context, '还没读到鱼的日记。请打开 DSH 桌面端，确认「鱼的世界」工作区已绑定。');
        return _body(context, data);
      },
    );
  }

  Widget _body(BuildContext context, FishSnapshot data) {
    final diary = data.diary;
    final items = diary.items;
    if (!_initialized && items.isNotEmpty) {
      _initialized = true;
      final key = _dayKey(items.first);
      _selectedDate = key;
      _month = _parseDay(key) ?? DateTime.now();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        _loadDates(_month!);
        _loadDay(_selectedDate);
      });
    }
    final counts = <String, int>{};
    for (final item in items) {
      final key = _dayKey(item);
      if (key.isEmpty) continue;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    for (final entry in _routeDates.entries) {
      counts[entry.key] = (counts[entry.key] ?? 0) + entry.value;
    }
    final latest = items.isEmpty ? null : _parseDay(_dayKey(items.first));
    final month = _month ?? (latest ?? DateTime.now());
    final monthKey = _monthKey(month);
    final monthCount = counts.entries
        .where((e) => e.key.startsWith(monthKey))
        .fold(0, (sum, e) => sum + e.value);
    final filtered = _selectedDate.isEmpty
        ? items
        : (_routeItems.isNotEmpty
            ? _routeItems
            : items.where((item) => _dayKey(item) == _selectedDate).toList());
    final scheme = Theme.of(context).colorScheme;

    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(
          WhaleTokens.gap, WhaleTokens.gap, WhaleTokens.gap, 104),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 1180),
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            _topBar(context, month, scheme),
            const SizedBox(height: 14),
            LayoutBuilder(builder: (ctx, box) {
              final wide = box.maxWidth >= 820;
              final calendar = _CalendarPanel(
                month: month,
                counts: counts,
                selectedDate: _selectedDate,
                monthCount: monthCount,
                onMonth: (next) {
                  setState(() {
                    _month = next;
                    _selectedDate = '';
                    _routeItems = [];
                  });
                  _loadDates(next);
                },
                onToday: () {
                  final today = DateTime.now();
                  final date = _day(today);
                  setState(() {
                    _month = DateTime(today.year, today.month, 1);
                    _selectedDate = date;
                  });
                  _loadDates(_month!);
                  _loadDay(date);
                },
                onAll: () {
                  setState(() => _selectedDate = '');
                },
                onSelect: (date) {
                  setState(() {
                    _selectedDate = date;
                    _routeItems = [];
                  });
                  _loadDay(date);
                },
              );
              final content = _diaryColumn(context, diary, filtered, scheme);
              if (!wide) {
                return Column(
                    children: [calendar, const SizedBox(height: 16), content]);
              }
              return Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(width: 310, child: calendar),
                    const SizedBox(width: 18),
                    Expanded(child: content),
                  ]);
            }),
          ]),
        ),
      ),
    );
  }

  Widget _topBar(BuildContext context, DateTime month, ColorScheme scheme) {
    return Row(children: [
      Text('鱼的日记',
          style: TextStyle(
              fontSize: 22,
              fontWeight: FontWeight.w700,
              color: scheme.onSurface)),
      const Spacer(),
      if (_selectedDate.isNotEmpty)
        TextButton(
          onPressed: () => setState(() => _selectedDate = ''),
          child: const Text('全部'),
        ),
    ]);
  }

  Widget _diaryColumn(BuildContext context, FishDiary diary,
      List<FishDiaryEntry> items, ColorScheme scheme) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.45),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Text(_selectedDate.isEmpty ? '全部日记' : _selectedDate,
              style: TextStyle(
                  fontSize: WhaleTokens.fsSub,
                  fontWeight: FontWeight.w700,
                  color: scheme.onSurface)),
          const Spacer(),
          if (_routeBusy)
            Row(children: [
              const SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(strokeWidth: 2)),
              const SizedBox(width: 6),
              Text('读取当天…',
                  style: TextStyle(
                      fontSize: WhaleTokens.fsCaption,
                      color: scheme.onSurfaceVariant)),
            ])
          else if (_routeError.isNotEmpty)
            Text(
                _routeError.startsWith('读取失败')
                    ? _routeError
                    : '读取失败：' + _routeError,
                style: TextStyle(
                    fontSize: WhaleTokens.fsCaption, color: scheme.error)),
        ]),
        const SizedBox(height: 10),
        if (items.isEmpty)
          Text(
              _selectedDate.isEmpty
                  ? (items.isEmpty ? '我还没写过日记。' : '这天没写。')
                  : '这天没写。',
              style: TextStyle(
                  fontSize: WhaleTokens.fsSub, color: scheme.onSurfaceVariant))
        else
          for (var i = 0; i < items.length; i++)
            _DiaryEntryPanel(
                entry: items[i],
                last: i == items.length - 1,
                onDecide: _decide,
                onSent: _reload),
      ]),
    );
  }

  Widget _skeleton(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(
          WhaleTokens.gap, WhaleTokens.gap, WhaleTokens.gap, 104),
      child: Column(children: [
        const ShimmerBox(height: 40, radius: 8),
        const SizedBox(height: 14),
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const ShimmerBox(width: 310, height: 320, radius: 12),
          const SizedBox(width: 18),
          const Expanded(child: ShimmerBox(height: 380, radius: 12)),
        ]),
      ]),
    );
  }

  Widget _emptyPage(BuildContext context, String text) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: _emptyPanel(context, text),
    );
  }

  Widget _emptyPanel(BuildContext context, String text) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(22),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.35),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Text(text,
          style: TextStyle(
              fontSize: WhaleTokens.fsSub,
              height: 1.6,
              color: scheme.onSurfaceVariant)),
    );
  }
}

String _day(DateTime d) =>
    d.year.toString().padLeft(4, '0') +
    '-' +
    d.month.toString().padLeft(2, '0') +
    '-' +
    d.day.toString().padLeft(2, '0');

String _dayKey(FishDiaryEntry item) {
  final raw = item.date.isNotEmpty ? item.date : item.at;
  final match = RegExp(r'^([0-9]{4}-[0-9]{2}-[0-9]{2})').firstMatch(raw);
  return match?.group(1) ?? '';
}

DateTime? _parseDay(String key) {
  if (key.length < 10) return null;
  return DateTime.tryParse(key);
}

String _monthKey(DateTime value) =>
    value.year.toString().padLeft(4, '0') +
    '-' +
    value.month.toString().padLeft(2, '0');

class _CalendarDayCell extends StatefulWidget {
  final int day;
  final String dateKey;
  final int count;
  final bool selected;
  final VoidCallback onSelect;
  const _CalendarDayCell(
      {required this.day,
      required this.dateKey,
      required this.count,
      required this.selected,
      required this.onSelect});

  @override
  State<_CalendarDayCell> createState() => _CalendarDayCellState();
}

class _CalendarDayCellState extends State<_CalendarDayCell> {
  final FocusNode _focus = FocusNode();
  bool _focused = false;

  @override
  void dispose() {
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Focus(
      focusNode: _focus,
      onFocusChange: (v) => setState(() => _focused = v),
      onKeyEvent: (node, event) {
        final key = event.logicalKey;
        TraversalDirection? dir;
        if (key == LogicalKeyboardKey.arrowLeft) dir = TraversalDirection.left;
        if (key == LogicalKeyboardKey.arrowRight)
          dir = TraversalDirection.right;
        if (key == LogicalKeyboardKey.arrowUp) dir = TraversalDirection.up;
        if (key == LogicalKeyboardKey.arrowDown) dir = TraversalDirection.down;
        if (dir != null) {
          FocusScope.of(context).focusInDirection(dir);
          return KeyEventResult.handled;
        }
        if (key == LogicalKeyboardKey.enter ||
            key == LogicalKeyboardKey.numpadEnter ||
            key == LogicalKeyboardKey.space) {
          widget.onSelect();
          return KeyEventResult.handled;
        }
        return KeyEventResult.ignored;
      },
      child: GestureDetector(
        onTap: widget.onSelect,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 120),
          decoration: BoxDecoration(
            color: widget.selected
                ? scheme.primary.withValues(alpha: 0.16)
                : widget.count > 0
                    ? scheme.primaryContainer.withValues(alpha: 0.32)
                    : Colors.transparent,
            borderRadius: BorderRadius.circular(WhaleTokens.rSm),
            border:
                _focused ? Border.all(color: scheme.primary, width: 2) : null,
          ),
          child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
            Text(widget.day.toString(),
                style: TextStyle(
                    fontSize: WhaleTokens.fsSmall,
                    color:
                        widget.selected ? scheme.primary : scheme.onSurface)),
            Container(
              width: 4,
              height: 4,
              decoration: BoxDecoration(
                color: widget.count > 0
                    ? scheme.primary.withValues(alpha: 0.7)
                    : Colors.transparent,
                shape: BoxShape.circle,
              ),
            ),
          ]),
        ),
      ),
    );
  }
}

class _CalendarPanel extends StatelessWidget {
  final DateTime month;
  final Map<String, int> counts;
  final String selectedDate;
  final int monthCount;
  final ValueChanged<DateTime> onMonth;
  final ValueChanged<String> onSelect;
  final VoidCallback onToday;
  final VoidCallback onAll;

  const _CalendarPanel({
    required this.month,
    required this.counts,
    required this.selectedDate,
    required this.monthCount,
    required this.onMonth,
    required this.onSelect,
    required this.onToday,
    required this.onAll,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final first = DateTime(month.year, month.month, 1);
    final offset = (first.weekday + 6) % 7;
    final dayCount = DateTime(month.year, month.month + 1, 0).day;
    final cells = <Widget>[];
    for (var i = 0; i < offset; i++) cells.add(const SizedBox());
    for (var day = 1; day <= dayCount; day++) {
      final key = _monthKey(month) + '-' + day.toString().padLeft(2, '0');
      final count = counts[key] ?? 0;
      final selected = selectedDate == key;
      cells.add(_CalendarDayCell(
        day: day,
        dateKey: key,
        count: count,
        selected: selected,
        onSelect: () => onSelect(key),
      ));
    }
    while (cells.length % 7 != 0) cells.add(const SizedBox());

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.45),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          IconButton(
              onPressed: () =>
                  onMonth(DateTime(month.year, month.month - 1, 1)),
              icon: const Icon(Icons.chevron_left, size: 18)),
          Expanded(
              child: Text(
                  month.year.toString() + ' 年 ' + month.month.toString() + ' 月',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                      fontSize: WhaleTokens.fsSub,
                      fontWeight: FontWeight.w700,
                      color: scheme.onSurface))),
          IconButton(
              onPressed: () =>
                  onMonth(DateTime(month.year, month.month + 1, 1)),
              icon: const Icon(Icons.chevron_right, size: 18)),
        ]),
        Row(children: [
          Expanded(
              child: Text(monthCount.toString() + ' 篇',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                      fontSize: WhaleTokens.fsCaption,
                      color: scheme.onSurfaceVariant))),
          TextButton(
              onPressed: onToday,
              style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
              child: const Text('今天')),
          TextButton(
              onPressed: onAll,
              style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
              child: const Text('全部')),
        ]),
        Row(children: [
          for (final label in ['一', '二', '三', '四', '五', '六', '日'])
            Expanded(
                child: Text(label,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                        fontSize: WhaleTokens.fsCaption,
                        color: scheme.onSurfaceVariant))),
        ]),
        const SizedBox(height: 2),
        GridView.count(
          crossAxisCount: 7,
          childAspectRatio: 1.05,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          padding: EdgeInsets.zero,
          children: cells,
        ),
        // 与右栏卡底对齐：右栏最后一张卡没有 margin 时仍差 12px 的内边距。
        const SizedBox(height: 39),
      ]),
    );
  }
}

class _DiaryEntryPanel extends StatefulWidget {
  final FishDiaryEntry entry;
  final bool last;
  final Future<void> Function(String id, String decision) onDecide;
  final VoidCallback onSent;
  const _DiaryEntryPanel(
      {required this.entry,
      this.last = false,
      required this.onDecide,
      required this.onSent});

  @override
  State<_DiaryEntryPanel> createState() => _DiaryEntryPanelState();
}

class _DiaryEntryPanelState extends State<_DiaryEntryPanel> {
  final GlobalKey _bodyKey = GlobalKey();
  Timer? _highlightTimer;
  String _pendingQuote = '';
  String _selectedQuote = '';
  String _highlight = '';

  @override
  void dispose() {
    _highlightTimer?.cancel();
    super.dispose();
  }

  String _normalizeQuote(String raw, String full) {
    final trimmed = raw.trim();
    if (trimmed.isEmpty) return '';
    // 跨段选择只取起始段，绝不跨越段落把两句话缝在一起。
    final paragraphs = full.split(RegExp(r'\n+'));
    var first = '';
    for (final p in paragraphs) {
      if (p.contains(trimmed)) {
        first = trimmed;
        break;
      }
      for (var len = trimmed.length; len > 0; len--) {
        final candidate = trimmed.substring(0, len);
        if (p.contains(candidate)) {
          first = candidate;
          break;
        }
      }
      if (first.isNotEmpty) break;
    }
    if (first.isEmpty) first = trimmed;
    return first.length > 40 ? first.substring(0, 40) + '…' : first;
  }

  void _startQuote(String raw, String full) {
    final quote = _normalizeQuote(raw, full);
    if (quote.isEmpty) return;
    final cross = raw.trim().split(RegExp(r'\n')).length > 1;
    setState(() {
      _selectedQuote = quote;
      _pendingQuote = quote;
    });
    if (cross) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(
            content: Text('按段批注，已取第一段'), duration: Duration(seconds: 2)),
      );
    }
  }

  void _highlightQuote(String quote) {
    if (quote.isEmpty) return;
    setState(() => _highlight = quote);
    final ctx = _bodyKey.currentContext;
    if (ctx != null) {
      Scrollable.ensureVisible(ctx,
          duration: const Duration(milliseconds: 300), alignment: 0.15);
    }
    _highlightTimer?.cancel();
    _highlightTimer = Timer(const Duration(milliseconds: 1500), () {
      if (mounted) setState(() => _highlight = '');
    });
  }

  List<InlineSpan> _bodySpans(String text, TextStyle base) {
    if (_highlight.isEmpty || !text.contains(_highlight)) {
      return [TextSpan(text: text, style: base)];
    }
    final i = text.indexOf(_highlight);
    return [
      if (i > 0) TextSpan(text: text.substring(0, i), style: base),
      TextSpan(
        text: _highlight,
        style: base.copyWith(
          backgroundColor:
              Theme.of(context).colorScheme.primary.withValues(alpha: 0.18),
        ),
      ),
      if (i + _highlight.length < text.length)
        TextSpan(text: text.substring(i + _highlight.length), style: base),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final entry = widget.entry;
    final onDecide = widget.onDecide;
    final onSent = widget.onSent;
    final scheme = Theme.of(context).colorScheme;
    final comments = entry.comments;
    final status = entry.status == 'pending'
        ? '待确认'
        : (entry.status == 'rejected' ? '已退回' : '已批准');
    final statusColor =
        entry.status == 'pending' ? scheme.tertiary : scheme.primary;
    return FishHoverCard(
      margin: EdgeInsets.only(bottom: widget.last ? 0 : 12),
      padding: const EdgeInsets.fromLTRB(18, 14, 18, 12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Text(entry.date.isEmpty ? '未标日期' : entry.date,
              style: TextStyle(
                  fontSize: WhaleTokens.fsSub,
                  fontWeight: FontWeight.w700,
                  color: scheme.onSurface)),
          const SizedBox(width: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            decoration: BoxDecoration(
                color: statusColor.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(5)),
            child: Text(status,
                style: TextStyle(
                    fontSize: WhaleTokens.fsCaption, color: statusColor)),
          ),
          const SizedBox(width: 8),
          Text(entry.who.isEmpty ? '鱼' : entry.who,
              style: TextStyle(
                  fontSize: WhaleTokens.fsCaption,
                  color: scheme.onSurfaceVariant)),
          const Spacer(),
        ]),
        const SizedBox(height: 10),
        KeyedSubtree(
          key: _bodyKey,
          child: SelectableText.rich(
            TextSpan(
              children: _bodySpans(
                entry.text.isEmpty ? '（这篇日记是空的）' : entry.text,
                TextStyle(
                    fontSize: WhaleTokens.fsSub,
                    height: 1.8,
                    color: scheme.onSurface),
              ),
            ),
            onSelectionChanged: (selection, cause) {
              setState(() => _selectedQuote = selection.textInside(entry.text));
            },
            contextMenuBuilder: (context, state) {
              final sel = _selectedQuote.trim().isNotEmpty
                  ? _selectedQuote
                  : state.textEditingValue.selection
                      .textInside(state.textEditingValue.text);
              if (sel.trim().isEmpty) return const SizedBox.shrink();
              return AdaptiveTextSelectionToolbar.buttonItems(
                anchors: state.contextMenuAnchors,
                buttonItems: [
                  ContextMenuButtonItem(
                    label: '批注这段',
                    onPressed: () {
                      state.hideToolbar();
                      _startQuote(sel, entry.text);
                    },
                  ),
                ],
              );
            },
          ),
        ),
        if (_selectedQuote.trim().isNotEmpty)
          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              onPressed: () {
                final q = _selectedQuote;
                setState(() => _selectedQuote = '');
                _startQuote(q, entry.text);
              },
              icon: const Icon(Icons.edit_note, size: 15),
              label: const Text('批注选中片段'),
              style: TextButton.styleFrom(foregroundColor: scheme.primary),
            ),
          ),
        if (comments.isNotEmpty) ...[
          const SizedBox(height: 14),
          Text('批语 ' + comments.length.toString() + ' 条',
              style: TextStyle(
                  fontSize: WhaleTokens.fsSmall,
                  color: scheme.onSurfaceVariant)),
          const SizedBox(height: 6),
          for (final c in comments)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(children: [
                      Text((c.who.isEmpty ? '主人' : c.who) + '：',
                          style: TextStyle(
                              fontSize: WhaleTokens.fsSmall,
                              fontWeight: FontWeight.w600,
                              color: scheme.onSurfaceVariant)),
                      if (c.respondedAt.isNotEmpty) ...[
                        const SizedBox(width: 8),
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 6, vertical: 1),
                          decoration: BoxDecoration(
                              color: scheme.primary.withValues(alpha: 0.10),
                              borderRadius: BorderRadius.circular(4)),
                          child: Text('鱼已回应',
                              style: TextStyle(
                                  fontSize: 10, color: scheme.primary)),
                        ),
                      ],
                    ]),
                    if (c.quote.isNotEmpty)
                      InkWell(
                        onTap: () => _highlightQuote(c.quote),
                        child: Container(
                          margin: const EdgeInsets.only(top: 4, bottom: 4),
                          padding: const EdgeInsets.only(left: 8),
                          decoration: BoxDecoration(
                              border: Border(
                                  left: BorderSide(
                                      color: scheme.primary
                                          .withValues(alpha: 0.55),
                                      width: 2))),
                          child: Text('『' + c.quote + '』',
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                  fontSize: WhaleTokens.fsSmall,
                                  height: 1.5,
                                  color: scheme.onSurfaceVariant)),
                        ),
                      ),
                    Text(c.text,
                        style: TextStyle(
                            fontSize: WhaleTokens.fsSmall,
                            height: 1.6,
                            color: scheme.onSurfaceVariant)),
                  ]),
            ),
        ],
        if (entry.id.isNotEmpty && entry.status == 'pending') ...[
          const SizedBox(height: 4),
          Row(children: [
            TextButton(
                onPressed: () => onDecide(entry.id, 'approve'),
                child: const Text('通过')),
            const SizedBox(width: 4),
            TextButton(
              onPressed: () => onDecide(entry.id, 'reject'),
              style: TextButton.styleFrom(foregroundColor: scheme.error),
              child: const Text('退回'),
            ),
          ]),
        ],
        if (entry.id.isNotEmpty) ...[
          const SizedBox(height: 8),
          _DiaryCommentBox(
            diaryId: entry.id,
            quote: _pendingQuote,
            onSent: () {
              setState(() => _pendingQuote = '');
              onSent();
            },
          ),
        ],
      ]),
    );
  }
}

class _DiaryCommentBox extends StatefulWidget {
  final String diaryId;
  final String quote;
  final VoidCallback onSent;
  const _DiaryCommentBox(
      {required this.diaryId, this.quote = '', required this.onSent});

  @override
  State<_DiaryCommentBox> createState() => _DiaryCommentBoxState();
}

class _DiaryCommentBoxState extends State<_DiaryCommentBox> {
  final _ctl = TextEditingController();
  final _focus = FocusNode();
  bool _busy = false;
  String _quote = '';

  @override
  void initState() {
    super.initState();
    _applyQuote(widget.quote);
  }

  @override
  void didUpdateWidget(covariant _DiaryCommentBox old) {
    super.didUpdateWidget(old);
    if (widget.quote != old.quote) _applyQuote(widget.quote);
  }

  @override
  void dispose() {
    _ctl.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _applyQuote(String quote) {
    if (quote.isEmpty) return;
    _quote = quote;
    _ctl.text = '针对『' + quote + '』：';
    _ctl.selection = TextSelection.collapsed(offset: _ctl.text.length);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focus.requestFocus();
    });
  }

  Future<void> _send() async {
    var text = _ctl.text.trim();
    final prefix = _quote.isEmpty ? '' : '针对『' + _quote + '』：';
    if (prefix.isNotEmpty && text.startsWith(prefix))
      text = text.substring(prefix.length).trim();
    if (text.isEmpty || _busy) return;
    setState(() => _busy = true);
    final r = await bridgeFishDiaryComment(widget.diaryId, text, quote: _quote);
    if (!mounted) return;
    setState(() => _busy = false);
    final scheme = Theme.of(context).colorScheme;
    if (r != null && r['ok'] == true) {
      _ctl.clear();
      _quote = '';
      widget.onSent();
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(const SnackBar(
          content: Text('批语已留下（回读校验通过）'), duration: Duration(seconds: 2)));
    } else {
      final err = r == null ? '没连上主程序' : (r['error'] ?? '未知错误').toString();
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(
          content: Text('没写下：' + err), backgroundColor: scheme.errorContainer));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Row(children: [
      Expanded(
        child: TextField(
          controller: _ctl,
          focusNode: _focus,
          style: const TextStyle(fontSize: WhaleTokens.fsSmall),
          decoration: const InputDecoration(
            isDense: true,
            hintText: '留一句批语…',
            border: OutlineInputBorder(),
            contentPadding: EdgeInsets.symmetric(horizontal: 8, vertical: 8),
          ),
          onSubmitted: (_) => _send(),
        ),
      ),
      const SizedBox(width: 6),
      FilledButton(
        onPressed: _busy ? null : _send,
        style: FilledButton.styleFrom(visualDensity: VisualDensity.compact),
        child: _busy
            ? const SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(strokeWidth: 2))
            : const Text('留批语'),
      ),
    ]);
  }
}
