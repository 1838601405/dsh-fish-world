import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../theme/whale_tokens.dart';

/// 鱼的世界 · 通用 UI 组件（唯一实现处）。
/// 规则：页面只组装，不各写一套状态条 / 开关 / 空态 / tooltip / 卡片。
/// 任何组件都不许在页面里复制；新需求先加到这里。

enum FishStatusKind { ok, error, idle, busy }

enum FishActionKind { openUrl, launch, gotoPage, retry }

@immutable
class FishAction {
  final String label;
  final FishActionKind kind;
  final VoidCallback handler;
  const FishAction({required this.label, required this.kind, required this.handler});
}

/// 状态 → 颜色：ok 绿、error 红、idle/busy 灰（语义色只做状态反馈，禁填充块）。
Color fishStatusTone(BuildContext context, FishStatusKind kind) {
  final scheme = Theme.of(context).colorScheme;
  switch (kind) {
    case FishStatusKind.ok:
      return WhaleTokens.successFor(scheme.brightness);
    case FishStatusKind.error:
      return scheme.error;
    case FishStatusKind.idle:
    case FishStatusKind.busy:
      return scheme.onSurfaceVariant;
  }
}

/// 强制契约：状态条必须带一个可执行的下一步。
class FishStatusAction extends StatelessWidget {
  final FishStatusKind status;
  final String message;
  final FishAction action;
  const FishStatusAction({super.key, required this.status, required this.message, required this.action});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final tone = fishStatusTone(context, status);
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(WhaleTokens.rMd),
        border: Border.all(color: tone.withValues(alpha: .45)),
      ),
      child: Row(children: [
        if (status == FishStatusKind.busy)
          SizedBox(width: 13, height: 13, child: CircularProgressIndicator(strokeWidth: 1.6, color: tone))
        else
          Icon(status == FishStatusKind.ok ? Icons.check_circle_outline : (status == FishStatusKind.error ? Icons.error_outline : Icons.info_outline), size: 14, color: tone),
        const SizedBox(width: 7),
        Expanded(child: Text(message, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, color: tone))),
        const SizedBox(width: 8),
        FishActionButton(action: action),
      ]),
    );
  }
}

/// 状态条 / 页头共用的动作按钮（不是胶囊，1px 描边）。
class FishActionButton extends StatelessWidget {
  final FishAction action;
  const FishActionButton({super.key, required this.action});
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return TextButton(
      onPressed: action.handler,
      style: TextButton.styleFrom(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        minimumSize: Size.zero,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(WhaleTokens.rSm),
          side: BorderSide(color: scheme.outlineVariant),
        ),
      ),
      child: Text(action.label, style: TextStyle(fontSize: 12, color: scheme.onSurface)),
    );
  }
}

/// 全站唯一 tooltip 封装：延迟、停留、销毁条件都只在这里定义。
class FishTooltip extends StatelessWidget {
  final String message;
  final Widget child;
  const FishTooltip({super.key, required this.message, required this.child});
  @override
  Widget build(BuildContext context) {
    if (message.isEmpty) return child;
    return Tooltip(
      message: message,
      waitDuration: const Duration(milliseconds: 420),
      exitDuration: const Duration(milliseconds: 80),
      child: child,
    );
  }
}

/// 蓝轨道 + 白把手 + 无边框。危险项不染红，靠「外发」chip。
/// P9：键盘可达——Tab 聚焦、Enter/Space 切换、可见 2px focus 环。
class FishSwitch extends StatefulWidget {
  final bool value;
  final bool danger;
  final ValueChanged<bool>? onChanged;
  const FishSwitch({super.key, required this.value, this.danger = false, this.onChanged});

  @override
  State<FishSwitch> createState() => _FishSwitchState();
}

