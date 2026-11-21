import 'package:flutter/material.dart';

import '../data/fish_data.dart';
import '../theme/whale_tokens.dart';
import '../fish_nav.dart';
import '../sidebar.dart';
import 'fish_common.dart';
import 'ui_kit/ui_kit.dart';

// ignore_for_file: prefer_interpolation_to_compose_strings

class FishStatusPage extends StatefulWidget {
  const FishStatusPage({super.key});
  @override
  State<FishStatusPage> createState() => _FishStatusPageState();
}

class _FishStatusPageState extends State<FishStatusPage> {
  Future<FishSnapshot> _future = FishWorld.load();
  bool _expanded = false;

  void _reload() {
    setState(() {
      _future = FishWorld.reload();
      _expanded = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return FishPageLayout(
      pageKey: 'status',
      future: _future,
      buildCards: _cards,
      buildLoading: _loadingCards,
      fluid: false,
    );
  }

  Widget _sk(BuildContext context, double h) => Container(
        height: h,
        decoration: BoxDecoration(color: Theme.of(context).colorScheme.outlineVariant.withValues(alpha: .22), borderRadius: BorderRadius.circular(8)),
      );

  List<Widget> _loadingCards(BuildContext context) => [
        FishCard(id: 'status-loading-hero', title: '鱼的状态', width: 1400, height: 240, child: _sk(context, 190)),
        FishCard(
          id: 'status-loading-mood',
          title: '她此刻的心情',
          width: 1400,
          height: 282,
          child: Column(children: [
            _sk(context, 34),
            const SizedBox(height: 10),
            Expanded(child: _sk(context, 200)),
          ]),
        ),
        FishCard(id: 'status-loading-physio', title: '生理状态', width: 300, height: 250, child: _sk(context, 200)),
        FishCard(id: 'status-loading-mind', title: '心理状态', width: 300, height: 250, child: _sk(context, 200)),
      ];

  List<Widget> _cards(BuildContext context, FishSnapshot data) {
    if (!data.ok) {
      return [
        FishCard(
          id: 'status-empty',
          title: '鱼的状态',
          width: 460,
          height: 150,
          child: Text('还没读到鱼的状态。确认桌面端在跑，或先导出快照。',
              style: TextStyle(fontSize: WhaleTokens.fsSub, color: Theme.of(context).colorScheme.onSurfaceVariant)),
        ),
      ];
    }
    final status = data.status;
    final stage = data.growth.stage;
    return [
      FishCard(
        id: 'status-hero',
        title: '鱼的状态',
        note: _dayLabel(status.day),
        width: 1400,
        // ★ 2026-11-21 修头像被裁：原来 height: 240，而头像 size: 230，
        //   卡片内还有上下 padding ⇒ 高度根本不够，头像上半截被裁掉，
        //   右边缘的圆角还切出一条细线。现在给足高度（头像 220 + padding + 余量）。
        height: 280,
        child: _Hero(data: data, stage: stage, onRefresh: _reload),
      ),
      if (data.mood.hasData)
        FishCard(
          id: 'status-mood',
          title: '她此刻的心情',
          note: data.mood.updatedAt > 0 ? _moodTime(data.mood.updatedAt) : '',
          width: 1400,
          height: 282,
          child: _MoodBody(mood: data.mood),
        ),
      FishCard(
        id: 'status-physio',
        title: '生理状态',
        note: '记录活跃度',
        width: 300,
        height: 250,
        child: _PhysioBody(status: status),
      ),
      FishCard(
        id: 'status-mind',
        title: '心理状态',
        note: '成长与记忆',
        width: 300,
        height: 250,
        child: _MindBody(data: data),
      ),
      if (_thoughtOf(data) != null) _thoughtCard(context, data),
      FishCard(
        id: 'status-summary',
        title: '最新摘要',
        note: _dayLabel(status.day),
        width: 1400,
        height: _expanded ? 520 : 300,
        child: _SummaryBody(status: status, expanded: _expanded, onToggle: () => setState(() => _expanded = !_expanded)),
      ),
      FishCard(
        id: 'status-recent',
        title: '最近记录',
        note: status.history.length.toString() + ' 天',
        width: 1400,
        height: 240,
        child: _RecentBody(history: status.history),
      ),
    ];
  }
}

  _Thought? _thoughtOf(FishSnapshot data) {
    final insights = data.growth.items.where((g) => g.kind == 'insight' && g.status != 'retracted').toList()
      ..sort((a, b) => b.at.compareTo(a.at));
    if (insights.isNotEmpty) {
      final g = insights.first;
      return _Thought(text: g.text, source: '成长 · ' + _shortAt(g.at), target: g.id, route: NavRoute.growth);
    }
    final diaries = data.diary.items.where((d) => d.status != 'pending' && d.text.trim().isNotEmpty).toList()
      ..sort((a, b) => b.at.compareTo(a.at));
    if (diaries.isNotEmpty) {
      final d = diaries.first;
      final firstLine = d.text.trim().split(RegExp(r'[。！？\n]')).first.trim();
      return _Thought(text: firstLine.isEmpty ? d.text.trim() : firstLine, source: '日记 · ' + (d.date.isEmpty ? _shortAt(d.at) : d.date.substring(5)), target: d.date.isEmpty ? d.at.substring(0, 10) : d.date, route: NavRoute.diary);
    }
    final wishes = data.wishes.items.where((w) => w.status == 'pending').toList()..sort((a, b) => b.at.compareTo(a.at));
    if (wishes.isNotEmpty) {
      final w = wishes.first;
      return _Thought(text: w.text, source: '请求 · ' + _shortAt(w.at), target: w.id, route: NavRoute.wish);
    }
    return null;
  }

  String _dayLabel(String day) {
    if (day.trim().isEmpty) return '—';
    final now = DateTime.now();
    String two(int n) => n.toString().padLeft(2, '0');
    final today = now.year.toString() + '-' + two(now.month) + '-' + two(now.day);
    return day == today ? '今天' : '最后记录 ' + day;
  }

  String _shortAt(String at) {
    final t = DateTime.tryParse(at);
    if (t == null) return at;
    String two(int n) => n.toString().padLeft(2, '0');
    return two(t.month) + '-' + two(t.day) + ' ' + two(t.hour) + ':' + two(t.minute);
  }

  Widget _thoughtCard(BuildContext context, FishSnapshot data) {
    final thought = _thoughtOf(data)!;
    return FishCard(
      id: 'status-thought',
      title: '鱼的想法',
      note: thought.source,
      width: 300,
      height: 250,
      child: _ThoughtBody(thought: thought),
    );
  }

class _Hero extends StatelessWidget {
  final FishSnapshot data;
  final FishStage stage;
  final VoidCallback onRefresh;
  const _Hero({required this.data, required this.stage, required this.onRefresh});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final status = data.status;
    final line = (status.oneLine.trim().isNotEmpty ? status.oneLine : data.mood.reason).trim();
    return Stack(
      fit: StackFit.expand,
      children: [
        // ★ 2026-11-21 修头像被裁 + 右边缘溢出细线：
        //
        // 原来是 `Positioned(right: 10, bottom: 0, child: FishAvatar(size: 230))`
        // —— 230 高的东西贴死在卡片底边，而卡片只有 height: 300 且里面还有 padding：
        //   · 垂直方向：头像上半截顶出内容区 ⇒ 只露下半张脸（看起来就是"被裁"）
        //   · 水平方向：right: 10 贴着圆角，圆角外的像素被卡片边框切出一条细线
        //
        // 改法：不贴死底部，改成**垂直居中 + 给足右侧留白**，
        // 并把头像缩到能塞进内容区（卡片内容区 ≈ 300 - 上下 padding ≈ 250）。
        // 用 Center 而不是 Positioned，让它跟着卡片高度自适应（展开成 520 时也不会歪）。
        Positioned(
          top: 0,
          bottom: 0,
          right: 14,
          child: Center(
            child: IgnorePointer(
              // 统一用本地头像：不再走 Image.network。
              // Web 上 Image.network 会生成 DOM 平台视图（<flt-platform-view>），
              // 它在部分浏览器/缓存状态下表现为整块白灰板并盖住卡片与头像；
              // 这不是 Flutter 的 BoxDecoration 颜色，grep Colors.white 永远找不到。
              //
              // 220 而不是 230：内容区高度 ≈ 250，留 30 的余量给圆角和边框，
              // 保证任何窗口宽度下都不贴边、不溢出。
              child: FishAvatar(profile: data.profile, size: 220),
            ),
          ),
        ),
        Padding(
          // 右侧留白和头像宽度对齐（220 + 右边距 14 + 间隔 16）
          padding: const EdgeInsets.only(right: 250),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 620),
              child: Text(line.isEmpty ? '今天还没留下状态' : line,
                  maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 22, height: 1.2, fontWeight: FontWeight.w600, color: scheme.onSurface, letterSpacing: -0.2)),
            ),
            const SizedBox(height: 12),
            InkWell(
              borderRadius: BorderRadius.circular(999),
              onTap: () => FishNav.go(NavRoute.growth),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: scheme.primary.withValues(alpha: .10),
                  borderRadius: BorderRadius.circular(999),
                  border: Border.all(color: scheme.primary.withValues(alpha: .25)),
                ),
                child: Text(
                  (stage.name.isEmpty ? '鱼' : stage.name) + ' · 成长 ' + (stage.progress * 100).round().toString() + '%',
                  style: TextStyle(fontSize: 11, color: scheme.primary),
                ),
              ),
            ),
            const Spacer(),
            Row(children: [
              _Mini(label: '今日', value: status.count.toString() + ' 条'),
              const SizedBox(width: 22),
              _Mini(label: '近', value: status.history.length.toString() + ' 天'),
              const SizedBox(width: 22),
              _Mini(label: '状态字数', value: status.chars.toString()),
            ]),
          ]),
        ),
        Positioned(
            top: 0,
            right: 0,
            child: IconButton(onPressed: onRefresh, icon: Icon(Icons.refresh, size: 18, color: scheme.onSurfaceVariant)),
          ),
      ],
    );
  }
}

