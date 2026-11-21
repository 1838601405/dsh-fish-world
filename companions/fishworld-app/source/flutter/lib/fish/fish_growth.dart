import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../data/bridge.dart';
import '../bento.dart';
import '../data/fish_data.dart';
import '../theme/whale_tokens.dart';
import '../ui_motion.dart';
import '../fish_nav.dart';
import '../fish_tooltip.dart';
import 'fish_common.dart';

// ignore_for_file: prefer_interpolation_to_compose_strings

const double kGrowthBarGap = 4;
const double kGrowthBarMinWidth = 6;
const double kGrowthBarMaxWidth = 24;
const int kGrowthMinChartDays = 3;

/// 鱼的成长：阶段 / 数据表盘 / 成长节点 / 鱼生大事。只读，修订与撤回保留。
class FishGrowthPage extends StatefulWidget {
  const FishGrowthPage({super.key});

  @override
  State<FishGrowthPage> createState() => _FishGrowthPageState();
}

class _FishGrowthPageState extends State<FishGrowthPage> {
  String _highlightId = '';

  @override
  void initState() {
    super.initState();
    _highlightId = FishNav.consumeTarget();
  }

  Future<FishSnapshot> _future = FishWorld.load();
  String _selectedDay = '';

  void _reload() {
    setState(() => _future = FishWorld.load());
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<FishSnapshot>(
      future: _future,
      builder: (ctx, snap) {
        if (snap.connectionState != ConnectionState.done)
          return _skeleton(context);
        if (snap.hasError) return _empty(context, '${snap.error}');
        final data = snap.data ?? FishSnapshot.empty();
        if (!data.ok) {
          return _empty(context, '还没读到鱼的成长。请打开 DSH 桌面端，确认「鱼的世界」工作区已绑定。');
        }
        return _body(context, data);
      },
    );
  }

  Widget _body(BuildContext context, FishSnapshot data) {
    final growth = data.growth;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(
          WhaleTokens.gap, WhaleTokens.gap, WhaleTokens.gap, 104),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 1120),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _StageHero(growth: growth, profile: data.profile),
              const SizedBox(height: 12),
              _StatRow(growth: growth),
              const SizedBox(height: 12),
              LayoutBuilder(builder: (_, box) {
                final wide = box.maxWidth >= 760;
                final chart = _ActivityCard(
                  growth: growth,
                  selectedDay: _selectedDay,
                  onDay: (day) => setState(
                      () => _selectedDay = _selectedDay == day ? '' : day),
                );
                final knowledge = _KnowledgeCard(data: data);
                if (!wide) {
                  return Column(
                      children: [chart, const SizedBox(height: 12), knowledge]);
                }
                return IntrinsicHeight(
                  child: Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Expanded(flex: 2, child: chart),
                        const SizedBox(width: 12),
                        Expanded(flex: 1, child: knowledge),
                      ]),
                );
              }),
              if (data.activity.total > 0) ...[
                const SizedBox(height: 12),
                _TogetherCard(data: data),
              ],
              const SizedBox(height: 12),
              _LifeCard(data: data),
              const SizedBox(height: 12),
              _GrowthTimeline(
                  items: growth.items,
                  day: _selectedDay,
                  highlightId: _highlightId,
                  onChanged: _reload,
                  onClear: () => setState(() => _selectedDay = '')),
              const SizedBox(height: 12),
              _TraceCard(data: data),
            ],
          ),
        ),
      ),
    );
  }

  Widget _skeleton(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(
          WhaleTokens.gap, WhaleTokens.gap, WhaleTokens.gap, 104),
      child: Column(children: [
        _skeletonBlock(context, 190),
        const SizedBox(height: 12),
        Row(children: [
          for (var i = 0; i < 3; i++) ...[
            Expanded(child: _skeletonBlock(context, 96)),
            if (i < 2) const SizedBox(width: 12),
          ],
        ]),
        const SizedBox(height: 12),
        Row(children: [
          Expanded(flex: 2, child: _skeletonBlock(context, 240)),
          const SizedBox(width: 12),
          Expanded(child: _skeletonBlock(context, 240)),
        ]),
      ]),
    );
  }

  // 骨架块用微光（蓝白流动），不是整块灰——看不出在加载就是死板。
  Widget _skeletonBlock(BuildContext context, double h) =>
      ShimmerBox(height: h, radius: WhaleTokens.rXl);

  Widget _empty(BuildContext context, String text) {
    final scheme = Theme.of(context).colorScheme;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(
          WhaleTokens.gap, WhaleTokens.gap, WhaleTokens.gap, 104),
      child: _Panel(
        child: Text(text,
            style: TextStyle(
                fontSize: WhaleTokens.fsSub,
                height: 1.6,
                color: scheme.onSurfaceVariant)),
      ),
    );
  }
}

