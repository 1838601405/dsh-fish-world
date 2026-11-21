import 'dart:math' as math;
import 'dart:ui' show ImageFilter;

import 'package:flutter/foundation.dart' show listEquals;
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'data/whale_data.dart';
import 'theme/whale_tokens.dart';

/// 浅色无限画布笔记页：InteractiveViewer + 自适应节点 + 贝塞尔连线。
/// 数据仍来自 NoteItem；画布只负责展示与交互，不改数据。
class NotesCanvas extends StatefulWidget {
  const NotesCanvas({super.key, required this.items, required this.onOpen, this.onDelete, this.onMove, this.trailing, this.selectedId, this.onSelect, this.controller});

  final List<NoteItem> items;
  final ValueChanged<NoteItem> onOpen;
  final ValueChanged<NoteItem>? onDelete;
  final Future<void> Function(NoteItem note, double x, double y)? onMove;
  final Widget? trailing;
  final String? selectedId;
  final ValueChanged<String?>? onSelect;
  final TransformationController? controller;

  @override
  State<NotesCanvas> createState() => _NotesCanvasState();
}

class _NotesCanvasState extends State<NotesCanvas> {
  final TransformationController _own = TransformationController();
  String? _innerSelected;

  TransformationController get _controller => widget.controller ?? _own;
  Timer? _zoomTimer;
  bool _zooming = false;

  void _watchZoom() {
    if (!_zooming) setState(() => _zooming = true);
    _zoomTimer?.cancel();
    _zoomTimer = Timer(const Duration(milliseconds: 180), () {
      if (mounted) setState(() => _zooming = false);
    });
  }
  String? get _selectedId => widget.selectedId ?? _innerSelected;
  void _select(String? id) {
    if (widget.onSelect != null) {
      widget.onSelect!(id);
    } else {
      setState(() => _innerSelected = id);
    }
  }

  @override
  void initState() {
    super.initState();
    _controller.addListener(_watchZoom);
  }

