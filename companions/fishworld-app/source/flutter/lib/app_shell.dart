import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'sidebar.dart';
import 'fish_nav.dart';
import 'chat_panel.dart';
import 'pages.dart';
import 'theme/whale_tokens.dart';
import 'window_title_bar.dart';
import 'window_chrome_stub.dart' if (dart.library.io) 'window_chrome_io.dart' as chrome;
import 'feedback.dart';

/// 响应式外壳（2026-11-06 ~ 11-07）：
///   · 宽屏（>=900）：左侧栏（可选中）+ 内容区；内容区里「对话」= 立绘 + 聊天面板，
///     其它页 = 该页占位；
///   · 窄屏（手机）：抽屉导航 + 单栏（对话或当前页）。
/// 侧栏点击**真的切页**（之前 onTap 是空的）。
class AppShell extends StatefulWidget {
  const AppShell({super.key});

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  static const double _wideBreakpoint = 900;

  NavRoute _route = NavRoute.chat;
  final _scaffoldKey = GlobalKey<ScaffoldState>();

  @override
  void initState() {
    super.initState();
    FishNav.onNavigate = () {
      if (!mounted) return;
      final r = FishNav.takeRoute();
      if (r != null) {
        setState(() => _route = r);
        WidgetsBinding.instance.addPostFrameCallback((_) => FishNav.kick());
      }
    };
    // 深链：?route=memory 直接打开某页（便于分享/截图/测试）
    try {
      final name = Uri.base.queryParameters['route'];
      if (name != null) {
        for (final r in NavRoute.values) {
          if (r.name == name) {
            _route = r;
            break;
          }
        }
      }
    } catch (_) {}
    WidgetsBinding.instance.addPostFrameCallback((_) => sayFeedback('欢迎回来~'));
  }

  void _select(NavRoute r) {
    setState(() => _route = r);
    // 手机端：选完自动收起抽屉
    _scaffoldKey.currentState?.closeDrawer();
  }

  /// 内容区（宽屏）
  Widget _wideContent() {
    if (_route == NavRoute.chat) {
      // 2026-11-07：对话区不再放那块大立绘（有桌宠就够了）⇒ 聊天直接占满
      return const ChatPanel(width: double.infinity);
    }
    return RoutePageOverlay(
      key: ValueKey('page-${_route.name}'),
      child: RoutePage(route: _route),
    );
  }

  // 2026-11-09：笔记与记忆不再强制浅色主题。用户反馈深色模式下这两页「主题穿透」：
  // 画布纯白、记忆册纯白，只有侧栏是深的。两页内部颜色已全部改为从 Theme 派生，
  // 这里只负责画布底色 —— 不再套第二层 Theme（嵌套主题会丢 CJK 字体回退）。
  Widget _routeTheme(BuildContext context, Widget page) {
    return _canvas(context, page);
  }

  /// 画布：本体是「藏青辉光 → 近黑」的径向渐变（renderer/style.css body）。
  Widget _canvas(BuildContext context, Widget child) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: RadialGradient(
          center: const Alignment(0.15, -1.0),
          radius: 0.8,
          stops: const [0, 0.62, 1],
          colors: dark
              ? [
                  Color.lerp(WhaleTokens.glowDark, WhaleTokens.canvasDark, 0.18)!,
                  WhaleTokens.canvasDark,
                  WhaleTokens.canvasDark
                ]
              : [
                  Color.lerp(WhaleTokens.canvasGlowLight, WhaleTokens.bgLight, 0.18)!,
                  WhaleTokens.bgLight,
                  WhaleTokens.bgLight
                ],
        ),
      ),
      child: child,
    );
  }

  Widget _withPageShortcuts(Widget child) {
    const visible = [NavRoute.chat, NavRoute.overview, NavRoute.notes, NavRoute.diary, NavRoute.wish, NavRoute.growth, NavRoute.memory, NavRoute.status, NavRoute.collections];
    const keys = [LogicalKeyboardKey.digit1, LogicalKeyboardKey.digit2, LogicalKeyboardKey.digit3, LogicalKeyboardKey.digit4, LogicalKeyboardKey.digit5, LogicalKeyboardKey.digit6, LogicalKeyboardKey.digit7, LogicalKeyboardKey.digit8, LogicalKeyboardKey.digit9];
    final bindings = <ShortcutActivator, VoidCallback>{};
    for (var i = 0; i < keys.length; i++) {
      bindings[SingleActivator(keys[i], alt: true)] = () => _select(visible[i]);
    }
    return CallbackShortcuts(bindings: bindings, child: Focus(autofocus: true, child: child));
  }

  @override
  Widget build(BuildContext context) {
    final body = LayoutBuilder(
        builder: (ctx, c) {
          if (c.maxWidth >= _wideBreakpoint) {
            final page = Scaffold(
              body: _route == NavRoute.chat
                  ? Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Sidebar(width: 240, background: Colors.transparent, selected: _route, onSelect: _select),
                        const Expanded(child: ChatPanel(width: double.infinity)),
                      ],
                    )
                  : Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Sidebar(width: 240, selected: _route, onSelect: _select),
                        Expanded(child: _wideContent()),
                      ],
                    ),
            );
            return _withPageShortcuts(_routeTheme(context, page));
          }
          // 窄屏
          final menu = IconButton(
            icon: const Icon(Icons.menu),
            tooltip: '打开导航',
            onPressed: () => _scaffoldKey.currentState?.openDrawer(),
          );
          final page = Scaffold(
            key: _scaffoldKey,
            drawer: Drawer(
              child: Sidebar(width: 280, selected: _route, onSelect: _select),
            ),
            body: _route == NavRoute.chat
                // 2026-11-07：手机对话也不放立绘（有桌宠就够了）
                ? ChatPanel(width: double.infinity, leading: menu)
                : RoutePageOverlay(
                    key: ValueKey('page-${_route.name}'),
                    child: RoutePage(route: _route, leading: menu),
                  ),
          );
          return _withPageShortcuts(_routeTheme(context, page));
        },
      );
    if (!chrome.supportsCustomChrome) return body;
    return WindowResizeEdges(child: Column(children: [const WindowTitleBar(), Expanded(child: body)]));
  }
}

/// 每个路由页独立的 Overlay：拖拽 feedback / Tooltip 都挂在页内。
/// 切页时 ValueKey 换掉，旧 Overlay 整个 dispose，不会把浮层带到新页面。
class RoutePageOverlay extends StatefulWidget {
  final Widget child;
  const RoutePageOverlay({super.key, required this.child});

  @override
  State<RoutePageOverlay> createState() => RoutePageOverlayState();
}

class RoutePageOverlayState extends State<RoutePageOverlay> {
  late final OverlayEntry _entry = OverlayEntry(builder: (_) => widget.child);

  @override
  void didUpdateWidget(covariant RoutePageOverlay oldWidget) {
    super.didUpdateWidget(oldWidget);
    _entry.markNeedsBuild();
  }

  @override
  Widget build(BuildContext context) => Overlay(initialEntries: [_entry]);
}