class _Panel extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  const _Panel({required this.child, this.padding = const EdgeInsets.all(16)});
  @override
  Widget build(BuildContext context) =>
      FishHoverCard(padding: padding, child: child);
}

class _StageHero extends StatelessWidget {
  final FishGrowth growth;
  final FishProfile profile;
  const _StageHero({required this.growth, required this.profile});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final stage = growth.stage;
    final progress = stage.progress.clamp(0.0, 1.0);
    final pct = (progress * 100).round();
    return _Panel(
      padding: const EdgeInsets.all(22),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                Text('当前阶段',
                    style: TextStyle(
                        fontSize: WhaleTokens.fsSmall,
                        color: scheme.onSurfaceVariant)),
                const SizedBox(height: 4),
                Text(stage.name.isEmpty ? '还没读到阶段' : stage.name,
                    style: TextStyle(
                        fontSize: 30,
                        fontWeight: FontWeight.w700,
                        color: scheme.primary)),
                const SizedBox(height: 6),
                Text(stage.desc.isEmpty ? '还没有阶段说明。' : stage.desc,
                    style: TextStyle(
                        fontSize: WhaleTokens.fsSub,
                        height: 1.5,
                        color: scheme.onSurfaceVariant)),
              ])),
          const SizedBox(width: 16),
          SizedBox(
              width: 78,
              height: 78,
              child: Stack(alignment: Alignment.center, children: [
                SizedBox(
                    width: 78,
                    height: 78,
                    child: CircularProgressIndicator(
                      value: progress,
                      strokeWidth: 6,
                      backgroundColor:
                          scheme.outlineVariant.withValues(alpha: 0.4),
                      color: scheme.primary,
                    )),
                Text('$pct%',
                    style: TextStyle(
                        fontSize: WhaleTokens.fsSub,
                        fontWeight: FontWeight.w700,
                        color: scheme.onSurface)),
              ])),
          const SizedBox(width: 12),
          FishAvatar(profile: profile, size: 150),
        ]),
        const SizedBox(height: 16),
        Row(children: [
          Text('${growth.total} 条记录',
              style: TextStyle(
                  fontSize: WhaleTokens.fsSmall,
                  color: scheme.onSurfaceVariant)),
          const Spacer(),
          Text(
              stage.nextName.isEmpty
                  ? '已到最高阶段'
                  : '还差 ${stage.toNext} 条到「${stage.nextName}」',
              style: TextStyle(
                  fontSize: WhaleTokens.fsSmall,
                  color: scheme.onSurfaceVariant)),
        ]),
        const SizedBox(height: 8),
        ClipRRect(
          borderRadius: BorderRadius.circular(WhaleTokens.rSm),
          child: LinearProgressIndicator(
            value: progress,
            minHeight: 8,
            backgroundColor: scheme.outlineVariant.withValues(alpha: 0.35),
            color: scheme.primary,
          ),
        ),
        const SizedBox(height: 10),
        Row(children: [
          Text(growth.firstDay.isEmpty ? '还没开始' : '从 ${growth.firstDay} 开始',
              style: TextStyle(
                  fontSize: WhaleTokens.fsCaption,
                  color: scheme.onSurfaceVariant)),
          const Spacer(),
          Text(growth.days.toString() + ' 天有记录',
              style: TextStyle(
                  fontSize: WhaleTokens.fsCaption,
                  color: scheme.onSurfaceVariant)),
          const Spacer(),
          Text(growth.lastDay.isEmpty ? '—' : '最近 ${growth.lastDay}',
              style: TextStyle(
                  fontSize: WhaleTokens.fsCaption,
                  color: scheme.onSurfaceVariant)),
        ]),
      ]),
    );
  }
}

