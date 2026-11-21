import 'package:flutter/material.dart';

import '../bento.dart';
import '../data/fish_data.dart';
import '../theme/whale_tokens.dart';
import '../fish_tooltip.dart';
import 'fish_common.dart';

// ignore_for_file: prefer_interpolation_to_compose_strings

class FishOverviewPage extends StatefulWidget {
  const FishOverviewPage({super.key});
  @override
  State<FishOverviewPage> createState() => _FishOverviewPageState();
}

class _FishOverviewPageState extends State<FishOverviewPage> {
  final Future<FishSnapshot> _future = FishWorld.load();

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<FishSnapshot>(
      future: _future,
      builder: (ctx, snap) {
        if (snap.connectionState != ConnectionState.done) return _skeleton(context);
        if (snap.hasError) return _empty(context, '读取失败：' + snap.error.toString());
        final data = snap.data ?? FishSnapshot.empty();
        if (!data.ok) {
          final err = FishWorld.lastError;
          return _empty(context, err.isEmpty ? '鱼的世界还没有数据。绑定工作区后才会出现总览。' : '读取失败：' + err);
        }
        return _body(context, data);
      },
    );
  }

  Widget _body(BuildContext context, FishSnapshot data) {
    final o = data.overview;
    final scheme = Theme.of(context).colorScheme;
    final qq = data.qq;
    final bili = data.bili;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(WhaleTokens.gap, WhaleTokens.gap, WhaleTokens.gap, 104),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 1220),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            BentoBoard(
            boardId: 'overview-dashboard-20261110',
            fluid: true,
            items: [
              BentoItem(
                id: 'ov-stage',
                width: 1400,
                height: 210,
                child: BentoPanel(
                  title: '鱼的世界',
                  note: o.stage.name.isEmpty ? '还没读到阶段' : o.stage.name,
                  child: Row(children: [
                    Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
                      Text(o.stage.name.isEmpty ? '鱼的世界' : o.stage.name,
                          style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700, color: scheme.primary)),
                      const SizedBox(height: 6),
                      Text(o.stage.desc.isEmpty ? '今天也在慢慢记事。' : o.stage.desc,
                          maxLines: 2, overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: WhaleTokens.fsBody, height: 1.55, color: scheme.onSurface)),
                    ])),
                    _HeroMeta(label: '今天日记', value: o.diaryToday.toString() + ' 篇'),
                    const SizedBox(width: 24),
                    _HeroMeta(label: '待确认', value: o.diaryPending.toString() + ' 篇'),
                    const SizedBox(width: 24),
                    _HeroMeta(label: '成长', value: o.growthTotal.toString() + ' 条'),
                    const SizedBox(width: 20),
                    FishAvatar(profile: data.profile, size: 170),
                  ]),
                ),
              ),
              BentoItem(
                id: 'ov-diary',
                width: 340,
                height: 140,
                child: BentoPanel(
                  title: '鱼的日记',
                  note: '待确认 ' + o.diaryPending.toString(),
                  child: _BigNumber(value: o.diaryTotal.toString(), sub: '今天写了 ' + o.diaryToday.toString() + ' 篇'),
                ),
              ),
              BentoItem(
                id: 'ov-wishes',
                width: 340,
                height: 140,
                child: BentoPanel(
                  title: '鱼的请求',
                  note: '共 ' + o.wishesTotal.toString() + ' 条',
                  child: _BigNumber(value: o.wishesPending.toString(), sub: o.wishesPending > 0 ? '条等你回' : '现在没有待处理'),
                ),
              ),
              BentoItem(
                id: 'ov-growth',
                width: 340,
                height: 140,
                child: BentoPanel(
                  title: '鱼的成长',
                  note: o.stage.name.isEmpty ? '条记录' : o.stage.name,
                  child: _BigNumber(value: o.growthTotal.toString(), sub: '条成长记录'),
                ),
              ),
              BentoItem(
                id: 'ov-memory',
                width: 340,
                height: 140,
                child: Builder(builder: (_) {
                  final mem = data.memory.memories.where((m) => m.domain != 'ledger').length;
                  final ledger = data.memory.memories.where((m) => m.domain == 'ledger').length;
                  return BentoPanel(
                    title: '鱼的记忆',
                    note: '知识库 ' + o.memoryKnowledge.toString() + ' 条',
                    child: _BigNumber(value: mem.toString(), sub: '条记忆' + (ledger > 0 ? ' · 工作账 ' + ledger.toString() + ' 条' : '') + ' · 知识库 ' + o.memoryKnowledge.toString() + ' 条'),
                  );
                }),
              ),
              BentoItem(
                id: 'ov-platform',
                width: 700,
                height: 160,
                child: BentoPanel(
                  title: '鱼与世界',
                  note: ((qq.enabled ? 1 : 0) + (bili.enabled ? 1 : 0)).toString() + ' / 2 个平台已启用',
                  child: Row(children: [
                    Expanded(child: _PlatformLine(label: 'QQ', value: qq.statusLabel, sub: '能力 ' + qq.enabledCount.toString() + ' / ' + qq.fieldsTotal.toString())),
                    const SizedBox(width: 14),
                    Expanded(child: _PlatformLine(label: 'B站', value: bili.statusLabel, sub: '能力 ' + bili.enabledCount.toString() + ' / ' + bili.fieldsTotal.toString())),
                  ]),
                ),
              ),
              BentoItem(
                id: 'ov-source',
                width: 700,
                height: 160,
                child: BentoPanel(
                  title: '数据来源',
                  note: data.errors.isEmpty ? '读取正常' : '失败 ' + data.errors.length.toString() + ' 项',
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(shortFishTime(data.generatedAt).isEmpty ? '—' : shortFishTime(data.generatedAt),
                        style: TextStyle(fontSize: WhaleTokens.fsPage, fontWeight: FontWeight.w700, color: data.errors.isEmpty ? scheme.onSurface : scheme.error, fontFeatures: const [FontFeature.tabularFigures()])),
                    const SizedBox(height: 4),
                    Text('根目录 ' + data.roots.length.toString() + ' 个', style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurfaceVariant)),
                    if (data.errors.isNotEmpty) ...[
                      const SizedBox(height: 4),
                      Text(data.errors.first, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: WhaleTokens.fsCaption, color: scheme.error)),
                    ],
                  ]),
                ),
              ),
              BentoItem(
                id: 'ov-recent',
                width: 1400,
                height: 170,
                child: BentoPanel(
                  title: '最近状态',
                  note: data.status.history.length.toString() + ' 天',
                  child: _RecentBars(history: data.status.history),
                ),
              ),
            ],
          ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _skeleton(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    Widget block(double h) => Container(height: h, decoration: BoxDecoration(color: scheme.surfaceContainerHighest.withValues(alpha: 0.35), borderRadius: BorderRadius.circular(WhaleTokens.rLg)));
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(WhaleTokens.gap, WhaleTokens.gap, WhaleTokens.gap, 104),
      child: Column(children: [
        block(170),
        const SizedBox(height: 12),
        Row(children: [
          Expanded(child: block(140)), const SizedBox(width: 12),
          Expanded(child: block(140)),
        ]),
        const SizedBox(height: 12),
        Row(children: [
          Expanded(child: block(160)), const SizedBox(width: 12),
          Expanded(child: block(160)),
        ]),
      ]),
    );
  }

  Widget _empty(BuildContext context, String text) {
    final scheme = Theme.of(context).colorScheme;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(WhaleTokens.gap, WhaleTokens.gap, WhaleTokens.gap, 104),
      child: Container(
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(color: scheme.surfaceContainerHighest.withValues(alpha: 0.4), borderRadius: BorderRadius.circular(WhaleTokens.rLg)),
        child: Text(text, style: TextStyle(fontSize: WhaleTokens.fsSub, height: 1.6, color: scheme.onSurfaceVariant)),
      ),
    );
  }
}

