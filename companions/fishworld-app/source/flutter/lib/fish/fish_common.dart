import 'package:flutter/material.dart';

import '../bento.dart';
import '../data/fish_data.dart';
import '../fish_nav.dart';
import '../theme/whale_tokens.dart';

/// 「鱼的世界」共用件：卡片外框、空态、状态行、切页数据壳。

/// 默认布局版本：Bento 会按 boardId 记住用户拖过的尺寸；改默认排版就换一版。
const String fishLayoutRevision = 'layout-20261109-4';

/// 人设正文的一行摘要：跳过标题、分隔线、空行，取第一条真正的内容行。
///
/// ★ 为什么需要它：人设正文开头是「标题 + ════ 分隔线 + 空行」，
/// 把正文原样塞进小卡片，分隔线在浅色主题里看着就像一条空输入框的下划线
/// （用户报过「鱼的样子卡显示错乱」）。摘要只取**有内容的那一行**。
///
/// 判定顺序：
/// 1. 空行 → 跳
/// 2. 分隔线（整行只由 ═ ─ = - _ * · 空白 组成）→ 跳
/// 3. Markdown 标题（`#` 开头）→ 跳
/// 4. **setext 标题**：本行后面紧跟一条分隔线的，是「下划线式标题」→ 跳
///    （人设卡第一行「DeepSeek 小鲸鱼 · 角色卡」就是这种，它本身不带 #）
/// 5. 剩下的第一条 → 取用
///
/// 截断到 [maxChars] 个字符（按 runes 数，避免把中文/emoji 切坏）。
String personaSummaryLine(String text, {int maxChars = 60}) {
  if (text.trim().isEmpty) return '';
  final isRule = RegExp(r'^[\s═─=－\-_*·]+$');
  final lines = text.split('\n');
  for (var i = 0; i < lines.length; i++) {
    final line = lines[i].trim();
    if (line.isEmpty) continue;
    if (isRule.hasMatch(line)) continue;
    if (line.startsWith('#')) continue;
    // setext 标题：后面紧跟分隔线 ⇒ 这一行是标题，不是内容。
    final next = _nextNonEmpty(lines, i + 1);
    if (next != null && isRule.hasMatch(next)) continue;
    final runes = line.runes.toList();
    if (runes.length <= maxChars) return line;
    return String.fromCharCodes(runes.take(maxChars)) + '…';
  }
  return '';
}

/// 找下一行非空（去掉首尾空白）。没有就返回 null。
String? _nextNonEmpty(List<String> lines, int from) {
  for (var i = from; i < lines.length; i++) {
    final t = lines[i].trim();
    if (t.isNotEmpty) return t;
  }
  return null;
}

/// 数据壳：FutureBuilder + 只读提示 + 卡片流。加载 / 读取失败 / 空数据都由这里兜底。
class FishPageLayout extends StatelessWidget {
  final String pageKey;
  final Future<FishSnapshot> future;
  final List<Widget> Function(BuildContext context, FishSnapshot data)
      buildCards;
  final List<Widget> Function(BuildContext context, FishSnapshot data)?
      buildFooter;
  final List<Widget> Function(BuildContext context)? buildLoading;

  final bool fluid;

  const FishPageLayout({
    super.key,
    required this.pageKey,
    required this.future,
    required this.buildCards,
    this.buildFooter,
    this.buildLoading,
    this.fluid = true,
  });

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<FishSnapshot>(
      future: future,
      builder: (ctx, snap) {
        final waiting = snap.connectionState != ConnectionState.done;
        final data = snap.data ?? FishSnapshot.empty();
        if (waiting) {
          final cards = buildLoading?.call(context) ??
              [FishLoadingCard(id: '$pageKey-loading')];
          return fishPageBody(context,
              boardId: '$pageKey-loading', fluid: fluid, cards: cards);
        }
        if (snap.hasError) {
          final cards = [
            FishCard(
              id: '$pageKey-error',
              title: '读取失败',
              width: 460,
              height: 140,
              child: FishScrollText(
                text: '${snap.error}',
                emptyText: '读不到这一页的数据。',
              ),
            ),
          ];
          return fishPageBody(context,
              boardId: pageKey, fluid: fluid, cards: cards);
        }
        final footer = buildFooter?.call(ctx, data) ?? const <Widget>[];
        return fishPageBody(context,
            boardId: pageKey,
            fluid: fluid,
            cards: buildCards(ctx, data),
            footer: footer);
      },
    );
  }
}

