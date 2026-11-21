import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'theme/whale_tokens.dart';
import 'feedback.dart';
import 'avatar_tap.dart';

enum NavRoute {
  chat,
  notes,
  overview,
  diary,
  wish,
  growth,
  memory, // 鱼的世界（第 1 排）
  status,
  collections,
  profile,
  platforms, // 鱼的世界（第 2 排）
  qq, // 旧深链别名 ⇒ 鱼与世界（只 QQ）
  gallery,
  links, // 旧深链别名 ⇒ 都落到鱼的收藏
  settings,
  about, // 配置
  // 音乐、外观 已按指令移除
}

class NavItem {
  final NavRoute route;
  final IconData icon;
  final String label;
  const NavItem(this.route, this.icon, this.label);
}

class NavGroup {
  final String title;
  final List<NavItem> items;
  const NavGroup(this.title, this.items);
}

const List<NavGroup> _navGroups = [
  NavGroup('对话', [
    NavItem(NavRoute.chat, Icons.chat_bubble_outline, '对话'),
  ]),
  NavGroup('总览', [
    NavItem(NavRoute.overview, Icons.space_dashboard_outlined, '总览'),
  ]),
  NavGroup('内容', [
    NavItem(NavRoute.notes, Icons.note_alt_outlined, '鱼的笔记'),
    NavItem(NavRoute.diary, Icons.book_outlined, '鱼的日记'),
    NavItem(NavRoute.wish, Icons.star_outline, '鱼的请求'),
    NavItem(NavRoute.growth, Icons.trending_up_outlined, '鱼的成长'),
    NavItem(NavRoute.memory, Icons.psychology_outlined, '鱼的记忆'),
    NavItem(NavRoute.status, Icons.favorite_outline, '鱼的状态'),
    NavItem(NavRoute.collections, Icons.collections_bookmark_outlined, '鱼的收藏'),
  ]),
  NavGroup('系统', [
    NavItem(NavRoute.profile, Icons.badge_outlined, '鱼的设定'),
    NavItem(NavRoute.platforms, Icons.public_outlined, '鱼与世界'),
    NavItem(NavRoute.settings, Icons.settings_outlined, '设置'),
  ]),
  NavGroup('关于', [
    NavItem(NavRoute.about, Icons.info_outline, '关于'),
  ]),
];

class Sidebar extends StatefulWidget {
  final double width;
  final Color? background;
  final NavRoute selected;
  final ValueChanged<NavRoute>? onSelect;
  const Sidebar({
    super.key,
    this.width = 240,
    this.background,
    this.selected = NavRoute.chat,
    this.onSelect,
  });

  @override
  State<Sidebar> createState() => _SidebarState();
}

class _SidebarState extends State<Sidebar> {
  // ★ 独立滚动控制器：手机端多个竖向滚动区共用 PrimaryScrollController 会报
  //   "attached to more than one ScrollPosition"，所以每个列表各管各的。
  final _scrollCtl = ScrollController();

  @override
  void dispose() {
    _scrollCtl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final scheme = whaleSidebarSchemeFor(brightness);
    return Container(
      width: widget.width,
      color: widget.background ?? scheme.surface,
      child: Column(
        children: [
          Expanded(
            child: ListView(
              controller: _scrollCtl,
              primary: false,
              padding: const EdgeInsets.symmetric(vertical: 8),
              children: [
                for (var gi = 0; gi < _navGroups.length; gi++) ...[
                  if (gi > 0) const SizedBox(height: 14) else const SizedBox(height: 4),
                  if (_navGroups[gi].title.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(14, 0, 14, 6),
                      // 2026-11-15：分组标题原来 10px + onSurfaceVariant@55%（实测对比度约 2.9:1），
                      // 深色下基本糊成一团，主人说「这些字段不显示」。按 ui/AGENTS.md 的可读性下限
                      // 收到 12px + 全量 onSurfaceVariant（约 6.9:1），中文也不再吃 1.2 的字距。
                      child: Text(_navGroups[gi].title,
                          style: TextStyle(
                              fontSize: WhaleTokens.fsCaption,
                              fontWeight: FontWeight.w500,
                              letterSpacing: 0.4,
                              color: scheme.onSurfaceVariant)),
                    ),
                  for (final it in _navGroups[gi].items)
                    SidebarItem(
                      key: ValueKey('nav-' + it.label),
                      item: it,
                      selected: widget.selected == it.route,
                      onTap: widget.onSelect == null
                          ? null
                          : () => widget.onSelect!(it.route),
                    ),
                ],
              ],
            ),
          ),
          const _SidebarFooter(),
        ],
      ),
    );
  }
}

class SidebarItem extends StatefulWidget {
  final NavItem item;
  final bool selected;
  final VoidCallback? onTap;
  const SidebarItem(
      {super.key, required this.item, this.selected = false, this.onTap});

  @override
  State<SidebarItem> createState() => _SidebarItemState();
}

class _SidebarItemState extends State<SidebarItem> {
  bool _hover = false;
  bool _focused = false;