class _Mini extends StatelessWidget {
  final String label;
  final String value;
  const _Mini({required this.label, required this.value});
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Row(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
      Text(label, style: TextStyle(fontSize: WhaleTokens.fsCaption, color: scheme.onSurfaceVariant)),
      const SizedBox(width: 6),
      Text(value, style: TextStyle(fontSize: WhaleTokens.fsSub, fontWeight: FontWeight.w600, color: scheme.onSurface, fontFeatures: const [FontFeature.tabularFigures()])),
    ]);
  }
}

class _StatBar extends StatelessWidget {
  final String label;
  final double value;
  final String valueText;
  final Color color;
  const _StatBar({required this.label, required this.value, required this.valueText, required this.color});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final dark = Theme.of(context).brightness == Brightness.dark;
    final track = dark ? WhaleTokens.trackDark : scheme.outlineVariant.withValues(alpha: 0.55);
    final v = value.isFinite ? value.clamp(0.0, 1.0) : 0.0;
    return SizedBox(
      height: 30,
      child: Row(children: [
        SizedBox(width: 84, child: Text(label, style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant))),
        Expanded(
          child: ClipRRect(
            borderRadius: BorderRadius.circular(1),
            child: SizedBox(
              height: 2,
              child: Stack(children: [
                Positioned.fill(child: ColoredBox(color: track)),
                FractionallySizedBox(
                  widthFactor: v,
                  alignment: Alignment.centerLeft,
                  child: DecoratedBox(decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(1))),
                ),
              ]),
            ),
          ),
        ),
        const SizedBox(width: 12),
        SizedBox(width: 70, child: Text(valueText, textAlign: TextAlign.right, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: scheme.onSurface, fontFeatures: const [FontFeature.tabularFigures()]))),
      ]),
    );
  }
}