class _FishSwitchState extends State<FishSwitch> {
  bool _focused = false;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final enabled = widget.onChanged != null;
    final toggle = enabled ? () => widget.onChanged!(!widget.value) : null;
    return Semantics(
      label: widget.danger ? '外发开关' : '开关',
      toggled: widget.value,
      button: true,
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Focus(
          canRequestFocus: enabled,
          onFocusChange: (v) => setState(() => _focused = v),
          onKeyEvent: (node, e) {
            if (e is KeyDownEvent && FishKeys.isActivate(e) && toggle != null) {
              toggle();
              return KeyEventResult.handled;
            }
            return KeyEventResult.ignored;
          },
          child: MouseRegion(
            cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
            child: GestureDetector(
              onTap: toggle,
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 150),
                width: 44,
                height: 24,
                padding: const EdgeInsets.all(2),
                decoration: BoxDecoration(
                  color: widget.value ? scheme.primary : scheme.outlineVariant,
                  borderRadius: BorderRadius.circular(12),
                  border: _focused ? Border.all(color: scheme.primary, width: 2) : null,
                  boxShadow: _focused
                      ? [BoxShadow(color: scheme.primary.withValues(alpha: .28), blurRadius: 0, spreadRadius: 3)]
                      : null,
                ),
                child: AnimatedAlign(
                  duration: const Duration(milliseconds: 150),
                  curve: Curves.easeOut,
                  alignment: widget.value ? Alignment.centerRight : Alignment.centerLeft,
                  child: Container(
                    width: 18,
                    height: 18,
                    decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle),
                  ),
                ),
              ),
            ),
          ),
        ),
        if (widget.danger) Padding(
          padding: const EdgeInsets.only(left: 6),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
            decoration: BoxDecoration(
              border: Border.all(color: scheme.onSurfaceVariant.withValues(alpha: .6)),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Text('外发', style: TextStyle(fontSize: 9, color: scheme.onSurfaceVariant)),
          ),
        ),
      ]),
    );
  }
}

enum FishCardLevel { outer, inset }

/// 两层卡：outer=surface+border+r8；inset=inset 色+无边框+r12。
class FishUiCard extends StatelessWidget {
  final FishCardLevel level;
  final String? title;
  final String? note;
  final Widget child;
  final double? width;
  final double? height;
  /// 卡片放在固定高度容器里时，把正文撑满剩余高度。
  final bool expandChild;
  const FishUiCard({super.key, this.level = FishCardLevel.outer, this.title, this.note, required this.child, this.width, this.height, this.expandChild = false});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final inset = level == FishCardLevel.inset;
    final body = Container(
      padding: EdgeInsets.fromLTRB(inset ? 14 : 16, inset ? 12 : 14, inset ? 14 : 16, inset ? 12 : 14),
      decoration: BoxDecoration(
        color: inset ? scheme.onSurface.withValues(alpha: .05) : scheme.surface,
        borderRadius: BorderRadius.circular(inset ? WhaleTokens.rXl : WhaleTokens.rMd),
        border: inset ? null : Border.all(color: scheme.outlineVariant),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        if (title != null && title!.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Row(children: [
              Expanded(child: Text(title!, style: TextStyle(fontSize: WhaleTokens.fsSub, fontWeight: FontWeight.w600, color: scheme.onSurface))),
              if (note != null && note!.isNotEmpty) Text(note!, style: TextStyle(fontSize: WhaleTokens.fsCaption, color: scheme.onSurfaceVariant)),
            ]),
          ),
        if (expandChild) Expanded(child: child) else child,
      ]),
    );
    if (width == null && height == null) return body;
    return SizedBox(width: width, height: height, child: body);
  }
}

/// 空态：灰阶图标 + 一句可操作指引；无 action 时只做中性陈述。
class FishEmpty extends StatelessWidget {
  final String text;
  final FishAction? action;
  final IconData icon;
  const FishEmpty({super.key, required this.text, this.action, this.icon = Icons.inbox_outlined});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 18),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 22, color: scheme.onSurfaceVariant.withValues(alpha: .55)),
        const SizedBox(height: 8),
        Text(text, textAlign: TextAlign.center, style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurfaceVariant)),
        if (action != null) Padding(padding: const EdgeInsets.only(top: 10), child: FishActionButton(action: action!)),
      ]),
    );
  }
}

