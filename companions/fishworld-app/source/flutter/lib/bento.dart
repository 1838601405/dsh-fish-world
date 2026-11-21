import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'dart:convert';
import 'theme/whale_tokens.dart';
import 'fish/ui_kit/ui_kit.dart';
import 'fish_tooltip.dart';
import 'data/local_store.dart';

/// 便当盒卡片：右下角折角可拖拽改大小、左上角手柄拖动换位。
/// 两个手柄都只在鼠标进入卡片时显示（照鱼的世界插件）。
class _Store {
  static final Map<String, Size> sizes = {};
  static bool _loaded = false;

  static void ensure() {
    if (_loaded) return;
    _loaded = true;
    final raw = readLocal('wg_bento_sizes');
    if (raw == null || raw.isEmpty) return;
    try {
      final m = jsonDecode(raw);
      if (m is Map) {
        m.forEach((k, v) {
          if (v is List && v.length == 2) {
            sizes[k.toString()] = Size((v[0] as num).toDouble(), (v[1] as num).toDouble());
          }
        });
      }
    } catch (e) { /* 忽略 */ }
  }

  static void persist() {
    try {
      final out = <String, List<double>>{};
      sizes.forEach((k, v) => out[k] = [v.width, v.height]);
      writeLocal('wg_bento_sizes', jsonEncode(out));
    } catch (e) { /* 忽略 */ }
  }
}

/// 相邻边吸附：每张卡把全局矩形登记进来，缩放时找最近邻边（阈值 8px）。
const double kCardScreenGutter = 32.0;
const double kCardWidthGutter = 40.0;
const double kCardMaxHeight = 900.0; // 一屏高减顶栏与页脚
const double kCardResizeStep = 16.0;

class _SnapRegistry {
  static final Map<String, Rect> rects = {};
  static const double threshold = 8;
}

class SizedBentoCard extends StatefulWidget {
  final String id;
  final double defaultWidth;
  final double defaultHeight;
  final double minWidth;
  final double minHeight;
  /// 内容区实际宽度；设了之后卡片不会超过它，避免 Wrap 把第二列顶出可视区。
  final double? maxWidth;
  final double maxHeight;
  final bool resizable;
  /// 鱼页流式布局：不再按屏幕系数放大，宽度由 BentoBoard 直接算成半宽/通栏。
  final bool scaleWithScreen;
  final Widget child;
  const SizedBentoCard({
    super.key,
    required this.id,
    required this.defaultWidth,
    required this.defaultHeight,
    required this.child,
    this.minWidth = 160,
    this.minHeight = 96,
    this.maxWidth,
    this.maxHeight = kCardMaxHeight,
    this.resizable = true,
    this.scaleWithScreen = true,
  });

  @override
  State<SizedBentoCard> createState() => _SizedBentoCardState();
}

class _SizedBentoCardState extends State<SizedBentoCard> {
  bool _hover = false;
  bool _focus = false;
  bool _limitHit = false;

  Size get _size {
    _Store.ensure();
    final saved = _Store.sizes[widget.id];
    // 流式布局的宽度每次由容器算（半宽/通栏），不能吃拖拽时存下的旧像素宽。
    if (!widget.scaleWithScreen) {
      return Size(widget.defaultWidth, saved?.height ?? widget.defaultHeight);
    }
    return saved ?? Size(widget.defaultWidth, widget.defaultHeight);
  }

  void _apply(Size ns, {bool persist = true}) {
    _Store.ensure();
    final maxW = widget.maxWidth ?? (MediaQuery.of(context).size.width - kCardScreenGutter);
    final width = widget.scaleWithScreen
        ? ns.width.clamp(widget.minWidth, maxW)
        : widget.defaultWidth;
    final h = ns.height.clamp(widget.minHeight, widget.maxHeight);
    setState(() {
      _Store.sizes[widget.id] = Size(width, h);
      _limitHit = ns.height >= widget.maxHeight;
    });
    if (persist) _Store.persist();
  }

  Rect? _globalRect() {
    final ro = context.findRenderObject();
    if (ro is! RenderBox || !ro.hasSize) return null;
    return ro.localToGlobal(Offset.zero) & ro.size;
  }