String _moodTime(int ms) {
  if (ms <= 0) return '';
  final t = DateTime.fromMillisecondsSinceEpoch(ms);
  return t.month.toString().padLeft(2, '0') + '-' + t.day.toString().padLeft(2, '0') + ' ' + t.hour.toString().padLeft(2, '0') + ':' + t.minute.toString().padLeft(2, '0');
}

const _moodLabels = <String, String>{
  'happy': '开心', 'calm': '平静', 'sweet': '甜', 'heartache': '心疼',
  'worry': '担心', 'sad': '难过', 'jealous': '吃醋',
};

class _MoodBody extends StatelessWidget {
  final FishMood mood;
  const _MoodBody({required this.mood});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final value = mood.value ?? 0;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        Text(value.toString(),
            style: TextStyle(fontSize: 40, height: 1, fontWeight: FontWeight.w700, color: scheme.primary, fontFeatures: const [FontFeature.tabularFigures()])),
        const SizedBox(width: 8),
        Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: Text('心情', style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant)),
        ),
        const SizedBox(width: 16),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Text(mood.reason.isEmpty ? '—' : mood.reason,
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurface)),
          ),
        ),
      ]),
      const SizedBox(height: 8),
      Row(children: [
        for (final k in _moodLabels.keys)
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(right: 10),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(_moodLabels[k]!, style: TextStyle(fontSize: 9, color: scheme.onSurfaceVariant)),
                const SizedBox(height: 3),
                LayoutBuilder(builder: (_, bc) => ClipRRect(
                  borderRadius: BorderRadius.circular(1),
                  child: Stack(children: [
                    Container(width: bc.maxWidth, height: 6, color: scheme.onSurfaceVariant.withValues(alpha: 0.22)),
                    Container(width: bc.maxWidth * ((mood.dims[k] ?? 0) / 10).clamp(0.0, 1.0), height: 6, color: scheme.primary.withValues(alpha: 0.7)),
                  ]),
                )),
              ]),
            ),
          ),
      ]),
      const SizedBox(height: 8),
      SizedBox(height: 24, child: CustomPaint(painter: _MoodSpark(points: mood.timeline, color: scheme.primary.withValues(alpha: 0.65), fill: scheme.primary.withValues(alpha: 0.04)), size: const Size(double.infinity, 24))),
      const SizedBox(height: 8),
      for (final e in mood.events)
        Padding(
          padding: const EdgeInsets.only(bottom: 3),
          child: Row(children: [
            SizedBox(width: 78, child: Text(_moodTime(e.at), style: TextStyle(fontSize: 9, color: scheme.onSurfaceVariant, fontFeatures: const [FontFeature.tabularFigures()]))),
            SizedBox(width: 30, child: Text((e.delta > 0 ? '+' : '') + e.delta.toString(), style: TextStyle(fontSize: 9, color: e.delta >= 0 ? scheme.primary : scheme.onSurfaceVariant, fontFeatures: const [FontFeature.tabularFigures()]))),
            Expanded(child: Text(e.reason.isEmpty ? '—' : e.reason, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant))),
          ]),
        ),
    ]);
  }
}