/// 页面体：只读提示在最上面，卡片按 bentoWrap 的间距流动；窄屏自动单列。
Widget fishPageBody(
  BuildContext context, {
  required List<Widget> cards,
  List<Widget> footer = const [],
  String boardId = 'fish',
  bool fluid = true,
}) {
  return SingleChildScrollView(
    // 底部留出 DSH 悬浮徽章的安全区，滚到底也不会压在卡片文字上。
    padding: const EdgeInsets.fromLTRB(WhaleTokens.pageGutter,
        WhaleTokens.pageGutter, WhaleTokens.pageGutter, 104),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        BentoBoard(
          boardId: '$boardId-$fishLayoutRevision',
          fluid: fluid,
          items: [
            for (final c in cards)
              if (c is FishCard)
                BentoItem(
                    id: c.id,
                    width: c.width,
                    height: c.height,
                    maxHeight: c.maxHeight,
                    resizable: c.resizable,
                    child: c.buildPanel())
              else
                BentoItem(
                    id: 'x${cards.indexOf(c)}',
                    width: 460,
                    height: 150,
                    child: c),
          ],
        ),
        if (footer.isNotEmpty) ...[
          const SizedBox(height: 12),
          ...footer,
        ],
      ],
    ),
  );
}

class FishCard extends StatelessWidget {
  final String id;
  final String title;
  final String? note;
  final double width;
  final double height;
  final double maxHeight;
  final bool resizable;
  /// 可选：把这张卡注册成 FishNav 锚点（切页 → 滚到它 → 闪一下）。
  ///
  /// ★ 为什么做在内部而不是外面包一层 FishAnchor：`fishPageBody` 靠
  /// `c is FishCard` 认卡并取它的 width/height；外面包一层就换了类型，
  /// 会掉进 else 分支被按 460×150 布局（实测：1400 宽的卡塞进 460，
  /// RenderFlex 溢出 203px，把「鱼的世界九页都能渲染」打成红）。
  /// 所以锚点必须长在 FishCard 自己身上，类型不能变。
  final String? anchor;
  final Widget child;

  const FishCard({
    super.key,
    required this.id,
    required this.title,
    this.note,
    required this.width,
    required this.height,
    this.maxHeight = kCardMaxHeight,
    this.resizable = true,
    this.anchor,
    required this.child,
  });

  /// 供 BentoBoard 复用：面板本体（标题/副标/正文），尺寸交给便当格。
  Widget buildPanel() {
    final panel = BentoPanel(title: title, note: note, child: child);
    final a = anchor?.trim() ?? '';
    if (a.isEmpty) return panel;
    return FishAnchor(anchor: a, child: panel);
  }

  @override
  Widget build(BuildContext context) {
    return SizedBentoCard(
      id: id,
      defaultWidth: width,
      defaultHeight: height,
      maxHeight: maxHeight,
      resizable: resizable,
      child: buildPanel(),
    );
  }
}

/// 鱼的头像：优先角色图，没有就走默认 assets/avatar.png。
class FishAvatar extends StatelessWidget {
  final FishProfile profile;
  final double size;
  final bool fadeLeft;
  const FishAvatar(
      {super.key, required this.profile, this.size = 64, this.fadeLeft = true});

  @override
  Widget build(BuildContext context) => CircleAvatar(
        radius: size / 2,
        backgroundColor: Theme.of(context).colorScheme.primaryContainer,
        backgroundImage: const AssetImage('assets/avatar.png'),
        onBackgroundImageError: (_, __) {},
      );
}

class FishLoadingCard extends StatelessWidget {
  final String id;
  const FishLoadingCard({super.key, required this.id});