  /// 缩放时吸附相邻卡的边：右缘贴别人的左/右缘，下缘贴别人的上/下缘。
  Size _snap(Size ns) {
    final me = _globalRect();
    if (me == null) return ns;
    var w = ns.width;
    var h = ns.height;
    final right = me.left + w;
    final bottom = me.top + h;
    double bestDx = 0;
    double bestDy = 0;
    var hasDx = false;
    var hasDy = false;
    for (final e in _SnapRegistry.rects.entries) {
      if (e.key == widget.id) continue;
      final r = e.value;
      for (final edge in [r.left, r.right]) {
        final d = edge - right;
        if (d.abs() <= _SnapRegistry.threshold && (!hasDx || d.abs() < bestDx.abs())) {
          bestDx = d;
          hasDx = true;
        }
      }
      for (final edge in [r.top, r.bottom]) {
        final d = edge - bottom;
        if (d.abs() <= _SnapRegistry.threshold && (!hasDy || d.abs() < bestDy.abs())) {
          bestDy = d;
          hasDy = true;
        }
      }
    }
    if (hasDx) w += bestDx;
    if (hasDy) h += bestDy;
    return Size(w, h);
  }

  void _resize(Offset d) {
    final s = _size;
    _apply(_snap(Size(s.width + d.dx, s.height + d.dy)), persist: false);
  }

  void _finishResize() => _Store.persist();

