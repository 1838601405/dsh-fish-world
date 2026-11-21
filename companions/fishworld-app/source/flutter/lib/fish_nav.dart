import 'dart:async';

import 'package:flutter/material.dart';

import 'sidebar.dart';
import 'theme/whale_tokens.dart';

/// 跨页跳转：带上「定位到什么」。
class FishNavIntent {
  final NavRoute route;
  final String target;
  const FishNavIntent(this.route, this.target);
}

class FishNav {
  static VoidCallback? onNavigate;
  static String pendingTarget = '';
  static NavRoute? pendingRoute;
  static String? pendingAnchor;
  static String? pendingField;

  static final Map<String, GlobalKey> anchors = <String, GlobalKey>{};
  static final Map<String, FocusNode> fields = <String, FocusNode>{};
  static final Map<String, VoidCallback> openers = <String, VoidCallback>{};
  static final ValueNotifier<String?> highlight = ValueNotifier<String?>(null);

  static void go(NavRoute route, {String target = ''}) {
    pendingTarget = target;
    pendingRoute = route;
    onNavigate?.call();
  }

  /// 切页/同页定位：滚到 anchor、能展开就展开、高亮 1 秒；可选聚焦输入框。
  static void focus(NavRoute route, String anchor, {String? field}) {
    pendingAnchor = anchor;
    pendingField = field;
    if (pendingRoute != route) {
      pendingRoute = route;
      onNavigate?.call();
    }
    kick();
  }

  static NavRoute? takeRoute() {
    final r = pendingRoute;
    pendingRoute = null;
    return r;
  }

  static String consumeTarget() {
    final t = pendingTarget;
    pendingTarget = '';
    return t;
  }

  static void registerAnchor(String anchor, GlobalKey key) => anchors[anchor] = key;
  static void registerField(String field, FocusNode node) => fields[field] = node;
  static void registerOpener(String anchor, VoidCallback open) => openers[anchor] = open;

  /// 页面构建完后调用；key 还没注册就等下一帧重试（最多 ~2s）。
  static void kick() {
    unawaited(_apply());
  }

  static Future<void> _apply() async {
    final anchor = pendingAnchor;
    if (anchor == null) return;
    for (var i = 0; i < 12; i++) {
      final key = anchors[anchor];
      final ctx = key?.currentContext;
      if (ctx != null) {
        try { openers[anchor]?.call(); } catch (_) {}
        await Future<void>.delayed(const Duration(milliseconds: 60));
        final ctx2 = anchors[anchor]?.currentContext;
        if (ctx2 != null) {
          try {
            await Scrollable.ensureVisible(ctx2, duration: const Duration(milliseconds: 320), alignment: 0.08);
          } catch (_) {}
        }
        highlight.value = anchor;
        Timer(const Duration(seconds: 1), () { if (highlight.value == anchor) highlight.value = null; });
        final f = pendingField;
        pendingAnchor = null;
        pendingField = null;
        if (f != null) fields[f]?.requestFocus();
        return;
      }
      await Future<void>.delayed(const Duration(milliseconds: 160));
    }
    pendingAnchor = null;
    pendingField = null;
  }
}

/// 页面里给一块区域注册可定位的锚点，并在被定位时闪一下主题色底（1 秒）。
class FishAnchor extends StatefulWidget {
  final String anchor;
  final Widget child;
  const FishAnchor({super.key, required this.anchor, required this.child});
  @override
  State<FishAnchor> createState() => _FishAnchorState();
}

class _FishAnchorState extends State<FishAnchor> {
  final GlobalKey _key = GlobalKey();
  @override
  void initState() {
    super.initState();
    FishNav.registerAnchor(widget.anchor, _key);
    FishNav.highlight.addListener(_on);
  }
  void _on() { if (mounted) setState(() {}); }
  @override
  void dispose() {
    FishNav.highlight.removeListener(_on);
    super.dispose();
  }
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final hot = FishNav.highlight.value == widget.anchor;
    return AnimatedContainer(
      key: _key,
      duration: const Duration(milliseconds: 180),
      decoration: BoxDecoration(
        color: hot ? scheme.primary.withValues(alpha: .10) : Colors.transparent,
        borderRadius: BorderRadius.circular(WhaleTokens.rMd),
      ),
      child: widget.child,
    );
  }
}