class _StatRow extends StatelessWidget {
  final FishGrowth growth;
  const _StatRow({required this.growth});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return LayoutBuilder(builder: (_, box) {
      final tiles = [
        _StatTile(
            icon: Icons.lightbulb_outline,
            label: '认识',
            value: growth.kindCount('insight').toString(),
            sub: '想明白的事',
            tone: scheme.primary),
        _StatTile(
            icon: Icons.arrow_forward_outlined,
            label: '下次怎么做',
            value: growth.kindCount('next').toString(),
            sub: '留给下一次',
            tone: scheme.tertiary),
        _StatTile(
            icon: Icons.flag_outlined,
            label: '里程碑',
            value: growth.kindCount('milestone').toString(),
            sub: '鱼生大事',
            tone: scheme.secondary),
        _StatTile(
            icon: Icons.today_outlined,
            label: '今天',
            value: growth.todayCount.toString() +
                '/' +
                growth.dailyLimit.toString(),
            sub: '今天已记',
            tone: scheme.onSurface),
      ];
      if (box.maxWidth < 620) {
        return Wrap(spacing: 10, runSpacing: 10, children: [
          for (final tile in tiles)
            SizedBox(width: (box.maxWidth - 10) / 2, child: tile),
        ]);
      }
      return Row(children: [
        for (var i = 0; i < tiles.length; i++) ...[
          Expanded(child: tiles[i]),
          if (i < tiles.length - 1) const SizedBox(width: 10),
        ],
      ]);
    });
  }
}

class _StatTile extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final String sub;
  final Color tone;
  const _StatTile(
      {required this.icon,
      required this.label,
      required this.value,
      required this.sub,
      required this.tone});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return _Panel(
      padding: const EdgeInsets.all(14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(icon, size: 15, color: tone),
          const SizedBox(width: 6),
          Expanded(
              child: Text(label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                      fontSize: WhaleTokens.fsCaption,
                      color: scheme.onSurfaceVariant))),
        ]),
        const SizedBox(height: 8),
        Text(value,
            style: TextStyle(
                fontSize: WhaleTokens.fsPage,
                fontWeight: FontWeight.w700,
                color: scheme.onSurface,
                fontFeatures: const [FontFeature.tabularFigures()])),
        const SizedBox(height: 2),
        Text(sub,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
                fontSize: WhaleTokens.fsCaption,
                color: scheme.onSurfaceVariant)),
      ]),
    );
  }
}

class _ActivityCard extends StatelessWidget {
  final FishGrowth growth;
  final String selectedDay;
  final ValueChanged<String> onDay;
  const _ActivityCard(
      {required this.growth, required this.selectedDay, required this.onDay});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final first = DateTime.tryParse(growth.firstDay);
    final last = DateTime.tryParse(growth.lastDay);
    final days = <DateTime>[];
    final counts = <String, int>{};
    for (final item in growth.items) {
      counts[item.day] = (counts[item.day] ?? 0) + 1;
    }
    if (first != null && last != null) {
      var start = DateTime(first.year, first.month, first.day);
      final end = DateTime(last.year, last.month, last.day);
      var span = end.difference(start).inDays + 1;
      if (span > 31) {
        start = end.subtract(const Duration(days: 30));
        span = 31;
      }
      for (var i = 0; i < span; i++) {
        days.add(start.add(Duration(days: i)));
      }
    }
    final maxCount = counts.values.fold<int>(1, (m, v) => v > m ? v : m);
    return _Panel(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _PanelHead(
          title: '成长节奏',
          note: days.isEmpty ? '还没有记录' : days.length.toString() + ' 天',
        ),
        const SizedBox(height: 12),
        if (days.isEmpty)
          const SizedBox.shrink()
        else if (days.length < kGrowthMinChartDays)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Text(
              growth.lastDay + ' · ' + growth.total.toString() + ' 条',
              style: TextStyle(
                  fontSize: WhaleTokens.fsSub,
                  color: scheme.onSurface,
                  fontFeatures: const [FontFeature.tabularFigures()]),
            ),
          )
        else
          SizedBox(
            height: 104,
            child: Stack(children: [
              Positioned(
                left: 0,
                right: 0,
                bottom: 18,
                child: Container(
                    height: 1,
                    color: scheme.outlineVariant.withValues(alpha: 0.35)),
              ),
              Positioned(
                left: 0,
                top: 0,
                child: Text('条',
                    style: TextStyle(
                        fontSize: 10, color: scheme.onSurfaceVariant)),
              ),
              Positioned.fill(
                child: LayoutBuilder(builder: (ctx, box) {
                  final n = days.length;
                  final barWidth =
                      ((box.maxWidth - kGrowthBarGap * (n - 1)) / n)
                          .clamp(kGrowthBarMinWidth, kGrowthBarMaxWidth);
                  return Row(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        for (var i = 0; i < n; i++) ...[
                          SizedBox(
                            width: barWidth,
                            child: _Bar(
                              day: _day(days[i]),
                              count: counts[_day(days[i])] ?? 0,
                              maxCount: maxCount,
                              label: i % 2 == 0 ? days[i].day.toString() : '',
                              today: _day(days[i]) == growth.lastDay,
                              selected: selectedDay == _day(days[i]),
                              onTap: () => onDay(_day(days[i])),
                            ),
                          ),
                          if (i < n - 1) const SizedBox(width: kGrowthBarGap),
                        ],
                      ]);
                }),
              ),
            ]),
          ),
      ]),
    );
  }
}