  @override
  Widget build(BuildContext context) {
    return FishCard(
      id: id,
      title: '读取中…',
      width: 320,
      height: 140,
      child: const Center(
        child: SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(strokeWidth: 2)),
      ),
    );
  }
}

/// 定高卡片里的正文：可滚动；空文本给一句有意义的空态。
class FishScrollText extends StatelessWidget {
  final String text;
  final String emptyText;
  final int? maxLines;
  final double lineHeight;

  const FishScrollText({
    super.key,
    required this.text,
    this.emptyText = '暂无数据',
    this.maxLines,
    this.lineHeight = 1.7,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    if (text.trim().isEmpty) return FishEmpty(text: emptyText);
    return SingleChildScrollView(
      child: Text(
        text,
        style: TextStyle(
            fontSize: WhaleTokens.fsBody,
            height: lineHeight,
            color: scheme.onSurface),
        maxLines: maxLines,
        overflow: maxLines == null ? null : TextOverflow.ellipsis,
      ),
    );
  }
}

/// 定高卡片里的列表：可滚动，行与行之间靠留白分层。
class FishScrollList extends StatelessWidget {
  final List<Widget> children;
  const FishScrollList({super.key, required this.children});

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
    );
  }
}

/// 统一的空态：灰阶一句话，不用笑脸或彩色插画。
class FishEmpty extends StatelessWidget {
  final String text;
  const FishEmpty({super.key, required this.text});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.topLeft,
      child: Text(
        text,
        style: TextStyle(
            fontSize: WhaleTokens.fsSmall,
            height: 1.6,
            color: scheme.onSurfaceVariant),
      ),
    );
  }
}

/// 两端对齐的状态行：左边标签（可带小字说明），右边值。
class FishRow extends StatelessWidget {
  final String label;
  final String value;
  final String? hint;

  const FishRow(
      {super.key, required this.label, required this.value, this.hint});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final sub = hint ?? '';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            flex: 3,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: TextStyle(
                      fontSize: WhaleTokens.fsBody, color: scheme.onSurface),
                ),
                if (sub.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      sub,
                      style: TextStyle(
                        fontSize: WhaleTokens.fsCaption,
                        height: 1.5,
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Flexible(
            flex: 2,
            child: Text(
              value,
              textAlign: TextAlign.right,
              style: TextStyle(
                  fontSize: WhaleTokens.fsBody, color: scheme.onSurfaceVariant),
            ),
          ),
        ],
      ),
    );
  }
}

/// 小分区标题（定高卡里分两段时用）。
class FishSubTitle extends StatelessWidget {
  final String text;
  final String? note;
  const FishSubTitle({super.key, required this.text, this.note});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: 6, bottom: 4),
      child: Row(
        children: [
          Text(
            text,
            style: TextStyle(
              fontSize: WhaleTokens.fsLabel,
              fontWeight: FontWeight.w600,
              color: scheme.onSurface,
            ),
          ),
          const Spacer(),
          if (note != null && note!.isNotEmpty)
            Text(note!,
                style: TextStyle(
                    fontSize: WhaleTokens.fsSmall,
                    color: scheme.onSurfaceVariant)),
        ],
      ),
    );
  }
}

/// 指标块：大数字 + 说明，放在迷你卡里。
/// 用可滚动外壳包住，窄卡片（手机宽度）也不会顶出 ripple 区域。
class FishStat extends StatelessWidget {
  final String value;
  final String sub;
  const FishStat({super.key, required this.value, required this.sub});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
                fontSize: WhaleTokens.fsPage,
                fontWeight: FontWeight.w700,
                color: scheme.primary),
          ),
          const SizedBox(height: 4),
          Text(
            sub,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
                fontSize: WhaleTokens.fsSmall,
                height: 1.5,
                color: scheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}

/// 页脚：一行灰色说明。
class FishFooterLine extends StatelessWidget {
  final String text;
  const FishFooterLine({super.key, required this.text});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(left: 2, right: 2),
      child: Text(
        text,
        style: TextStyle(
            fontSize: WhaleTokens.fsSmall,
            height: 1.6,
            color: scheme.onSurfaceVariant),
      ),
    );
  }
}