class _MoodSpark extends CustomPainter {
  final List<FishMoodPoint> points;
  final Color color;
  final Color fill;
  _MoodSpark({required this.points, required this.color, required this.fill});

  @override
  void paint(Canvas canvas, Size size) {
    if (points.length < 2 || size.width <= 0) return;
    final minV = points.map((p) => p.mood).reduce((a, b) => a < b ? a : b).toDouble();
    final maxV = points.map((p) => p.mood).reduce((a, b) => a > b ? a : b).toDouble();
    final span = (maxV - minV) == 0 ? 1.0 : (maxV - minV);
    double x(int i) => size.width * i / (points.length - 1);
    double y(int v) => size.height - (v - minV) / span * (size.height - 2) - 1;
    final path = Path()..moveTo(x(0), y(points.first.mood));
    for (var i = 1; i < points.length; i++) path.lineTo(x(i), y(points[i].mood));
    final area = Path.from(path)
      ..lineTo(size.width, size.height)
      ..lineTo(0, size.height)
      ..close();
    canvas.drawPath(area, Paint()..color = fill..style = PaintingStyle.fill);
    canvas.drawPath(path, Paint()..color = color..strokeWidth = 1.4..style = PaintingStyle.stroke..strokeCap = StrokeCap.round);
  }

  @override
  bool shouldRepaint(covariant _MoodSpark old) => old.points != points || old.color != color;
}

class _PhysioBody extends StatelessWidget {
  final FishStatus status;
  const _PhysioBody({required this.status});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final maxCount = status.history.fold<int>(1, (m, d) => d.count > m ? d.count : m);
    final fresh = _freshness(status.at);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _StatBar(label: '记录活跃', value: status.count / maxCount, valueText: status.count.toString() + ' 条', color: WhaleTokens.statBlue),
      _StatBar(label: '文字负载', value: status.chars / 2000, valueText: status.chars.toString(), color: WhaleTokens.statPink),
      _StatBar(label: '连续记录', value: status.history.length / 14, valueText: status.history.length.toString() + ' 天', color: WhaleTokens.statAmber),
      _StatBar(label: '更新新鲜', value: fresh, valueText: _ago(status.at), color: WhaleTokens.statBlue),
      const SizedBox(height: 10),
      Text('用记录活跃度代替传感器：没有真实体征时，不编造精力 / 体温分数。',
          maxLines: 2, style: TextStyle(fontSize: 11, height: 1.5, color: scheme.onSurfaceVariant)),
    ]);
  }
}

class _MindBody extends StatelessWidget {
  final FishSnapshot data;
  const _MindBody({required this.data});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final stage = data.growth.stage;
    final memory = data.memory;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _StatBar(label: '成长进度', value: stage.progress, valueText: (stage.progress * 100).round().toString() + '%', color: WhaleTokens.statBlue),
      _StatBar(label: '记忆条目', value: memory.memoriesTotal / 100, valueText: memory.memoriesTotal.toString() + ' 条', color: WhaleTokens.statPink),
      _StatBar(label: '知识库', value: memory.knowledgeEntries / 10000, valueText: memory.knowledgeEntries.toString() + ' 条', color: WhaleTokens.statAmber),
      _StatBar(label: '愿望', value: data.wishes.total / 10, valueText: data.wishes.total.toString() + ' 条', color: WhaleTokens.statBlue),
      const SizedBox(height: 10),
      Text('成长、记忆、知识、愿望都是可核对的量；真实心情见上方「她此刻的心情」。',
          maxLines: 2, style: TextStyle(fontSize: 11, height: 1.5, color: scheme.onSurfaceVariant)),
    ]);
  }
}