String _day(DateTime d) =>
    d.year.toString().padLeft(4, '0') +
    '-' +
    d.month.toString().padLeft(2, '0') +
    '-' +
    d.day.toString().padLeft(2, '0');

class _Bar extends StatelessWidget {
  final String day;
  final int count;
  final int maxCount;
  final String label;
  final bool today;
  final bool selected;
  final VoidCallback onTap;
  const _Bar({
    required this.day,
    required this.count,
    required this.maxCount,
    required this.label,
    required this.today,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final h = count == 0 ? 2.0 : 6.0 + (count / maxCount) * 70.0;
    return FishTooltip(
      message: day + ' · ' + (count > 0 ? count.toString() + ' 条' : '没有新认识'),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(WhaleTokens.rSm),
        child: Column(mainAxisAlignment: MainAxisAlignment.end, children: [
          SizedBox(
            height: 14,
            child: Text(count > 0 ? count.toString() : '',
                style: TextStyle(
                    fontSize: WhaleTokens.fsCaption,
                    color: scheme.onSurfaceVariant)),
          ),
          const SizedBox(height: 2),
          AnimatedContainer(
            duration: const Duration(milliseconds: 140),
            height: h,
            decoration: BoxDecoration(
              color: count == 0
                  ? scheme.outlineVariant
                      .withValues(alpha: selected ? 0.85 : 0.35)
                  : scheme.primary.withValues(
                      alpha: selected ? 0.95 : (today ? 0.85 : 0.55)),
              borderRadius: BorderRadius.circular(WhaleTokens.rSm),
            ),
          ),
          const SizedBox(height: 4),
          SizedBox(
            height: 14,
            child: Text(label,
                style: TextStyle(
                    fontSize: WhaleTokens.fsCaption,
                    color:
                        selected ? scheme.primary : scheme.onSurfaceVariant)),
          ),
        ]),
      ),
    );
  }
}

class _KnowledgeCard extends StatelessWidget {
  final FishSnapshot data;
  const _KnowledgeCard({required this.data});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final m = data.memory;
    final chars = m.knowledgeChars;
    final size = chars >= 10000
        ? (chars / 10000).toStringAsFixed(1) + ' 万字'
        : chars.toString() + ' 字';
    return _Panel(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const _PanelHead(title: '知识库', note: '记忆的底子'),
        const SizedBox(height: 14),
        Text(m.knowledgeEntries.toString(),
            style: TextStyle(
                fontSize: 28,
                fontWeight: FontWeight.w700,
                color: scheme.onSurface,
                fontFeatures: const [FontFeature.tabularFigures()])),
        Text('条知识 · ' + size,
            style: TextStyle(
                fontSize: WhaleTokens.fsCaption,
                color: scheme.onSurfaceVariant)),
        const SizedBox(height: 14),
        _kv(context, '记忆条目', m.memoriesTotal.toString()),
        _kv(context, '人设', m.personas.length.toString()),
        _kv(
            context,
            '最近更新',
            shortFishTime(m.knowledgeUpdatedAt).isEmpty
                ? '—'
                : shortFishTime(m.knowledgeUpdatedAt)),
        const SizedBox(height: 10),
        Text(m.knowledgeFile.isEmpty ? '还没找到知识库文件' : '知识库文件已接入',
            style: TextStyle(
                fontSize: WhaleTokens.fsCaption,
                color: scheme.onSurfaceVariant)),
      ]),
    );
  }

  Widget _kv(BuildContext context, String k, String v) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(children: [
        Text(k,
            style: TextStyle(
                fontSize: WhaleTokens.fsSmall, color: scheme.onSurfaceVariant)),
        const Spacer(),
        Text(v,
            style: TextStyle(
                fontSize: WhaleTokens.fsSmall,
                color: scheme.onSurface,
                fontWeight: FontWeight.w600)),
      ]),
    );
  }
}

