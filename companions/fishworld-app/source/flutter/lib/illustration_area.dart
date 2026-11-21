import 'package:flutter/material.dart';
import 'ui_motion.dart';

/// 中立绘区：浅色径向渐变底 + 居中立绘（AspectRatio 防抖）+ 底部悬浮工具条。
class IllustrationArea extends StatelessWidget {
  final bool showDock; // 手机端顶部小区域不需要底部工具条
  const IllustrationArea({super.key, this.showDock = true});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      decoration: BoxDecoration(
        gradient: RadialGradient(
          center: const Alignment(0, -0.1),
          radius: 1.2,
          colors: [scheme.surface, scheme.surfaceContainerHighest],
        ),
      ),
      child: Stack(children: [
        Center(
          child: AspectRatio(
            aspectRatio: 3 / 4, // 预设比例，加载不跳动
            // 分层闲置：呼吸 + 摆尾各自一条 AnimationController 叠着跑，
            // 点一下冒爱心也只是**再叠一层**，不会把摆尾打断。
            child: LayeredPet(
              size: 220,
              child: Image.asset(
                'assets/mascot.png',
                fit: BoxFit.contain,
                errorBuilder: (_, __, ___) =>
                    _IllustrationFallback(scheme: scheme),
              ),
            ),
          ),
        ),
        if (showDock)
          const Align(alignment: Alignment.bottomCenter, child: _ToolDock()),
      ]),
    );
  }
}

class _IllustrationFallback extends StatelessWidget {
  final ColorScheme scheme;
  const _IllustrationFallback({required this.scheme});
  @override
  Widget build(BuildContext context) => Container(
        decoration: BoxDecoration(
          border: Border.all(color: scheme.outlineVariant),
          borderRadius: BorderRadius.circular(12),
        ),
        // ★ 没有 mascot.png 时显示“占位”而不是“坏图”：
        //   用户看到的是一个明确提示（该放什么、放哪里），而不是以为应用坏了。
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.image_outlined,
                  size: 44, color: scheme.onSurfaceVariant),
              const SizedBox(height: 10),
              Text('立绘占位',
                  style: Theme.of(context)
                      .textTheme
                      .titleSmall
                      ?.copyWith(color: scheme.onSurfaceVariant)),
              const SizedBox(height: 4),
              Text('把 mascot.png 放进 assets/',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant.withValues(alpha: 0.7))),
            ],
          ),
        ),
      );
}

class _ToolDock extends StatelessWidget {
  const _ToolDock();
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    const tools = [
      Icons.visibility_outlined,
      Icons.brush_outlined,
      Icons.camera_alt_outlined
    ];
    return Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
        decoration: BoxDecoration(
          color: scheme.surface.withValues(alpha: 0.9),
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: scheme.outlineVariant),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final t in tools)
              IconButton(
                  icon: Icon(t, size: 20),
                  color: scheme.onSurface,
                  onPressed: () {}),
          ],
        ),
      ),
    );
  }
}