class _SummaryBody extends StatelessWidget {
  final FishStatus status;
  final bool expanded;
  final VoidCallback onToggle;
  const _SummaryBody({required this.status, required this.expanded, required this.onToggle});
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final text = status.text.trim();
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Expanded(
        child: text.isEmpty
            ? Text('还没有状态摘要。', style: TextStyle(fontSize: WhaleTokens.fsSub, color: scheme.onSurfaceVariant))
            : SingleChildScrollView(
                child: Text(text, maxLines: expanded ? null : 8, overflow: expanded ? null : TextOverflow.ellipsis,
                    style: TextStyle(fontSize: WhaleTokens.fsSub, height: 1.65, color: scheme.onSurface))),
      ),
      if (text.length > 420)
        Align(
          alignment: Alignment.centerRight,
          child: TextButton(onPressed: onToggle, child: Text(expanded ? '收起' : '展开全文',
              style: TextStyle(fontSize: WhaleTokens.fsCaption, color: scheme.onSurfaceVariant))),
        ),
    ]);
  }
}

class _RecentBody extends StatelessWidget {
  final List<FishDayCount> history;
  const _RecentBody({required this.history});
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final dark = Theme.of(context).brightness == Brightness.dark;
    final track = dark ? WhaleTokens.trackDark : scheme.outlineVariant.withValues(alpha: 0.55);
    if (history.isEmpty) {
      return Text('还没有历史记录。', style: TextStyle(fontSize: WhaleTokens.fsSub, color: scheme.onSurfaceVariant));
    }
    final maxCount = history.fold<int>(1, (m, d) => d.count > m ? d.count : m);
    return Column(children: [
      for (final d in history.take(5))
        SizedBox(height: 30, child: Row(children: [
          SizedBox(width: 82, child: Text(d.day.isEmpty ? '—' : d.day, style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant))),
          Expanded(child: ClipRRect(borderRadius: BorderRadius.circular(1), child: SizedBox(height: 2, child: Stack(children: [
            Positioned.fill(child: ColoredBox(color: track)),
            FractionallySizedBox(widthFactor: (d.count / maxCount).clamp(0.02, 1.0), alignment: Alignment.centerLeft,
                child: const DecoratedBox(decoration: BoxDecoration(color: WhaleTokens.statBlue, borderRadius: BorderRadius.all(Radius.circular(1))))),
          ])))),
          const SizedBox(width: 12),
          SizedBox(width: 42, child: Text(d.count.toString(), textAlign: TextAlign.right,
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: scheme.onSurface, fontFeatures: const [FontFeature.tabularFigures()]))),
        ])),
    ]);
  }
}

double _freshness(String at) {
  try {
    final t = DateTime.parse(at);
    final hours = DateTime.now().difference(t).inMinutes / 60;
    return (1 - hours / 48).clamp(0.0, 1.0);
  } catch (_) {
    return 0;
  }
}

String _ago(String at) {
  try {
    final t = DateTime.parse(at);
    final d = DateTime.now().difference(t);
    if (d.inMinutes < 60) return d.inMinutes.toString() + ' 分钟前';
    if (d.inHours < 24) return d.inHours.toString() + ' 小时前';
    return d.inDays.toString() + ' 天前';
  } catch (_) {
    return '—';
  }
}

class _Thought {
  final String text;
  final String source;
  final String target;
  final NavRoute route;
  const _Thought({required this.text, required this.source, required this.target, required this.route});
}

class _ThoughtBody extends StatelessWidget {
  final _Thought thought;
  const _ThoughtBody({required this.thought});
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
      decoration: BoxDecoration(color: scheme.onSurface.withValues(alpha: .05), borderRadius: BorderRadius.circular(12)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Expanded(
          child: FishTooltip(
            message: thought.text,
            child: Text(thought.text, maxLines: 6, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: WhaleTokens.fsSub, height: 1.7, color: scheme.onSurface)),
          ),
        ),
        Align(
          alignment: Alignment.centerRight,
          child: TextButton(
            style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 6), minimumSize: Size.zero, tapTargetSize: MaterialTapTargetSize.shrinkWrap),
            onPressed: () => FishNav.go(thought.route, target: thought.target),
            child: Text('看全文 ›', style: TextStyle(fontSize: WhaleTokens.fsCaption, color: scheme.primary)),
          ),
        ),
      ]),
    );
  }
}