class _LifeCard extends StatelessWidget {
  final FishSnapshot data;
  const _LifeCard({required this.data});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final milestones =
        data.growth.items.where((e) => e.kind == 'milestone').toList();
    return _Panel(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _PanelHead(
            title: '鱼生大事',
            note: milestones.isEmpty
                ? '还没有里程碑'
                : milestones.length.toString() + ' 个节点'),
        const SizedBox(height: 12),
        if (milestones.isEmpty)
          Text('还没有被标成「里程碑」的记录。等它真的遇到大事，这里会留下节点。',
              style: TextStyle(
                  fontSize: WhaleTokens.fsSmall,
                  height: 1.6,
                  color: scheme.onSurfaceVariant))
        else
          Column(children: [
            for (var i = 0; i < milestones.length; i++)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SizedBox(
                          width: 74,
                          child: Text(milestones[i].day,
                              style: TextStyle(
                                  fontSize: WhaleTokens.fsCaption,
                                  color: scheme.onSurfaceVariant))),
                      Container(
                          width: 8,
                          height: 8,
                          margin: const EdgeInsets.only(top: 4, right: 10),
                          decoration: BoxDecoration(
                              color: scheme.secondary, shape: BoxShape.circle)),
                      Expanded(
                          child: Text(milestones[i].text,
                              style: TextStyle(
                                  fontSize: WhaleTokens.fsSmall,
                                  height: 1.5,
                                  color: scheme.onSurface))),
                    ]),
              ),
          ]),
      ]),
    );
  }
}

class _GrowthTimeline extends StatelessWidget {
  final List<FishGrowthEntry> items;
  final String highlightId;
  final String day;
  final VoidCallback onChanged;
  final VoidCallback onClear;
  const _GrowthTimeline(
      {required this.items,
      required this.day,
      this.highlightId = '',
      required this.onChanged,
      required this.onClear});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final shown =
        day.isEmpty ? items : items.where((e) => e.day == day).toList();
    return _Panel(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
              child: _PanelHead(
                  title: day.isEmpty ? '成长节点' : '成长节点 · ' + day,
                  note: shown.length.toString() + ' 条')),
          if (day.isNotEmpty)
            TextButton(onPressed: onClear, child: const Text('看全部')),
        ]),
        const SizedBox(height: 12),
        if (shown.isEmpty)
          Text(day.isEmpty ? '还没有成长记录。它不需要每天都有新判断。' : '那天没有新认识',
              style: TextStyle(
                  fontSize: WhaleTokens.fsSmall,
                  color: scheme.onSurfaceVariant))
        else
          Column(children: [
            for (var i = 0; i < shown.length; i++)
              _TimelineRow(
                  entry: shown[i],
                  last: i == shown.length - 1,
                  highlight: shown[i].id == highlightId,
                  onChanged: onChanged),
          ]),
      ]),
    );
  }
}

class _TimelineRow extends StatelessWidget {
  final FishGrowthEntry entry;
  final bool last;
  final bool highlight;
  final VoidCallback onChanged;
  const _TimelineRow(
      {required this.entry,
      required this.last,
      this.highlight = false,
      required this.onChanged});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final tone = scheme.onSurfaceVariant; // 规则：不用颜色给类别编号
    final body = IntrinsicHeight(
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SizedBox(
            width: 82,
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(entry.day,
                  style: TextStyle(
                      fontSize: WhaleTokens.fsSmall,
                      color: scheme.onSurface,
                      fontWeight: FontWeight.w600)),
              const SizedBox(height: 4),
              Text(entry.kindLabel,
                  style:
                      TextStyle(fontSize: WhaleTokens.fsCaption, color: tone)),
            ])),
        SizedBox(
            width: 18,
            child: Column(children: [
              Container(
                  width: 8,
                  height: 8,
                  decoration:
                      BoxDecoration(color: tone, shape: BoxShape.circle)),
              if (!last)
                Expanded(
                    child: Container(
                        width: 1,
                        color: scheme.outlineVariant.withValues(alpha: 0.5))),
            ])),
        const SizedBox(width: 10),
        Expanded(
            child: Padding(
          padding: const EdgeInsets.only(bottom: 18),
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(entry.text,
                style: TextStyle(
                    fontSize: WhaleTokens.fsSub,
                    height: 1.6,
                    color: scheme.onSurface)),
            if (entry.quote.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text('当时写的是「' + entry.quote + '」',
                  style: TextStyle(
                      fontSize: WhaleTokens.fsSmall,
                      height: 1.5,
                      color: scheme.onSurfaceVariant)),
            ],
            const SizedBox(height: 6),
            Wrap(
                spacing: 10,
                runSpacing: 4,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  if (entry.revision > 1)
                    Text('第 ' + entry.revision.toString() + ' 版',
                        style: TextStyle(
                            fontSize: WhaleTokens.fsCaption,
                            color: scheme.onSurfaceVariant)),
                  if (entry.sourceType.isNotEmpty)
                    Text('来源 ' + _sourceLabel(entry.sourceType),
                        style: TextStyle(
                            fontSize: WhaleTokens.fsCaption,
                            color: scheme.onSurfaceVariant)),
                  if (entry.id.isNotEmpty)
                    _GrowthTools(id: entry.id, onChanged: onChanged),
                ]),
          ]),
        )),
      ]),
    );
    if (!highlight) return body;
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 0),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(10),
        border:
            Border.all(color: scheme.primary.withValues(alpha: .6), width: 2),
      ),
      child: body,
    );
  }
}