class FishWriteOutcome {
  final bool ok;
  final String message;
  const FishWriteOutcome(this.ok, this.message);
}

/// 写操作统一入口：写 → 回读 → 不一致回滚 → 返回可展示结果。
/// 备份与留痕由后端（personaStore / world.appendSecurity）负责，前端只保证读回一致。
class FishWrite {
  static Future<FishWriteOutcome> run({
    required Future<Map<String, dynamic>?> Function() write,
    required Future<Map<String, dynamic>?> Function() readBack,
    bool Function(Map<String, dynamic>? read)? verify,
    Future<void> Function()? rollback,
    String label = '保存',
  }) async {
    Map<String, dynamic>? w;
    try {
      w = await write();
    } catch (e) {
      return FishWriteOutcome(false, label + '失败：' + e.toString());
    }
    if (w == null) return FishWriteOutcome(false, label + '失败：没连上主程序');
    if (w['ok'] != true) return FishWriteOutcome(false, label + '失败：' + (w['error'] ?? '未知错误').toString());
    final read = await readBack();
    final ok = verify == null ? read != null : verify(read);
    if (!ok) {
      if (rollback != null) {
        try { await rollback(); } catch (_) {}
        return FishWriteOutcome(false, label + '后回读不一致，已回滚');
      }
      return FishWriteOutcome(false, label + '后回读不一致');
    }
    return FishWriteOutcome(true, label + '成功（回读校验通过）');
  }
}

/// 键盘等价：Enter / Space 触发；页面只声明动作，不各写键位。
class FishKeys {
  static bool isActivate(KeyEvent e) =>
      e is KeyDownEvent &&
      (e.logicalKey == LogicalKeyboardKey.enter ||
          e.logicalKey == LogicalKeyboardKey.space);

  static Widget onActivate({required VoidCallback onActivate, required Widget child}) => Focus(
        onKeyEvent: (node, e) {
          if (isActivate(e)) {
            onActivate();
            return KeyEventResult.handled;
          }
          if (e is KeyDownEvent && e.logicalKey == LogicalKeyboardKey.escape) {
            node.unfocus();
            return KeyEventResult.handled;
          }
          return KeyEventResult.ignored;
        },
        child: child,
      );
}

/// 三级文字：标题 / 正文 / 说明。正文必须 onSurface，说明才用 onSurfaceVariant。
enum FishTextKind { title, body, aux }

class FishText extends StatelessWidget {
  final String text;
  final FishTextKind kind;
  final int? maxLines;
  final TextOverflow overflow;
  const FishText(this.text, {super.key, this.kind = FishTextKind.body, this.maxLines, this.overflow = TextOverflow.ellipsis});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final (size, color, weight) = switch (kind) {
      FishTextKind.title => (WhaleTokens.fsTitle, scheme.onSurface, FontWeight.w600),
      FishTextKind.body => (WhaleTokens.fsBody, scheme.onSurface, FontWeight.w400),
      FishTextKind.aux => (WhaleTokens.fsSmall, scheme.onSurfaceVariant, FontWeight.w400),
    };
    return Text(text, maxLines: maxLines, overflow: overflow, style: TextStyle(fontSize: size, color: color, fontWeight: weight, height: 1.45));
  }
}

/// 全站唯一页头：固定 48 高、16 左右、16 号标题、无底边线。
class FishPageHeader extends StatelessWidget {
  final IconData? icon;
  final Widget? leading;
  final String title;
  final Widget? trailing;
  const FishPageHeader({super.key, this.icon, this.leading, required this.title, this.trailing});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SizedBox(
      height: 48,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: WhaleTokens.pageGutter),
        child: Row(children: [
          if (leading != null) ...[leading!, const SizedBox(width: 8)],
          if (icon != null) ...[Icon(icon, size: 16, color: scheme.onSurfaceVariant), const SizedBox(width: 8)],
          Text(title, style: TextStyle(fontSize: WhaleTokens.fsTitle, fontWeight: FontWeight.w600, color: scheme.onSurface)),
          const Spacer(),
          if (trailing != null) trailing!,
        ]),
      ),
    );
  }
}
