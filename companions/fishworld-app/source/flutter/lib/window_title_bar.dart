import 'package:flutter/material.dart';

import 'fish/ui_kit/ui_kit.dart';
import 'theme/whale_tokens.dart';
import 'window_chrome_stub.dart' if (dart.library.io) 'window_chrome_io.dart' as chrome;

/// Windows 桌面版的一体化细头：只留窗口按钮，标题交给侧栏，去掉分隔线。
class WindowTitleBar extends StatefulWidget {
  const WindowTitleBar({super.key});
  @override
  State<WindowTitleBar> createState() => _WindowTitleBarState();
}

class _WindowTitleBarState extends State<WindowTitleBar> {
  bool _maximized = false;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final side = whaleSidebarSchemeFor(Theme.of(context).brightness);
    return Container(
        height: 52,
        width: MediaQuery.sizeOf(context).width,
        color: Theme.of(context).brightness == Brightness.dark ? WhaleTokens.chatBgStart : scheme.surface,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onPanStart: (_) => chrome.windowStartDrag(),
          onDoubleTap: () {
            chrome.windowToggleMaximize();
            setState(() => _maximized = !_maximized);
          },
          child: Row(children: [
            // 品牌并进标题栏：侧栏不再重复一行 logo，顶部空带消失。
            SizedBox(
              width: 240,
              child: Padding(
                padding: const EdgeInsets.only(left: 16),
                child: Row(children: [
                  Image.asset('assets/whale-logo.png', width: 26, height: 26),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text('大肥鱼',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: side.onSurface)),
                  ),
                ]),
              ),
            ),
            const Spacer(),
            _button(context, Icons.remove, '最小化', () => chrome.windowMinimize()),
            _button(context, _maximized ? Icons.filter_none : Icons.crop_square, _maximized ? '还原' : '最大化', () {
              chrome.windowToggleMaximize();
              setState(() => _maximized = !_maximized);
            }),
            _button(context, Icons.close, '关闭', () => chrome.windowClose(), close: true),
          ]),
        ),
      );
  }

  Widget _button(BuildContext context, IconData icon, String label, VoidCallback onTap, {bool close = false}) {
    final scheme = Theme.of(context).colorScheme;
    return SizedBox(
      width: 44,
      height: 51,
      child: TextButton(
        onPressed: onTap,
        style: TextButton.styleFrom(
          padding: EdgeInsets.zero,
          minimumSize: Size.zero,
          foregroundColor: scheme.onSurfaceVariant,
          shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
        ),
        child: FishTooltip(message: label, child: Icon(icon, size: 15)),
      ),
    );
  }
}

/// 无边框窗口的 6px 拖边热区（Flutter 层补，原生 hit-test 被子窗口吃掉）。
class WindowResizeEdges extends StatelessWidget {
  final Widget child;
  const WindowResizeEdges({super.key, required this.child});

  Widget _hit(MouseCursor cursor, String name) => MouseRegion(
        cursor: cursor,
        child: Listener(
          behavior: HitTestBehavior.opaque,
          onPointerDown: (_) => chrome.windowStartResize(name),
          child: const SizedBox.expand(),
        ),
      );

  @override
  Widget build(BuildContext context) {
    return Stack(children: [
      Positioned.fill(child: child),
      Positioned(left: 0, top: 0, bottom: 0, width: 6, child: _hit(SystemMouseCursors.resizeLeftRight, 'left')),
      Positioned(right: 0, top: 0, bottom: 0, width: 6, child: _hit(SystemMouseCursors.resizeLeftRight, 'right')),
      Positioned(top: 0, left: 0, right: 0, height: 6, child: _hit(SystemMouseCursors.resizeUpDown, 'top')),
      Positioned(bottom: 0, left: 0, right: 0, height: 6, child: _hit(SystemMouseCursors.resizeUpDown, 'bottom')),
      Positioned(top: 0, left: 0, width: 6, height: 6, child: _hit(SystemMouseCursors.resizeUpLeftDownRight, 'topLeft')),
      Positioned(top: 0, right: 0, width: 6, height: 6, child: _hit(SystemMouseCursors.resizeUpLeftDownRight, 'topRight')),
      Positioned(bottom: 0, left: 0, width: 6, height: 6, child: _hit(SystemMouseCursors.resizeUpLeftDownRight, 'bottomLeft')),
      Positioned(bottom: 0, right: 0, width: 6, height: 6, child: _hit(SystemMouseCursors.resizeUpLeftDownRight, 'bottomRight')),
    ]);
  }
}