String _sourceLabel(String type) {
  switch (type) {
    case 'diary':
      return '日记';
    case 'comment':
      return '批语';
    case 'wish':
      return '请求';
    default:
      return type;
  }
}

class _TraceCard extends StatelessWidget {
  final FishSnapshot data;
  const _TraceCard({required this.data});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final qq = data.qq.activity;
    return _Panel(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const _PanelHead(title: '生活痕迹', note: '成长不是孤立的'),
        const SizedBox(height: 12),
        Wrap(spacing: 10, runSpacing: 10, children: [
          _Trace(
              label: '鱼的日记',
              value: data.diary.total.toString() + ' 篇',
              sub: '待确认 ' + data.diary.pending.toString()),
          _Trace(
              label: '鱼的请求',
              value: data.wishes.total.toString() + ' 条',
              sub: '待回 ' + data.wishes.pending.toString()),
          _Trace(
              label: 'QQ 会话',
              value: qq.total.toString() + ' 条',
              sub: qq.days.toString() + ' 天有记录'),
          _Trace(
              label: '状态快照',
              value: data.status.history.length.toString() + ' 天',
              sub: data.status.day.isEmpty ? '还没记录' : '最近 ' + data.status.day),
        ]),
        const SizedBox(height: 8),
        Text('这些是鱼活着留下的痕迹，不直接等于成长；能连起来看，才知道它变了没有。',
            style: TextStyle(
                fontSize: WhaleTokens.fsCaption,
                color: scheme.onSurfaceVariant)),
      ]),
    );
  }
}

class _Trace extends StatelessWidget {
  final String label;
  final String value;
  final String sub;
  const _Trace({required this.label, required this.value, required this.sub});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SizedBox(
        width: 150,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label,
              style: TextStyle(
                  fontSize: WhaleTokens.fsCaption,
                  color: scheme.onSurfaceVariant)),
          const SizedBox(height: 3),
          Text(value,
              style: TextStyle(
                  fontSize: WhaleTokens.fsSub,
                  fontWeight: FontWeight.w700,
                  color: scheme.onSurface,
                  fontFeatures: const [FontFeature.tabularFigures()])),
          Text(sub,
              style: TextStyle(
                  fontSize: WhaleTokens.fsCaption,
                  color: scheme.onSurfaceVariant)),
        ]));
  }
}

class _PanelHead extends StatelessWidget {
  final String title;
  final String note;
  const _PanelHead({required this.title, required this.note});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Row(children: [
      Text(title,
          style: TextStyle(
              fontSize: WhaleTokens.fsSub,
              fontWeight: FontWeight.w600,
              color: scheme.onSurface)),
      const Spacer(),
      Text(note,
          style: TextStyle(
              fontSize: WhaleTokens.fsCaption, color: scheme.onSurfaceVariant)),
    ]);
  }
}

class _GrowthTools extends StatefulWidget {
  final String id;
  final VoidCallback onChanged;
  const _GrowthTools({required this.id, required this.onChanged});

  @override
  State<_GrowthTools> createState() => _GrowthToolsState();
}