class _HeroMeta extends StatelessWidget {
  final String label;
  final String value;
  const _HeroMeta({required this.label, required this.value});
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Column(crossAxisAlignment: CrossAxisAlignment.end, mainAxisAlignment: MainAxisAlignment.center, children: [
      Text(label, style: TextStyle(fontSize: WhaleTokens.fsCaption, color: scheme.onSurfaceVariant)),
      const SizedBox(height: 3),
      Text(value, style: TextStyle(fontSize: WhaleTokens.fsSub, fontWeight: FontWeight.w600, color: scheme.onSurface, fontFeatures: const [FontFeature.tabularFigures()])),
    ]);
  }
}

class _BigNumber extends StatelessWidget {
  final String value;
  final String sub;
  const _BigNumber({required this.value, required this.sub});
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
      Text(value, style: TextStyle(fontSize: 30, fontWeight: FontWeight.w700, color: scheme.onSurface, fontFeatures: const [FontFeature.tabularFigures()])),
      const SizedBox(height: 2),
      Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurfaceVariant)),
    ]);
  }
}

class _PlatformLine extends StatelessWidget {
  final String label;
  final String value;
  final String sub;
  const _PlatformLine({required this.label, required this.value, required this.sub});
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(color: scheme.surface.withValues(alpha: 0.35), borderRadius: BorderRadius.circular(WhaleTokens.rMd)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
        Text(label, style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurfaceVariant)),
        const SizedBox(height: 2),
        Text(value, style: TextStyle(fontSize: WhaleTokens.fsSub, fontWeight: FontWeight.w600, color: scheme.onSurface)),
        Text(sub, style: TextStyle(fontSize: WhaleTokens.fsCaption, color: scheme.onSurfaceVariant)),
      ]),
    );
  }
}

class _RecentBars extends StatelessWidget {
  final List<FishDayCount> history;
  const _RecentBars({required this.history});
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    if (history.isEmpty) {
      return Text('还没有状态历史。', style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurfaceVariant));
    }
    final maxCount = history.fold<int>(1, (m, d) => d.count > m ? d.count : m);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Expanded(child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        for (final d in history.take(14)) ...[
          Expanded(child: FishTooltip(
            message: d.day + ' · ' + d.count.toString() + ' 条',
            child: Container(
              height: 20 + (d.count / maxCount) * 70,
              decoration: BoxDecoration(color: scheme.primary.withValues(alpha: 0.55), borderRadius: BorderRadius.circular(WhaleTokens.rSm)),
            ),
          )),
          const SizedBox(width: 6),
        ],
      ])),
      const SizedBox(height: 6),
      Text(history.first.day + ' → ' + history.last.day, style: TextStyle(fontSize: WhaleTokens.fsCaption, color: scheme.onSurfaceVariant)),
    ]);
  }
}