  @override
  void dispose() {
    _zoomTimer?.cancel();
    _controller.removeListener(_watchZoom);
    _own.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final layout = _buildLayout(widget.items);
    // 2026-11-09：画布跟随全局主题（深色下不再是一块白板）。所有颜色从 scheme 派生，
    // 不再用固定的 notesCanvasLight / notesNodeLight 这类浅色常量。
    final scheme = Theme.of(context).colorScheme;
    final dark = Theme.of(context).brightness == Brightness.dark;
    return ColoredBox(
      color: dark ? scheme.surface : scheme.surfaceContainerHighest,
      child: Stack(
        children: [
          Positioned.fill(
            child: InteractiveViewer(
              transformationController: _controller,
              constrained: false,
              minScale: 0.35,
              maxScale: 2.2,
              boundaryMargin: const EdgeInsets.all(320),
              panEnabled: true,
              scaleEnabled: true,
              child: SizedBox(
                width: layout.size.width,
                height: layout.size.height,
                child: Stack(
                  clipBehavior: Clip.none,
                  children: [
                    Positioned.fill(
                      child: RepaintBoundary(
                        child: CustomPaint(
                        painter: _DotGridPainter(
                          color: dark
                              ? Colors.white.withValues(alpha: 0.05)
                              : Colors.black.withValues(alpha: 0.05),
                          regions: layout.rects.values.toList(growable: false),
                          stepScale: _zooming ? 2 : 1,
                        ),
                      ),
                      ),
                    ),
                    Positioned.fill(
                      child: RepaintBoundary(
                        child: CustomPaint(
                        painter: _CanvasEdgePainter(
                          rects: layout.rects,
                          edges: layout.edges,
                          selectedId: _selectedId,
                          lineColor: dark
                              ? scheme.outlineVariant.withValues(alpha: 0.85)
                              : WhaleTokens.notesLineLight,
                          activeColor: scheme.primary,
                          anchorColor: dark
                              ? scheme.outlineVariant.withValues(alpha: 0.85)
                              : WhaleTokens.notesLineLight,
                        ),
                      ),
                      ),
                    ),
                    Positioned.fill(
                      child: GestureDetector(
                        behavior: HitTestBehavior.opaque,
                        onTap: () {
                          if (_selectedId != null) _select(null);
                        },
                      ),
                    ),
                    for (final node in layout.nodes)
                      Positioned(
                        left: node.rect.left,
                        top: node.rect.top,
                        width: node.rect.width,
                        child: Focus(
                          onKeyEvent: (n, e) => _nodeKey(e, layout, node),
                          child: RepaintBoundary(
                          child: _NoteNodeCard(
                            note: node.note,
                            selected: _selectedId == node.note.id,
                            onTap: () => _select(node.note.id),
                            onDoubleTap: () => widget.onOpen(node.note),
                            onSecondaryTap: () => _showNodeMenu(node),
                          ),
                        ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
          _toolbar(context, widget.trailing),
        ],
      ),
    );
  }

  Widget _toolbar(BuildContext context, Widget? trailing) {
    // 工具退居幕后（2026-11-09）：顶部居中 + 白毛玻璃 + 1px 细线，鼠标离开自动降到 62% 透明度。
    // 形状走圆角卡片而不是通体胶囊 —— 胶囊在浅色白板上是一块黑色异物（P43 记忆里的「禁胶囊」指的就是这种噪音）。
    return Positioned(
      top: 20,
      left: 0,
      right: 0,
      child: Center(child: _ToolbarSurface(trailing: trailing)),
    );
  }

  KeyEventResult _nodeKey(KeyEvent e, _CanvasLayout layout, _CanvasNode cur) {
    final k = e.logicalKey;
    if (k == LogicalKeyboardKey.enter || k == LogicalKeyboardKey.space) {
      widget.onOpen(cur.note);
      return KeyEventResult.handled;
    }
    if (k == LogicalKeyboardKey.escape) {
      _select(null);
      return KeyEventResult.handled;
    }
    if (k == LogicalKeyboardKey.keyE ||
        k == LogicalKeyboardKey.contextMenu ||
        (k == LogicalKeyboardKey.f10 && HardwareKeyboard.instance.isShiftPressed)) {
      _showNodeMenu(cur);
      return KeyEventResult.handled;
    }
    final dirs = {
      LogicalKeyboardKey.arrowLeft: const Offset(-1, 0),
      LogicalKeyboardKey.arrowRight: const Offset(1, 0),
      LogicalKeyboardKey.arrowUp: const Offset(0, -1),
      LogicalKeyboardKey.arrowDown: const Offset(0, 1),
    };
    final dir = dirs[k];
    if (dir == null) return KeyEventResult.ignored;
    // P9：Alt+方向键等价拖拽（24px 一格），写回 x/y。
    if (HardwareKeyboard.instance.isAltPressed && widget.onMove != null) {
      widget.onMove!(cur.note, cur.note.x + dir.dx * 24, cur.note.y + dir.dy * 24);
      return KeyEventResult.handled;
    }
    // 按 x/y 最近邻：只往前半球找，取投影距离最小、横向偏移最小的。
    _CanvasNode? best;
    var bestScore = double.infinity;
    for (final n in layout.nodes) {
      if (n.note.id == cur.note.id) continue;
      final d = n.rect.center - cur.rect.center;
      final along = d.dx * dir.dx + d.dy * dir.dy;
      if (along <= 4) continue;
      final across = (d.dx * dir.dy - d.dy * dir.dx).abs();
      final score = along + across * 1.6;
      if (score < bestScore) { bestScore = score; best = n; }
    }
    if (best != null) { _select(best.note.id); return KeyEventResult.handled; }
    return KeyEventResult.ignored;
  }

  Future<void> _showNodeMenu(_CanvasNode node) async {
    final box = context.findRenderObject() as RenderBox?;
    final origin = box == null ? Offset.zero : box.localToGlobal(node.rect.bottomLeft);
    final sel = await showMenu<String>(
      context: context,
      position: RelativeRect.fromLTRB(origin.dx, origin.dy, origin.dx + 1, origin.dy + 1),
      items: [
        const PopupMenuItem(value: 'open', child: Text('打开')),
        const PopupMenuItem(value: 'rename', child: Text('编辑')),
        const PopupMenuItem(value: 'move', enabled: false, child: Text('移组（待接存储）')),
        PopupMenuItem(value: 'delete', enabled: widget.onDelete != null, child: const Text('删除')),
      ],
    );
    if (sel == 'open' || sel == 'rename') widget.onOpen(node.note);
    if (sel == 'delete') widget.onDelete?.call(node.note);
  }

  _CanvasLayout _buildLayout(List<NoteItem> items) {
    const nodeW = 220.0;
    const gapX = 70.0;
    const gapY = 50.0;
    const leftPad = 90.0;
    const topPad = 86.0;

    final groups = <String, List<NoteItem>>{};
    for (final n in items) {
      final key = n.folder.trim().isNotEmpty ? n.folder.trim() : (n.src == 'favorite' ? '收藏' : '未分组');
      groups.putIfAbsent(key, () => <NoteItem>[]).add(n);
    }
    final keys = groups.keys.toList()..sort();
    final nodes = <_CanvasNode>[];
    final rects = <String, Rect>{};
    var cursorY = topPad;

    void addNode(NoteItem n, double left, double top, double h) {
      final rect = Rect.fromLTWH(left, top, nodeW, h);
      nodes.add(_CanvasNode(note: n, rect: rect));
      rects[n.id] = rect;
    }

    for (final key in keys) {
      final list = groups[key]!..sort((a, b) {
        final ay = a.y.compareTo(b.y);
        return ay != 0 ? ay : a.x.compareTo(b.x);
      });
      final ids = {for (final n in list) n.id};
      final children = <String, List<NoteItem>>{};
      for (final n in list) {
        if (n.parent.isNotEmpty && ids.contains(n.parent)) {
          children.putIfAbsent(n.parent, () => <NoteItem>[]).add(n);
        }
      }
      final hasParent = children.isNotEmpty;

      if (hasParent) {
        // 按树的自上而下分层（Buchheim/Walker 的简化版）：父节点在左，子节点按顺序往右展开，
        // 每个子树独占一段纵向空间 ⇒ 线从父节点右侧平滑连到子节点左侧，不再乱穿。
        for (final kids in children.values) {
          kids.sort((a, b) {
            final ay = a.y.compareTo(b.y);
            return ay != 0 ? ay : a.x.compareTo(b.x);
          });
        }
        final roots = list.where((n) => n.parent.isEmpty || !ids.contains(n.parent)).toList()
          ..sort((a, b) {
            final ay = a.y.compareTo(b.y);
            return ay != 0 ? ay : a.x.compareTo(b.x);
          });
        var rootTop = cursorY;
        var groupBottom = cursorY;
        double layoutSubtree(NoteItem n, int depth, double top, Set<String> visiting) {
          final h = _measureNodeHeight(n, nodeW);
          final kids = children[n.id] ?? const <NoteItem>[];
          if (visiting.contains(n.id) || kids.isEmpty) {
            addNode(n, leftPad + depth * (nodeW + gapX), top, h);
            return top + h;
          }
          visiting.add(n.id);
          var childTop = top;
          final childRects = <Rect>[];
          for (final kid in kids) {
            final bottom = layoutSubtree(kid, depth + 1, childTop, visiting);
            final rect = rects[kid.id];
            if (rect != null) childRects.add(rect);
            childTop = bottom + gapY;
          }
          visiting.remove(n.id);
          if (childRects.isEmpty) {
            addNode(n, leftPad + depth * (nodeW + gapX), top, h);
            return top + h;
          }
          final center = (childRects.first.center.dy + childRects.last.center.dy) / 2;
          final myTop = center - h / 2;
          addNode(n, leftPad + depth * (nodeW + gapX), myTop, h);
          return math.max(childTop - gapY, myTop + h);
        }

        for (final root in roots) {
          final bottom = layoutSubtree(root, 0, rootTop, <String>{});
          rootTop = bottom + gapY;
          groupBottom = math.max(groupBottom, bottom);
        }
        // 没有父节点的孤立节点也要显示（避免有 parent 的组把孤立项吞掉）。
        for (final n in list) {
          if (rects.containsKey(n.id)) continue;
          addNode(n, leftPad, rootTop, _measureNodeHeight(n, nodeW));
          groupBottom = math.max(groupBottom, rootTop + _measureNodeHeight(n, nodeW));
          rootTop += _measureNodeHeight(n, nodeW) + gapY;
        }
        cursorY = groupBottom + 110;
      } else {
        // 没有父子关系的组才用卡片列；三列比单列更利用画布，也不制造线。
        final columns = list.length > 6 ? 3 : (list.length > 2 ? 2 : 1);
        final columnY = List<double>.filled(columns, cursorY);
        var groupBottom = cursorY;
        for (var i = 0; i < list.length; i++) {
          final n = list[i];
          final h = _measureNodeHeight(n, nodeW);
          final col = i % columns;
          final left = leftPad + col * (nodeW + gapX);
          final top = columnY[col];
          addNode(n, left, top, h);
          columnY[col] += h + gapY;
          groupBottom = math.max(groupBottom, top + h);
        }
        cursorY = groupBottom + 90;
      }
    }

    final ids = {for (final n in items) n.id};
    final folderOf = {for (final n in items) n.id: n.folder};
    final edges = <List<String>>[];
    for (final n in items) {
      if (n.parent.isNotEmpty && ids.contains(n.parent) && folderOf[n.parent] == n.folder) {
        edges.add([n.parent, n.id]);
      }
      for (final l in n.links) {
        if (ids.contains(l) && folderOf[l] == n.folder) edges.add([n.id, l]);
      }
    }

    var maxRight = 0.0;
    for (final n in nodes) {
      maxRight = math.max(maxRight, n.rect.right);
    }
    return _CanvasLayout(
      nodes: nodes,
      rects: rects,
      edges: edges,
      size: Size(math.max(1400, maxRight + 160), math.max(900, cursorY + 160)),
    );
  }

  double _measureNodeHeight(NoteItem n, double width) {
    final tp = TextPainter(
      text: TextSpan(
        text: n.title.isEmpty ? '（空白笔记）' : n.title,
        style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600, height: 1.35),
      ),
      maxLines: 6,
      textDirection: TextDirection.ltr,
    )..layout(maxWidth: width - 32);
    final meta = n.mtime.trim().isEmpty ? 0.0 : 18.0;
    return math.max(56.0, tp.height + 32 + meta);
  }
}

/// 顶部悬浮工具条（notion-style：浅底 + 1px 线 + 毛玻璃；鼠标离开自动变淡）。
class _ToolbarSurface extends StatefulWidget {
  const _ToolbarSurface({this.trailing});

  final Widget? trailing;

  @override
  State<_ToolbarSurface> createState() => _ToolbarSurfaceState();
}

class _ToolbarSurfaceState extends State<_ToolbarSurface> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: AnimatedOpacity(
        opacity: _hover ? 1 : 0.62,
        duration: const Duration(milliseconds: 180),
        curve: Curves.easeOut,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(WhaleTokens.rMd),
          child: BackdropFilter(
            filter: ImageFilter.blur(sigmaX: 18, sigmaY: 18),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 5),
              decoration: BoxDecoration(
                // 浅色=白 72%、深色=深灰 72%：同一表达式跟随主题，不再固定白底。
                color: scheme.surface.withValues(alpha: 0.72),
                borderRadius: BorderRadius.circular(WhaleTokens.rMd),
                border: Border.all(color: scheme.outlineVariant, width: 1),
                boxShadow: [
                  BoxShadow(color: Colors.black.withValues(alpha: 0.06), blurRadius: 14, offset: const Offset(0, 4)),
                ],
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                if (widget.trailing != null) widget.trailing!,
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

class _CanvasLayout {
  final List<_CanvasNode> nodes;
  final Map<String, Rect> rects;
  final List<List<String>> edges;
  final Size size;
  const _CanvasLayout({required this.nodes, required this.rects, required this.edges, required this.size});
}

class _CanvasNode {
  final NoteItem note;
  final Rect rect;
  const _CanvasNode({required this.note, required this.rect});
}

class _NoteNodeCard extends StatefulWidget {
  const _NoteNodeCard({required this.note, required this.selected, required this.onTap, required this.onDoubleTap, this.onSecondaryTap});

  final NoteItem note;
  final bool selected;
  final VoidCallback onTap;
  final VoidCallback onDoubleTap;
  final VoidCallback? onSecondaryTap;

  @override
  State<_NoteNodeCard> createState() => _NoteNodeCardState();
}

class _NoteNodeCardState extends State<_NoteNodeCard> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final dark = Theme.of(context).brightness == Brightness.dark;
    final active = scheme.primary;
    // 深色下卡片和画布都是深灰：靠一道极淡的 outline 边框把卡片「托」出来，
    // 否则深灰压深灰会糊成一团（用户 2026-11-09 特别提过）。
    final borderColor = widget.selected
        ? active.withValues(alpha: 0.95)
        : (_hover
            ? active.withValues(alpha: 0.32)
            : (dark
                ? scheme.outlineVariant.withValues(alpha: 0.55)
                : scheme.outline));
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: Semantics(
        button: true,
        label: widget.note.title,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 140),
          curve: Curves.easeOut,
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: scheme.surface,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: borderColor, width: widget.selected ? 1.8 : 1),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(
                    alpha: dark
                        ? (_hover ? 0.30 : 0.22)
                        : (_hover ? 0.08 : 0.04)),
                blurRadius: _hover ? 18 : 12,
                offset: const Offset(0, 4),
              ),
            ],
          ),
          child: InkWell(
            borderRadius: BorderRadius.circular(8),
            onTap: widget.onTap,
            onDoubleTap: widget.onDoubleTap,
            onSecondaryTap: widget.onSecondaryTap,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  widget.note.title.isEmpty ? '（空白笔记）' : widget.note.title,
                  maxLines: 6,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 14,
                    height: 1.35,
                    fontWeight: FontWeight.w600,
                    color: scheme.onSurface,
                  ),
                ),
                if (widget.note.mtime.trim().isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Text(
                    widget.note.mtime,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        fontSize: WhaleTokens.fsSmall,
                        height: 1.3,
                        color: scheme.onSurfaceVariant),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _CanvasEdgePainter extends CustomPainter {
  _CanvasEdgePainter({
    required this.rects,
    required this.edges,
    required this.selectedId,
    required this.lineColor,
    required this.activeColor,
    required this.anchorColor,
  });
  final Map<String, Rect> rects;
  final List<List<String>> edges;
  final String? selectedId;
  final Color lineColor;
  final Color activeColor;
  final Color anchorColor;

  @override
  void paint(Canvas canvas, Size size) {
    for (final e in edges) {
      final a = rects[e[0]];
      final b = rects[e[1]];
      if (a == null || b == null) continue;
      final active = selectedId != null && (e[0] == selectedId || e[1] == selectedId);
      final paint = Paint()
        ..color = active ? activeColor.withValues(alpha: 0.9) : lineColor
        ..style = PaintingStyle.stroke
        ..strokeWidth = active ? 1.8 : 1.1;
      // 按相对方位选出口，不要永远从右侧绕到左侧 —— 树布局里子节点在右，
      // 但如果节点被拖到上方/左侧，线也要跟着换方向，否则就会出现绕圈乱线。
      late final Offset p1;
      late final Offset p2;
      late final Path path;
      if (b.left >= a.right - 8) {
        p1 = a.centerRight;
        p2 = b.centerLeft;
        final dx = ((p2.dx - p1.dx).abs() / 2).clamp(24.0, 130.0);
        path = Path()
          ..moveTo(p1.dx, p1.dy)
          ..cubicTo(p1.dx + dx, p1.dy, p2.dx - dx, p2.dy, p2.dx, p2.dy);
      } else if (b.top >= a.bottom - 8) {
        p1 = a.bottomCenter;
        p2 = b.topCenter;
        final dy = ((p2.dy - p1.dy).abs() / 2).clamp(24.0, 130.0);
        path = Path()
          ..moveTo(p1.dx, p1.dy)
          ..cubicTo(p1.dx, p1.dy + dy, p2.dx, p2.dy - dy, p2.dx, p2.dy);
      } else if (b.right <= a.left + 8) {
        p1 = a.centerLeft;
        p2 = b.centerRight;
        final dx = ((p1.dx - p2.dx).abs() / 2).clamp(24.0, 130.0);
        path = Path()
          ..moveTo(p1.dx, p1.dy)
          ..cubicTo(p1.dx - dx, p1.dy, p2.dx + dx, p2.dy, p2.dx, p2.dy);
      } else {
        p1 = a.topCenter;
        p2 = b.bottomCenter;
        final dy = ((p1.dy - p2.dy).abs() / 2).clamp(24.0, 130.0);
        path = Path()
          ..moveTo(p1.dx, p1.dy)
          ..cubicTo(p1.dx, p1.dy - dy, p2.dx, p2.dy + dy, p2.dx, p2.dy);
      }
      canvas.drawPath(path, paint);
      // 锚点：线段两端各一个极小的灰点，提示「这里可以连线」（选中时跟着变主色）。
      final anchor = Paint()
        ..color = active ? activeColor : anchorColor
        ..style = PaintingStyle.fill;
      canvas.drawCircle(p1, 2.4, anchor);
      canvas.drawCircle(p2, 2.4, anchor);
    }
  }

  @override
  bool shouldRepaint(covariant _CanvasEdgePainter oldDelegate) =>
      oldDelegate.edges != edges ||
      oldDelegate.rects != rects ||
      oldDelegate.selectedId != selectedId ||
      oldDelegate.lineColor != lineColor ||
      oldDelegate.activeColor != activeColor ||
      oldDelegate.anchorColor != anchorColor;
}

class _DotGridPainter extends CustomPainter {
  const _DotGridPainter({required this.color, required this.regions, this.stepScale = 1});

  final Color color;
  final List<Rect> regions;
  final int stepScale;

  @override
  void paint(Canvas canvas, Size size) {
    if (regions.isEmpty) return;
    final paint = Paint()..color = color;
    final step = 26.0 * stepScale;
    for (final rect in regions) {
      final b = rect.inflate(36).intersect(Offset.zero & size);
      final x0 = (b.left / step).floor() * step;
      final y0 = (b.top / step).floor() * step;
      for (var x = x0; x < b.right; x += step) {
        for (var y = y0; y < b.bottom; y += step) {
          if (x <= 0 || y <= 0) continue;
          canvas.drawCircle(Offset(x, y), 1.0, paint);
        }
      }
    }
  }

  @override
  bool shouldRepaint(covariant _DotGridPainter oldDelegate) =>
      oldDelegate.color != color || oldDelegate.stepScale != stepScale || !listEquals(oldDelegate.regions, regions);
}