class _GrowthToolsState extends State<_GrowthTools> {
  final _ctl = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _ctl.dispose();
    super.dispose();
  }

  Future<void> _run(
      Future<Map<String, dynamic>?> Function() call, String okText) async {
    if (_busy) return;
    setState(() => _busy = true);
    final r = await call();
    if (!mounted) return;
    setState(() => _busy = false);
    if (r != null && r['ok'] == true) {
      widget.onChanged();
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(
          content: Text(okText), duration: const Duration(seconds: 2)));
    } else {
      final err = r == null ? '没连上主程序' : (r['error'] ?? '未知错误').toString();
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(
          content: Text('没成：' + err),
          backgroundColor: Theme.of(context).colorScheme.errorContainer));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Row(mainAxisSize: MainAxisSize.min, children: [
      SizedBox(
          width: 180,
          child: TextField(
            controller: _ctl,
            style: const TextStyle(fontSize: WhaleTokens.fsCaption),
            decoration: const InputDecoration(
              isDense: true,
              hintText: '改成更准确的说法…',
              border: OutlineInputBorder(),
              contentPadding: EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            ),
          )),
      const SizedBox(width: 6),
      TextButton(
        onPressed: _busy
            ? null
            : () {
                final t = _ctl.text.trim();
                if (t.isEmpty) return;
                _run(() => bridgeFishGrowthRevise(widget.id, t), '已修订（回读校验通过）');
              },
        style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
        child: const Text('修订'),
      ),
      TextButton(
        onPressed: _busy
            ? null
            : () =>
                _run(() => bridgeFishGrowthRetract(widget.id), '已撤回（回读校验通过）'),
        style: TextButton.styleFrom(
            visualDensity: VisualDensity.compact,
            foregroundColor: Theme.of(context).colorScheme.error),
        child: const Text('撤回'),
      ),
    ]);
  }
}

class _TogetherCard extends StatefulWidget {
  final FishSnapshot data;
  const _TogetherCard({required this.data});

  @override
  State<_TogetherCard> createState() => _TogetherCardState();
}