  @override
  Widget build(BuildContext context) {
    final scheme = whaleSidebarSchemeFor(Theme.of(context).brightness);
    final selected = widget.selected;
    // 选中态轻量化（2026-11-09）：去掉整块浅底，只留左侧 2px 细蓝条 + 文字加粗；
    // hover 仍是极浅提亮。都禁位移（notion-style 口径）。
    final bg = _hover && !selected
        ? scheme.onSurface.withValues(alpha: 0.05)
        : Colors.transparent;
    final fg = selected ? scheme.primary : scheme.onSurface;

    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
        decoration: BoxDecoration(
            color: bg,
            borderRadius: BorderRadius.circular(WhaleTokens.rMd),
            border: _focused ? Border.all(color: scheme.primary.withValues(alpha: .55)) : null),
        child: FocusableActionDetector(
          child: InkWell(
            onFocusChange: (v) => setState(() => _focused = v),
            focusColor: scheme.primary.withValues(alpha: .10),
            onTap: widget.onTap == null
                ? null
                : () {
                    sayFeedbackAsync('打开页面',
                        detail: widget.item.label,
                        fallback: '打开「${widget.item.label}」啦');
                    widget.onTap!();
                  },
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 7),
              child: Row(children: [
                AnimatedContainer(
                  duration: const Duration(milliseconds: 150),
                  width: 2,
                  height: 16,
                  decoration: BoxDecoration(
                    color: selected ? scheme.primary : Colors.transparent,
                    borderRadius: BorderRadius.circular(1),
                  ),
                ),
                const SizedBox(width: 8),
                Icon(widget.item.icon, size: 16, color: fg),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(widget.item.label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          color: fg,
                          fontSize: WhaleTokens.fsLabel,
                          fontWeight: selected
                              ? FontWeight.w600
                              : FontWeight.w400)),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}


class _SidebarFooter extends StatefulWidget {
  const _SidebarFooter();
  @override
  State<_SidebarFooter> createState() => _SidebarFooterState();
}

class _SidebarFooterState extends State<_SidebarFooter> {
  String? _bubble;
  int _seen = 0;
  Timer? _hide;
  bool _hover = false;

  @override
  void initState() {
    super.initState();
    feedbackTick.addListener(_onTick);
    // 首帧后再看（欢迎语通常在 init 里发）
    WidgetsBinding.instance.addPostFrameCallback((_) => _onTick());
  }

  void _onTick() {
    if (feedbackTick.value == _seen) return;
    _seen = feedbackTick.value;
    final t = lastFeedback;
    if (t.isEmpty) return;
    setState(() => _bubble = t);
    _hide?.cancel();
    _hide = Timer(const Duration(milliseconds: 5000), () {
      if (mounted) setState(() => _bubble = null);
    });
  }

  @override
  void dispose() {
    feedbackTick.removeListener(_onTick);
    _hide?.cancel();
    super.dispose();
  }

  // 2026-11-15：点一下气泡就收掉（主人要求）。原来 5 秒自动消失、且 IgnorePointer
  // 让点击穿过去，想关也关不了。
  void _dismiss() {
    _hide?.cancel();
    if (mounted) setState(() => _bubble = null);
  }

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final scheme = whaleSidebarSchemeFor(brightness);
    return Stack(clipBehavior: Clip.none, children: [
      MouseRegion(
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 150),
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
          decoration: BoxDecoration(
            color: _hover
                ? scheme.onSurface.withValues(alpha: 0.04)
                : Colors.transparent,
            border: Border(top: BorderSide(color: scheme.outlineVariant)),
          ),
          child: Row(children: [
            const AvatarTap(radius: 16, padding: 0),
            const SizedBox(width: 10),
            Expanded(
              child: Text('蓝鲸娘',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: scheme.onSurface)),
            ),
          ]),
        ),
      ),
      Positioned(
        left: 16,
        right: 16,
        bottom: 72,
        // 气泡没内容时不参与命中；有内容时点一下就关。
        child: IgnorePointer(
          ignoring: _bubble == null,
          child: AnimatedOpacity(
            opacity: _bubble == null ? 0 : 1,
            duration: const Duration(milliseconds: 160),
            child: Align(
              alignment: Alignment.centerLeft,
              child: MouseRegion(
                cursor: SystemMouseCursors.click,
                child: GestureDetector(
                  onTap: _dismiss,
                  behavior: HitTestBehavior.opaque,
                  child: Stack(clipBehavior: Clip.none, children: [
                    Container(
                      padding:
                          const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      decoration: BoxDecoration(
                        color: WhaleTokens.tooltipBgFor(brightness),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: WhaleTokens.tooltipBorderFor(brightness)),
                        boxShadow: WhaleTokens.tooltipShadowFor(brightness),
                      ),
                      child: Text(_bubble ?? '',
                          style: TextStyle(
                              fontSize: WhaleTokens.fsSmall,
                              height: 1.3,
                              color: WhaleTokens.tooltipFgFor(brightness))),
                    ),
                    // 小箭头：指向下方的身份铭牌（现代 tooltip 口径）
                    Positioned(
                      left: 16,
                      bottom: -4,
                      child: Transform.rotate(
                        angle: math.pi / 4,
                        child: Container(
                          width: 8,
                          height: 8,
                          decoration: BoxDecoration(
                            color: WhaleTokens.tooltipBgFor(brightness),
                            border: Border.all(color: WhaleTokens.tooltipBorderFor(brightness)),
                            borderRadius: BorderRadius.circular(1.5),
                          ),
                        ),
                      ),
                    ),
                  ]),
                ),
              ),
            ),
          ),
        ),
      ),
    ]);
  }
}
