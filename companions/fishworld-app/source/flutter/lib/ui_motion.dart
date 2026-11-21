// 交互动效件：从 dsh-TUI 的交互「模式」落到 Flutter（不抄代码、不引入 Ink）。
//
// 四个模式：
//   1. 桌宠分层闲置：每个动作一条独立 AnimationController，**叠加**而不是替换——
//      TUI 那边旧的全帧调度一次只做一个动作，这里改成层叠加（尾巴 / 呼吸 / 眨眼 / 睡 / 爱心）。
//   2. 输入框焦点：focus 时自绘渐变边框扫光，失焦回静态主题色；静止时零开销（不建 painter）。
//   3. 骨架屏微光：蓝白渐变流动，不整块灰。
//   4. 弹层：BackdropFilter + 遮罩（深 55% / 浅 28%），内容超长自适应收缩不硬裁。
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import 'theme/whale_tokens.dart';

/// 弹层遮罩的不透明度：深色 55%，浅色 28%（与 WhaleTokens.scrimFor 同口径）。
double scrimOpacityFor(Brightness brightness) =>
    brightness == Brightness.light ? 0.28 : 0.55;

// ───────────────────────── 1. 桌宠：可叠加的闲置层 ─────────────────────────

/// 桌宠的分层控制器：每个动作一条 AnimationController，互不打断。
///
/// 用法：`LayeredPet(controller: c)`，然后 `c.trigger(PetLayer.heart)`。
/// 触发爱心不会停掉摆尾——这就是「层叠加」和「全帧调度」的区别。
class PetLayer {
  static const breathing = 'breathing';
  static const tail = 'tail';
  static const blink = 'blink';
  static const sleep = 'sleep';
  static const heart = 'heart';
  static const all = [breathing, tail, blink, sleep, heart];
}

class LayeredPetController {
  LayeredPetController({required TickerProvider vsync, this.frames = const {}})
      : _vsync = vsync;

  final TickerProvider _vsync;
  final Map<String, int> frames;
  final Map<String, AnimationController> _controllers = {};
  final Map<String, bool> _looping = {};

  /// 当前仍在跑（或正在收尾）的层——测试与调试用。
  List<String> get activeLayers => PetLayer.all
      .where((name) => _controllers[name]?.isAnimating ?? false)
      .toList();

  bool isActive(String layer) => _controllers[layer]?.isAnimating ?? false;

  double valueOf(String layer) => _controllers[layer]?.value ?? 0;

  AnimationController controllerFor(String layer) {
    return _controllers.putIfAbsent(layer, () {
      final framesCount = frames[layer] ?? 1;
      final c = AnimationController(
        vsync: _vsync,
        duration: Duration(milliseconds: framesCount * 60),
      );
      if (layer == PetLayer.breathing) c.repeat(reverse: true);
      if (layer == PetLayer.tail) c.repeat(reverse: true);
      return c;
    });
  }

  /// 触发一层。已经在跑的不重建——叠加，不抢占。
  Future<void> trigger(String layer) async {
    final c = controllerFor(layer);
    if (_looping[layer] == true) return;
    if (layer == PetLayer.breathing || layer == PetLayer.tail) {
      _looping[layer] = true;
      if (!c.isAnimating) c.repeat(reverse: true);
      return;
    }
    await c.forward(from: 0);
  }

  void dispose() {
    for (final c in _controllers.values) {
      c.dispose();
    }
    _controllers.clear();
  }
}

/// 桌宠：把几层各自独立的动画叠在一张立绘上。
///
/// 任何一层在跑都不影响别的层——验收 a：两个动作同时触发时谁也不覆盖谁。
class LayeredPet extends StatefulWidget {
  const LayeredPet({
    super.key,
    this.child,
    this.controller,
    this.size = 120,
    this.onHeart,
  });

  final Widget? child;
  final LayeredPetController? controller;
  final double size;
  final VoidCallback? onHeart;

  @override
  State<LayeredPet> createState() => LayeredPetState();
}

class LayeredPetState extends State<LayeredPet> with TickerProviderStateMixin {
  late LayeredPetController _c;
  bool _own = false;

  @override
  void initState() {
    super.initState();
    if (widget.controller != null) {
      _c = widget.controller!;
    } else {
      _c = LayeredPetController(vsync: this, frames: const {
        PetLayer.breathing: 36,
        PetLayer.tail: 24,
        PetLayer.blink: 8,
        PetLayer.sleep: 30,
        PetLayer.heart: 14,
      });
      _own = true;
      _c.trigger(PetLayer.breathing);
      _c.trigger(PetLayer.tail);
    }
  }

  @override
  void deactivate() {
    // 切页时停掉所有层：ticker 留着会在失活树上重建。
    for (final layer in PetLayer.all) {
      final controller = _c.controllerFor(layer);
      if (controller.isAnimating) controller.stop();
    }
    super.deactivate();
  }