class _TogetherCardState extends State<_TogetherCard> {
  String _day = '';

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final a = widget.data.activity;
    final days = a.perDay.length > 14
        ? a.perDay.sublist(a.perDay.length - 14)
        : a.perDay;
    final maxOwner = days.fold<int>(1, (m, d) => d.owner > m ? d.owner : m);
    final maxFish = days.fold<int>(1, (m, d) => d.fish > m ? d.fish : m);
    final selected = _day.isEmpty ? (days.isEmpty ? '' : days.last.day) : _day;
    final records = a.recent.where((r) => r.day == selected).take(8).toList();
    final diary =
        widget.data.diary.items.where((d) => d.date == selected).toList();
    final memory = widget.data.memory.memories
        .where((m) => m.at.startsWith(selected))
        .toList();
    final wishes =
        widget.data.wishes.items.where((w) => w.day == selected).toList();
    final cross = diary.isNotEmpty
        ? diary.first.text
        : (memory.isNotEmpty
            ? memory.first.text
            : (wishes.isNotEmpty ? wishes.first.text : ''));
    return _Panel(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _PanelHead(title: '我们的往来', note: a.days.toString() + ' 天'),
        const SizedBox(height: 6),
        Text(
            a.total.toString() +
                ' 次往来 · 从 ' +
                (a.firstDay.isEmpty ? '—' : a.firstDay) +
                ' 开始',
            style: TextStyle(
                fontSize: WhaleTokens.fsSmall,
                color: scheme.onSurfaceVariant,
                fontFeatures: const [FontFeature.tabularFigures()])),
        const SizedBox(height: 14),
        SizedBox(
          height: 96,
          child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            for (final d in days) ...[
              Expanded(
                child: Focus(
                  onKeyEvent: (node, e) {
                    if (e is KeyDownEvent &&
                        (e.logicalKey == LogicalKeyboardKey.enter ||
                            e.logicalKey == LogicalKeyboardKey.space)) {
                      setState(() => _day = d.day);
                      return KeyEventResult.handled;
                    }
                    return KeyEventResult.ignored;
                  },
                  child: GestureDetector(
                    onTap: () => setState(() => _day = d.day),
                    child: Column(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          Expanded(
                            child: Row(
                                crossAxisAlignment: CrossAxisAlignment.end,
                                children: [
                                  Expanded(
                                      child: Container(
                                          height: (d.owner / maxOwner * 54)
                                              .clamp(1, 54),
                                          color: scheme.primary
                                              .withValues(alpha: .75))),
                                  const SizedBox(width: 2),
                                  Expanded(
                                      child: Container(
                                          height: (d.fish / maxFish * 54)
                                              .clamp(1, 54),
                                          color: scheme.tertiary
                                              .withValues(alpha: .55))),
                                ]),
                          ),
                          const SizedBox(height: 4),
                          Text(d.day.length >= 10 ? d.day.substring(5) : d.day,
                              style: TextStyle(
                                  fontSize: 8,
                                  color: selected == d.day
                                      ? scheme.primary
                                      : scheme.onSurfaceVariant)),
                        ]),
                  ),
                ),
              ),
              if (d != days.last) const SizedBox(width: 4),
            ],
          ]),
        ),
        const SizedBox(height: 10),
        Text('谁：主人（蓝）· 鱼（青）',
            style: TextStyle(fontSize: 9, color: scheme.onSurfaceVariant)),
        const SizedBox(height: 8),
        Text('第一次戳头像：' + _firstPoke(a),
            style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant)),
        Text('最近一次：' + _daysAgo(selected),
            style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant)),
        Text('戳最多的一天：' + _topDay(a, (r) => r.kind == 'poke'),
            style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant)),
        Text(
            '聊最多的一天：' +
                _topDay(a, (r) => r.kind == 'receive' || r.kind == 'send'),
            style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant)),
        Text('互动最多的一天：' + _busiestDay(a),
            style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant)),
        Text('最长连续互动：' + _longestStreak(a).toString() + ' 天',
            style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant)),
        if (records.isNotEmpty) ...[
          const SizedBox(height: 10),
          for (final r in records)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Row(children: [
                SizedBox(
                    width: 42,
                    child: Text(r.at.length >= 16 ? r.at.substring(11, 16) : '',
                        style: TextStyle(
                            fontSize: 9,
                            color: scheme.onSurfaceVariant,
                            fontFeatures: const [
                              FontFeature.tabularFigures()
                            ]))),
                SizedBox(
                    width: 34,
                    child: Text(
                        r.actor == 'owner'
                            ? '主人'
                            : (r.actor == 'fish' ? '鱼' : '系统'),
                        style: TextStyle(
                            fontSize: 9, color: scheme.onSurfaceVariant))),
                Expanded(
                    child: Text(r.text,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style:
                            TextStyle(fontSize: 10, color: scheme.onSurface))),
              ]),
            ),
        ] else
          Text('这天没有明细。',
              style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant)),
        if (cross.isNotEmpty) ...[
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
            decoration: BoxDecoration(
                color: scheme.primaryContainer.withValues(alpha: .25),
                borderRadius: BorderRadius.circular(6)),
            child: Text('那天她还记了：' + cross,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                    fontSize: 10, height: 1.5, color: scheme.onSurfaceVariant)),
          ),
        ],
      ]),
    );
  }

  String _topDay(FishWorldActivity a, bool Function(FishActivityRecord) hit) {
    final counts = <String, int>{};
    for (final r in a.recent) {
      if (hit(r)) counts[r.day] = (counts[r.day] ?? 0) + 1;
    }
    if (counts.isEmpty) return '—';
    final top = counts.entries.reduce((x, y) => x.value >= y.value ? x : y);
    return top.key + '（' + top.value.toString() + '）';
  }

  String _busiestDay(FishWorldActivity a) {
    if (a.perDay.isEmpty) return '—';
    final top = a.perDay.reduce((x, y) => x.total >= y.total ? x : y);
    return top.day + '（' + top.total.toString() + '）';
  }

  int _longestStreak(FishWorldActivity a) {
    var best = 0, cur = 0;
    DateTime? prev;
    for (final d in a.perDay) {
      final t = DateTime.tryParse(d.day);
      if (t == null) continue;
      if (prev != null && t.difference(prev).inDays == 1) {
        cur++;
      } else {
        cur = 1;
      }
      if (cur > best) best = cur;
      prev = t;
    }
    return best;
  }

  String _firstPoke(FishWorldActivity a) {
    final pokes = a.recent.where((r) => r.kind == 'poke').toList();
    if (pokes.isEmpty) return '还没有';
    final p = pokes.last;
    return p.day + (p.at.length >= 16 ? ' ' + p.at.substring(11, 16) : '');
  }

  String _daysAgo(String day) {
    final t = DateTime.tryParse(day);
    if (t == null) return '—';
    final d = DateTime.now().difference(t).inDays;
    return d <= 0 ? '今天' : d.toString() + ' 天前';
  }
}