  void _reset() {
    _Store.ensure();
    setState(() {
      _Store.sizes.remove(widget.id);
      _limitHit = false;
    });
    _Store.persist();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final raw = _size;
    final screenW = MediaQuery.of(context).size.width;
    // 屏宽系数：桌面放大一点，手机收成一列（不溢出）
    final k = widget.scaleWithScreen
        ? (screenW >= 1500 ? 1.28 : (screenW >= 1100 ? 1.12 : 1.0))
        : 1.0;
    final maxScreen = screenW - kCardScreenGutter;
    final maxAllowed = widget.maxWidth ?? maxScreen;
    var w = raw.width * k;
    var h = raw.height * k;
    if (w > maxAllowed) w = maxAllowed;
    if (h > widget.maxHeight) h = widget.maxHeight;
    final size = Size(w, h);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final r = _globalRect();
      if (r != null) _SnapRegistry.rects[widget.id] = r;
    });
    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: SizedBox(
        width: size.width,
        height: size.height,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          curve: Curves.easeOut,
          transform: Matrix4.translationValues(0, _hover ? -2 : 0, 0),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(WhaleTokens.rLg),
            border: _limitHit ? Border.all(color: scheme.primary, width: 2) : null,
            boxShadow: _hover
                ? [BoxShadow(color: Colors.black.withValues(alpha: 0.22), blurRadius: 18, offset: const Offset(0, 8))]
                : const [],
          ),
          child: Stack(children: [
          Positioned.fill(child: widget.child),
          if (widget.resizable) Positioned(
            right: 0,
            bottom: 0,
            child: IgnorePointer(
              ignoring: !_hover,
              child: AnimatedOpacity(
                opacity: _hover ? 1 : 0,
                duration: const Duration(milliseconds: 120),
                child: Focus(
                  onFocusChange: (f) => setState(() => _focus = f),
                  onKeyEvent: (node, ev) {
                    if (!HardwareKeyboard.instance.isAltPressed) return KeyEventResult.ignored;
                    final k = ev.logicalKey;
                    double dw = 0, dh = 0;
                    if (k == LogicalKeyboardKey.arrowLeft) dw = -16;
                    if (k == LogicalKeyboardKey.arrowRight) dw = 16;
                    if (k == LogicalKeyboardKey.arrowUp) dh = -16;
                    if (k == LogicalKeyboardKey.arrowDown) dh = 16;
                    if (dw == 0 && dh == 0) return KeyEventResult.ignored;
                    final s = _size;
                    _apply(Size(s.width + dw, s.height + dh));
                    return KeyEventResult.handled;
                  },
                  child: FishTooltip(
                    message: '拖动调整大小 · 双击恢复默认 · Alt+方向键微调',
                    child: GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onPanUpdate: (e) => _resize(e.delta),
                      onPanEnd: (_) => _finishResize(),
                      onDoubleTap: _reset,
                      child: Container(
                        width: 22,
                        height: 22,
                        alignment: Alignment.center,
                        decoration: _focus
                            ? BoxDecoration(
                                border: Border.all(color: scheme.primary, width: 2),
                                borderRadius: BorderRadius.circular(4),
                              )
                            : null,
                        child: CustomPaint(
                          size: const Size(12, 12),
                          painter: CornerPainter(scheme.onSurfaceVariant.withValues(alpha: 0.55)),
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
    );
  }
}
class _FourDotPainter extends CustomPainter {
  final Color color;
  const _FourDotPainter({required this.color});

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()..color = color;
    const gap = 4.2;
    final startX = (size.width - gap) / 2;
    final startY = (size.height - gap) / 2;
    for (var x = 0; x < 2; x++) {
      for (var y = 0; y < 2; y++) {
        canvas.drawCircle(Offset(startX + x * gap, startY + y * gap), 1.25, paint);
      }
    }
  }

  @override
  bool shouldRepaint(covariant _FourDotPainter oldDelegate) => oldDelegate.color != color;
}

/// 右下角「折角」标记（照鱼的世界插件）
class CornerPainter extends CustomPainter {
  final Color color;
  CornerPainter(this.color);

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.6
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    final w = size.width;
    final h = size.height;
    final path = Path()
      ..moveTo(w, h * 0.28)
      ..lineTo(w, h - 2)
      ..quadraticBezierTo(w, h, w - 2, h)
      ..lineTo(w * 0.28, h);
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(covariant CornerPainter old) => old.color != color;
}

/// 一张便当盒卡的最小描述（给 BentoBoard 排序用）
class BentoItem {
  final String id;
  final double width;
  final double height;
  final double maxHeight;
  final bool resizable;
  final Widget child;
  const BentoItem({required this.id, required this.width, required this.height, this.maxHeight = kCardMaxHeight, this.resizable = true, required this.child});
}

class _OrderStore {
  static final Map<String, List<int>> order = {};
  static bool _loaded = false;

  static void ensure(String boardId) {
    if (_loaded) return;
    _loaded = true;
    final raw = readLocal('wg_bento_order');
    if (raw == null || raw.isEmpty) return;
    try {
      final m = jsonDecode(raw);
      if (m is Map) {
        m.forEach((k, v) {
          if (v is List) order[k.toString()] = v.map((e) => (e as num).toInt()).toList();
        });
      }
    } catch (e) { /* 忽略 */ }
  }

  static void persist() {
    try { writeLocal('wg_bento_order', jsonEncode(order)); } catch (e) { /* 忽略 */ }
  }
}

/// 便当盒看板：左上角手柄拖动换位置，Alt+方向键也能挪；尺寸由右下角折角拖。
class BentoBoard extends StatefulWidget {
  final String boardId;
  final List<BentoItem> items;
  /// 鱼页默认布局：窄卡均分两列，宽卡通栏。
  final bool fluid;
  const BentoBoard({super.key, required this.boardId, required this.items, this.fluid = false});

  @override
  State<BentoBoard> createState() => _BentoBoardState();
}

class _BentoBoardState extends State<BentoBoard> {
  late List<int> _order = _openOrder();
  int? _dragFrom;

  List<int> _openOrder() {
    _OrderStore.ensure(widget.boardId);
    return _OrderStore.order[widget.boardId] ?? List<int>.generate(widget.items.length, (i) => i);
  }

  void _commit(List<int> next) {
    setState(() {
      _order = next;
      _OrderStore.order[widget.boardId] = List<int>.from(next);
    });
    _OrderStore.persist();
  }

  void _swap(int a, int b) {
    if (a < 0 || b < 0 || a >= _order.length || b >= _order.length) return;
    final next = List<int>.from(_order);
    final t = next[a];
    next[a] = next[b];
    next[b] = t;
    _commit(next);
  }

  void _move(int idx, int delta) => _swap(idx, idx + delta);

  void _dragStart(int pos) {
    _dragFrom = pos;
  }

  void _dragHover(int target) {
    final from = _dragFrom;
    if (from == null || from == target) return;
    if (from < 0 || from >= _order.length || target < 0 || target >= _order.length) return;
    final next = List<int>.from(_order);
    final moved = next.removeAt(from);
    next.insert(target, moved);
    setState(() {
      _order = next;
      _OrderStore.order[widget.boardId] = List<int>.from(next);
      _dragFrom = target;
    });
  }

  void _dragEnd() {
    _dragFrom = null;
    _OrderStore.persist();
  }

  @override
  Widget build(BuildContext context) {
    if (_order.length != widget.items.length) {
      _order = List<int>.generate(widget.items.length, (i) => i);
    }
    return LayoutBuilder(builder: (_, box) {
      final maxW = box.maxWidth;
      final phone = maxW < 620;
      final gaps = phone ? 8.0 : 12.0;
      return Wrap(spacing: gaps, runSpacing: gaps, children: [
        for (var pos = 0; pos < _order.length; pos++)
          Builder(builder: (_) {
            final it = widget.items[_order[pos]];
            final wideCut = maxW * 0.66;
            final w = phone
                ? maxW
                : (widget.fluid
                    ? (it.width >= wideCut ? maxW : (maxW - gaps) / 2)
                    : (it.width > maxW ? maxW : it.width));
            return _BentoSlot(
              key: ValueKey('slot-${it.id}'),
              pos: pos,
              item: it,
              card: SizedBentoCard(
                id: '${widget.boardId}-${it.id}',
                defaultWidth: w,
                defaultHeight: it.height,
                maxWidth: maxW,
                maxHeight: it.maxHeight,
                resizable: it.resizable,
                // 非流式（三列固定网格）不读拖拽存下的旧像素宽，否则会被历史半宽尺寸带偏。
                scaleWithScreen: false,
                child: it.child,
              ),
              onSwap: _swap,
              onMove: _move,
              onDragStart: _dragStart,
              onDragHover: _dragHover,
              onDragEnd: _dragEnd,
            );
          }),
      ]);
    });
  }
}

class _BentoSlot extends StatefulWidget {
  final int pos;
  final BentoItem item;
  final Widget card;
  final void Function(int, int) onSwap;
  final void Function(int, int) onMove;
  final ValueChanged<int> onDragStart;
  final ValueChanged<int> onDragHover;
  final VoidCallback onDragEnd;
  const _BentoSlot({
    super.key,
    required this.pos,
    required this.item,
    required this.card,
    required this.onSwap,
    required this.onMove,
    required this.onDragStart,
    required this.onDragHover,
    required this.onDragEnd,
  });

  @override
  State<_BentoSlot> createState() => _BentoSlotState();
}

class _BentoSlotState extends State<_BentoSlot> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final handle = MouseRegion(
      cursor: SystemMouseCursors.grab,
      child: Semantics(
        label: '按住拖动调整位置 · Alt+方向键移动',
        child: Draggable<int>(
          data: widget.pos,
          onDragStarted: () => widget.onDragStart(widget.pos),
          onDragEnd: (_) => widget.onDragEnd(),
          feedback: Material(
            color: Colors.transparent,
            child: SizedBox(width: widget.item.width, height: widget.item.height, child: Opacity(opacity: 0.85, child: widget.item.child)),
          ),
          childWhenDragging: SizedBox(width: widget.item.width, height: widget.item.height, child: Opacity(opacity: 0.25, child: widget.item.child)),
          child: Container(
            width: 18,
            height: 18,
            alignment: Alignment.center,
            child: SizedBox(
              width: 13,
              height: 13,
              child: CustomPaint(painter: _FourDotPainter(color: scheme.onSurfaceVariant.withValues(alpha: 0.55))),
            ),
          ),
        ),
      ),
    );
    return DragTarget<int>(
      onWillAcceptWithDetails: (d) {
        if (d.data != widget.pos) widget.onDragHover(widget.pos);
        return true;
      },
      onAcceptWithDetails: (_) {},
      builder: (ctx, cand, rej) {
        final hot = cand.isNotEmpty;
        return Focus(
          onKeyEvent: (node, ev) {
            if (!HardwareKeyboard.instance.isAltPressed) return KeyEventResult.ignored;
            final k = ev.logicalKey;
            if (k == LogicalKeyboardKey.arrowLeft || k == LogicalKeyboardKey.arrowUp) { widget.onMove(widget.pos, -1); return KeyEventResult.handled; }
            if (k == LogicalKeyboardKey.arrowRight || k == LogicalKeyboardKey.arrowDown) { widget.onMove(widget.pos, 1); return KeyEventResult.handled; }
            return KeyEventResult.ignored;
          },
          child: MouseRegion(
            onEnter: (_) => setState(() => _hover = true),
            onExit: (_) => setState(() => _hover = false),
            child: Stack(clipBehavior: Clip.none, children: [
              Container(
                decoration: hot
                    ? BoxDecoration(border: Border.all(color: scheme.primary, width: 2), borderRadius: BorderRadius.circular(WhaleTokens.rLg))
                    : null,
                child: widget.card,
              ),
              Positioned(
                left: 2,
                top: 2,
                child: IgnorePointer(
                  ignoring: !_hover,
                  child: AnimatedOpacity(
                    opacity: _hover ? 1 : 0,
                    duration: const Duration(milliseconds: 120),
                    child: handle,
                  ),
                ),
              ),
            ]),
          ),
        );
      },
    );
  }
}

Widget bentoWrap(List<Widget> cards) => Wrap(spacing: 12, runSpacing: 12, children: cards);

/// 鱼的世界统一卡片底座：底色 / 圆角 / 白边 / hover 阴影。
BoxDecoration bentoCardDecoration(BuildContext context, {bool hover = false, bool selected = false}) {
  final scheme = Theme.of(context).colorScheme;
  final dark = Theme.of(context).brightness == Brightness.dark;
  return BoxDecoration(
    color: scheme.surface, // 不透明底：对比度靠 surface + 1px 边框 + 阴影，不靠半透明
    borderRadius: BorderRadius.circular(WhaleTokens.rLg),
    border: Border.all(
      // 浅色卡片对白卡需要一条看得见的边界：用 outline（#B3BDCA），
      // 不用 outlineVariant（#D7DFEA，白卡上几乎消失）。深色保持 5% 白边。
      color: selected ? scheme.primary : (dark ? Colors.white.withValues(alpha: 0.05) : scheme.outline),
      width: selected ? 1.4 : 1,
    ),
    boxShadow: hover
        ? [BoxShadow(color: Colors.black.withValues(alpha: 0.22), blurRadius: 18, offset: const Offset(0, 8))]
        : const [],
  );
}

/// 统一的浮起卡片：视觉底座 + hover 位移/阴影，页面只关心内容。
class FishHoverCard extends StatefulWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  final EdgeInsetsGeometry? margin;
  final bool selected;
  final bool lift;
  const FishHoverCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.margin,
    this.selected = false,
    this.lift = true,
  });

  @override
  State<FishHoverCard> createState() => _FishHoverCardState();
}

class _FishHoverCardState extends State<FishHoverCard> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final lifted = widget.lift && _hover;
    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 160),
        curve: Curves.easeOut,
        margin: widget.margin,
        padding: widget.padding,
        transform: Matrix4.translationValues(0, lifted ? -2 : 0, 0),
        decoration: bentoCardDecoration(context, hover: lifted, selected: widget.selected),
        child: widget.child,
      ),
    );
  }
}

/// 便当盒里常用的「小标题卡」外框
class BentoPanel extends StatelessWidget {
  final String title;
  final String? note;
  final Widget child;
  const BentoPanel({super.key, required this.title, this.note, required this.child});

  @override
  Widget build(BuildContext context) {
    // P6：卡片实现统一到 ui_kit，bento 只保留尺寸/拖拽能力。
    return FishUiCard(level: FishCardLevel.outer, title: title, note: note, expandChild: true, child: child);
  }
}