  @override
  void activate() {
    super.activate();
    _c.trigger(PetLayer.breathing);
    _c.trigger(PetLayer.tail);
  }

  @override
  void dispose() {
    if (_own) _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return GestureDetector(
      onTap: widget.onHeart == null
          ? null
          : () {
              _c.trigger(PetLayer.heart);
              widget.onHeart?.call();
            },
      child: SizedBox(
        width: widget.size,
        height: widget.size,
        child: Stack(
          alignment: Alignment.center,
          children: [
            // 呼吸层：整张轻微缩放（最底，不影响别的层）
            AnimatedBuilder(
              animation: _c.controllerFor(PetLayer.breathing),
              builder: (_, child) => Transform.scale(
                scale: 1 +
                    0.012 *
                        Curves.easeInOut
                            .transform(_c.valueOf(PetLayer.breathing)),
                child: child,
              ),
              child: widget.child ??
                  Container(
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      gradient: LinearGradient(
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                        colors: [
                          scheme.primary.withValues(alpha: 0.22),
                          scheme.surface
                        ],
                      ),
                    ),
                  ),
            ),
            // 摆尾层：整张轻微左右偏头（独立 period，和呼吸叠着跑）
            AnimatedBuilder(
              animation: _c.controllerFor(PetLayer.tail),
              builder: (_, child) => Transform.rotate(
                angle: 0.02 * math.sin(_c.valueOf(PetLayer.tail) * math.pi * 2),
                child: child,
              ),
              child: const SizedBox.shrink(),
            ),
            // 爱心层：从底部升起淡出，叠加在摆尾上，不打断它
            AnimatedBuilder(
              animation: _c.controllerFor(PetLayer.heart),
              builder: (_, __) {
                final t = _c.valueOf(PetLayer.heart);
                if (!_c.isActive(PetLayer.heart) || t <= 0) {
                  return const SizedBox.shrink();
                }
                return Positioned(
                  top: widget.size * (0.42 - 0.3 * t),
                  child: Opacity(
                    opacity: (1 - t).clamp(0.0, 1.0),
                    child: Icon(Icons.favorite,
                        size: 16 + 6 * t, color: scheme.primary),
                  ),
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}

// ───────────────────────── 2. 焦点渐变边框 ─────────────────────────

/// 输入框焦点边框：聚焦时沿边框跑一圈渐变光，失焦立刻回到静态色。
/// 没聚焦时不建 painter —— 静止零开销。
class FocusSweepBorder extends StatefulWidget {
  const FocusSweepBorder({
    super.key,
    required this.focused,
    required this.child,
    this.radius = 14,
    this.width = 1.4,
  });

  final bool focused;
  final Widget child;
  final double radius;
  final double width;

  @override
  State<FocusSweepBorder> createState() => _FocusSweepBorderState();
}

class _FocusSweepBorderState extends State<FocusSweepBorder>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1800),
  );

  @override
  void initState() {
    super.initState();
    if (widget.focused) _c.repeat();
  }

  @override
  void didUpdateWidget(covariant FocusSweepBorder old) {
    super.didUpdateWidget(old);
    if (widget.focused && !_c.isAnimating) _c.repeat();
    if (!widget.focused && _c.isAnimating) _c.stop();
  }

  @override
  void deactivate() {
    // 页面切走时先停表：留着一个还在跑的 ticker 会在已失活的 element 上 rebuild，
    // build 里再调 Theme.of 就抛「deactivated widget's ancestor is unsafe」。
    if (_c.isAnimating) _c.stop();
    super.deactivate();
  }

  @override
  void activate() {
    super.activate();
    if (widget.focused && !_c.isAnimating) _c.repeat();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    // 结构必须稳定：不论聚焦与否都是「AnimatedBuilder > CustomPaint」。
    // 之前在两种 widget 之间切换，聚焦瞬间整棵子树被重建，TextField 会丢焦点、
    // 测试里「输入完再点发送」直接失效（实测踩到）。
    // 静止时 painter 为 null —— 不画、也不算，零开销。
    return AnimatedBuilder(
      animation: _c,
      builder: (context, child) => CustomPaint(
        painter: widget.focused
            ? _SweepBorderPainter(
                progress: _c.value,
                radius: widget.radius,
                width: widget.width,
                colors: [scheme.primary, scheme.tertiary, scheme.primary],
              )
            : null,
        foregroundPainter: widget.focused
            ? null
            : _StaticBorderPainter(
                radius: widget.radius,
                width: widget.width,
                color: scheme.outlineVariant,
              ),
        child: child,
      ),
      child: widget.child,
    );
  }
}

/// 失焦时的静态边框（一条普通描边，不带动画）。
class _StaticBorderPainter extends CustomPainter {
  _StaticBorderPainter({
    required this.radius,
    required this.width,
    required this.color,
  });

  final double radius;
  final double width;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final rrect = RRect.fromRectAndRadius(
      (Offset.zero & size).deflate(width / 2),
      Radius.circular(radius),
    );
    canvas.drawRRect(
      rrect,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = width
        ..color = color,
    );
  }

  @override
  bool shouldRepaint(covariant _StaticBorderPainter old) =>
      old.color != color || old.radius != radius || old.width != width;
}

class _SweepBorderPainter extends CustomPainter {
  _SweepBorderPainter({
    required this.progress,
    required this.radius,
    required this.width,
    required this.colors,
  });

  final double progress;
  final double radius;
  final double width;
  final List<Color> colors;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final rrect = RRect.fromRectAndRadius(
      rect.deflate(width / 2),
      Radius.circular(radius),
    );
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = width
      ..shader = SweepGradient(
        startAngle: 0,
        endAngle: math.pi * 2,
        transform: GradientRotation(progress * math.pi * 2),
        colors: [
          colors[0].withValues(alpha: 0.15),
          colors[1],
          colors[0].withValues(alpha: 0.15),
        ],
        stops: const [0.0, 0.5, 1.0],
      ).createShader(rect);
    canvas.drawRRect(rrect, paint);
  }

  @override
  bool shouldRepaint(covariant _SweepBorderPainter old) =>
      old.progress != progress || old.colors != colors;
}

// ───────────────────────── 3. 骨架屏微光 ─────────────────────────

/// 骨架块：蓝白渐变在块上来回流动，比整块灰好看，也一眼看出在加载。
class ShimmerBox extends StatefulWidget {
  const ShimmerBox({
    super.key,
    this.width,
    this.height = 16,
    this.radius = 8,
  });

  final double? width;
  final double height;
  final double radius;

  @override
  State<ShimmerBox> createState() => _ShimmerBoxState();
}

class _ShimmerBoxState extends State<ShimmerBox>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  )..repeat();

  @override
  void deactivate() {
    if (_c.isAnimating) _c.stop();
    super.deactivate();
  }

  @override
  void activate() {
    super.activate();
    if (!_c.isAnimating) _c.repeat();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final base = scheme.surfaceContainerHighest.withValues(alpha: 0.35);
    final highlight = Color.alphaBlend(
      scheme.primary.withValues(alpha: 0.16),
      scheme.surface,
    );
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        final shift = -1.6 + 3.2 * _c.value;
        return Container(
          width: widget.width,
          height: widget.height,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(widget.radius),
            gradient: LinearGradient(
              begin: Alignment(shift - 0.6, -0.2),
              end: Alignment(shift + 0.6, 0.2),
              colors: [base, highlight, base],
              stops: const [0.25, 0.5, 0.75],
            ),
          ),
        );
      },
    );
  }
}

// ───────────────────────── 4. 弹层：模糊 + 压暗 ─────────────────────────

/// 弹层底：BackdropFilter 把后面糊掉，再叠一层压暗遮罩（深 55% / 浅 28%）。
/// 注意方向：是**压暗**，不是提亮。
class AppScrim extends StatelessWidget {
  const AppScrim({
    super.key,
    required this.child,
    this.blurSigma = 6,
    this.opacity,
    this.borderRadius,
  });

  final Widget child;
  final double blurSigma;
  final double? opacity;
  final BorderRadius? borderRadius;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final alpha = opacity ?? scrimOpacityFor(brightness);
    final fill = Colors.black.withValues(alpha: alpha);
    Widget content = ClipRRect(
      borderRadius: borderRadius ?? BorderRadius.circular(16),
      child: BackdropFilter(
        filter: ui.ImageFilter.blur(sigmaX: blurSigma, sigmaY: blurSigma),
        child: ColoredBox(color: fill, child: child),
      ),
    );
    return content;
  }
}

/// 超长内容自适应收缩：先按可用高度收缩，再让内部滚动，而不是硬裁。
class ShrinkToFit extends StatelessWidget {
  const ShrinkToFit(
      {super.key, required this.child, this.maxHeightFactor = 0.72});

  final Widget child;
  final double maxHeightFactor;

  @override
  Widget build(BuildContext context) {
    final maxHeight = MediaQuery.sizeOf(context).height * maxHeightFactor;
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: maxHeight),
      child: child,
    );
  }
}

/// 深/浅色下都能用的静态焦点色（失焦时用，不建动画）。
Color staticBorderOf(ColorScheme scheme) => scheme.outlineVariant;

/// 给测试断言用：浅色遮罩 0.28、深色 0.55。
double scrimAlphaFor(Brightness b) => scrimOpacityFor(b);

/// 一致性：遮罩颜色取自主题 token，而不是随手写死。
Color scrimColorFor(Brightness b) => WhaleTokens.scrimFor(b);
