import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../data/bridge.dart';
import '../data/fish_data.dart';
import '../data/gallery_image_common.dart';
import '../theme/whale_tokens.dart';
import 'fish_common.dart';
// ignore_for_file: prefer_interpolation_to_compose_strings

/// 鱼的收藏：图片收藏 + 链接收藏。只读，图片可移入回收站。
class FishCollectionsPage extends StatefulWidget {
  const FishCollectionsPage({super.key});

  @override
  State<FishCollectionsPage> createState() => _FishCollectionsPageState();
}

class _FishCollectionsPageState extends State<FishCollectionsPage> {
  Future<FishSnapshot> _future = FishWorld.load();
  final Set<String> _removed = <String>{};

  void _reload() { setState(() => _future = FishWorld.reload()); }

  Future<void> _remove(String name, List<String> roots) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('移入回收站？'),
        content: Text(name + '\n会移到图库下的 回收站 目录，不硬删。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('算了')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('移入回收站')),
        ],
      ),
    );
    if (ok != true) return;
    final r = await galleryRemove(name, roots);
    if (!mounted) return;
    if (r != null && r['ok'] == true) {
      final recycled = (r['recycled'] ?? '').toString();
      _removed.add(name);
      _reload();
      final msg = SnackBar(
        content: const Text('已移到回收站，可撤销'),
        duration: const Duration(seconds: 6),
        action: (galleryCanUndo && recycled.isNotEmpty)
            ? SnackBarAction(
                label: '撤销',
                onPressed: () async {
                  final u = await galleryUndo(recycled, name);
                  if (u != null && u['ok'] == true) _removed.remove(name);
                  _reload();
                  if (!mounted) return;
                  ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(
                    content: Text(u != null && u['ok'] == true ? '已撤销，图回到图库' : '撤销失败：' + ((u?['error'] ?? '未知错误').toString())),
                  ));
                },
              )
            : null,
      );
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(msg);
    } else {
      final err = (r?['error'] ?? '未知错误').toString();
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text('没移成：' + err), backgroundColor: Theme.of(context).colorScheme.errorContainer));
    }
  }

  @override
  Widget build(BuildContext context) {
    return FishPageLayout(
      pageKey: 'collections',
      future: _future,
      buildCards: _cards,
      buildLoading: _loadingCards,
    );
  }

  Widget _sk(BuildContext context, double h) => Container(
        height: h,
        decoration: BoxDecoration(color: Theme.of(context).colorScheme.outlineVariant.withValues(alpha: .22), borderRadius: BorderRadius.circular(8)),
      );

  List<Widget> _loadingCards(BuildContext context) => [
        FishCard(
          id: 'col-loading',
          title: '图片收藏',
          note: '读取中',
          width: 1400,
          height: 620,
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            _sk(context, 34),
            const SizedBox(height: 8),
            Row(children: [for (var i = 0; i < 4; i++) ...[Expanded(child: _sk(context, 26)), const SizedBox(width: 6)]]),
            const SizedBox(height: 10),
            Expanded(
              child: GridView.count(
                crossAxisCount: 4,
                mainAxisSpacing: 8,
                crossAxisSpacing: 8,
                childAspectRatio: 0.8,
                physics: const NeverScrollableScrollPhysics(),
                children: [for (var i = 0; i < 8; i++) _sk(context, 120)],
              ),
            ),
          ]),
        ),
      ];

  List<Widget> _cards(BuildContext context, FishSnapshot data) {
    if (!data.ok) {
      return [_empty('还没读到鱼的收藏。确认桌面端在跑，或先导出快照。')];
    }
    final gallery = data.gallery;
    final links = data.links;
    final visibleGallery = gallery.items.where((it) => !_removed.contains(it.name)).toList();
    final galleryTotal = visibleGallery.length;
    final scheme = Theme.of(context).colorScheme;
    return [
      FishCard(
        id: 'col-gallery',
        title: '图片收藏',
        note: '共 ' + galleryTotal.toString() + ' 张 · 这里显示 ' + visibleGallery.length.toString() + ' 张',
        width: 1400,
        height: 620,
        child: visibleGallery.isEmpty
            ? const FishEmpty(text: '图库还是空的。')
            : _GalleryGrid(items: visibleGallery, total: galleryTotal, roots: data.roots, onRemove: (name) => _remove(name, data.roots), onChanged: _reload),
      ),
      FishCard(
        id: 'col-stat',
        title: '鱼的收藏',
        note: '可编辑',
        width: 340,
        height: 220,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          FishStat(
            value: galleryTotal.toString(),
            sub: '张图片 · ' + links.total.toString() + ' 条链接',
          ),
          const Spacer(),
          Text('图片走本地图库；改名 / 标签会写回索引并留痕。', style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurfaceVariant)),
        ]),
      ),
      FishCard(
        id: 'col-links',
        title: '链接收藏',
        note: links.total.toString() + ' 条 · 这里显示 ' + links.items.length.toString() + ' 条',
        width: 700,
        height: 220,
        child: links.items.isEmpty
            ? const FishEmpty(text: '还没有收藏的链接。')
            : FishScrollList(
                children: [
                  for (final item in links.items)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            item.name.isEmpty ? item.url : item.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: WhaleTokens.fsBody, color: scheme.onSurface, fontWeight: FontWeight.w600),
                          ),
                          if (item.url.isNotEmpty)
                            Text(
                              item.url,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(fontSize: WhaleTokens.fsCaption, color: scheme.primary),
                            ),
                          if (item.note.isNotEmpty)
                            Text(
                              item.note,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(fontSize: WhaleTokens.fsSmall, height: 1.5, color: scheme.onSurfaceVariant),
                            ),
                        ],
                      ),
                    ),
                ],
              ),
      ),
    ];
  }

  Widget _empty(String text) => FishCard(
        id: 'collections-empty',
        title: '鱼的收藏',
        width: 460,
        height: 150,
        child: FishScrollText(text: '', emptyText: text),
      );
}

class _GalleryGrid extends StatefulWidget {
  final List<FishCollectionItem> items;
  final int total;
  final List<String> roots;
  final ValueChanged<String> onRemove;
  final VoidCallback onChanged;
  const _GalleryGrid({required this.items, required this.total, required this.roots, required this.onRemove, required this.onChanged});

  @override
  State<_GalleryGrid> createState() => _GalleryGridState();
}

class _GalleryGridState extends State<_GalleryGrid> {
  static const _none = '__none__';
  String _tag = '';
  String _query = '';
  String _sort = 'time';

  List<FishCollectionItem> get _filtered {
    var list = widget.items.where((item) {
      final q = _query.trim().toLowerCase();
      final hitQuery = q.isEmpty ||
          item.name.toLowerCase().contains(q) ||
          item.displayName.toLowerCase().contains(q) ||
          item.tags.any((t) => t.toLowerCase().contains(q));
      final hitTag = _tag.isEmpty ||
          (_tag == _none ? item.tags.isEmpty : item.tags.contains(_tag));
      return hitQuery && hitTag;
    }).toList();
    if (_sort == 'name') {
      list.sort((a, b) => (a.displayName.isEmpty ? a.name : a.displayName)
          .compareTo(b.displayName.isEmpty ? b.name : b.displayName));
    } else if (_sort == 'used') {
      list.sort((a, b) => b.useCount.compareTo(a.useCount));
    } else {
      list.sort((a, b) => b.addedAt.compareTo(a.addedAt));
    }
    return list;
  }

  Map<String, int> get _tagCounts {
    final counts = <String, int>{};
    for (final item in widget.items) {
      if (item.tags.isEmpty) counts[_none] = (counts[_none] ?? 0) + 1;
      for (final tag in item.tags) {
        counts[tag] = (counts[tag] ?? 0) + 1;
      }
    }
    return counts;
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final counts = _tagCounts;
    final tags = counts.keys.where((k) => k != _none).toList()
      ..sort((a, b) => (counts[b] ?? 0).compareTo(counts[a] ?? 0));
    final filtered = _filtered;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [
        Expanded(
          child: SizedBox(
            height: 34,
            child: TextField(
              onChanged: (v) => setState(() => _query = v),
              style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurface),
              decoration: InputDecoration(
                isDense: true,
                hintText: '搜名字 / 标签',
                hintStyle: TextStyle(fontSize: WhaleTokens.fsCaption, color: scheme.onSurfaceVariant),
                prefixIcon: Icon(Icons.search, size: 15, color: scheme.onSurfaceVariant),
                filled: true,
                fillColor: scheme.surfaceContainerHighest.withValues(alpha: 0.35),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(WhaleTokens.rMd), borderSide: BorderSide(color: scheme.outlineVariant)),
                enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(WhaleTokens.rMd), borderSide: BorderSide(color: scheme.outlineVariant)),
                contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
              ),
            ),
          ),
        ),
        const SizedBox(width: 10),
        Container(
          height: 34,
          padding: const EdgeInsets.symmetric(horizontal: 8),
          decoration: BoxDecoration(
            color: scheme.surfaceContainerHighest.withValues(alpha: 0.35),
            borderRadius: BorderRadius.circular(WhaleTokens.rMd),
            border: Border.all(color: scheme.outlineVariant),
          ),
          child: DropdownButtonHideUnderline(
            child: DropdownButton<String>(
              value: _sort,
              isDense: true,
              dropdownColor: scheme.surface,
              style: TextStyle(fontSize: WhaleTokens.fsCaption, color: scheme.onSurface),
              items: const [
                DropdownMenuItem(value: 'time', child: Text('时间')),
                DropdownMenuItem(value: 'name', child: Text('名字')),
                DropdownMenuItem(value: 'used', child: Text('最近使用')),
              ],
              onChanged: (v) => setState(() => _sort = v ?? 'time'),
            ),
          ),
        ),
      ]),
      const SizedBox(height: 8),
      SizedBox(
        height: 26,
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(children: [
            _GalleryTagChip(label: '全部', count: widget.total, selected: _tag.isEmpty, onTap: () => setState(() => _tag = '')),
            const SizedBox(width: 6),
            if ((counts[_none] ?? 0) > 0) ...[
              _GalleryTagChip(label: '未分类', count: counts[_none] ?? 0, selected: _tag == _none, onTap: () => setState(() => _tag = _none)),
              const SizedBox(width: 6),
            ],
            for (final tag in tags) ...[
              _GalleryTagChip(label: tag, count: counts[tag] ?? 0, selected: _tag == tag, onTap: () => setState(() => _tag = tag)),
              const SizedBox(width: 6),
            ],
          ]),
        ),
      ),
      const SizedBox(height: 8),
      Expanded(
        child: filtered.isEmpty
            ? Center(child: Text(widget.items.isEmpty ? '我还没收过图。' : '这个筛法下没有图。', style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurfaceVariant)))
            : LayoutBuilder(builder: (ctx, box) {
                final cross = (box.maxWidth / 118).floor().clamp(4, 10);
                return GridView.builder(
                  key: const PageStorageKey<String>('gallery-grid'),
                  cacheExtent: 360,
                  padding: const EdgeInsets.only(right: 2, bottom: 2),
                  gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: cross,
                    mainAxisSpacing: 8,
                    crossAxisSpacing: 8,
                    childAspectRatio: 0.8,
                  ),
                  itemCount: filtered.length,
                  itemBuilder: (_, i) {
                    final item = filtered[i];
                    return _GalleryTile(
                      item: item,
                      roots: widget.roots,
                      onRemove: item.name.isEmpty ? null : () => widget.onRemove(item.name),
                      onRename: () => _rename(item),
                      onTags: () => _editTags(item),
                    );
                  },
                );
              }),
      ),
    ]);
  }

  Future<void> _rename(FishCollectionItem item) async {
    if (item.id.isEmpty) {
      _snack('这张图不在索引里，改不了名。');
      return;
    }
    final split = _splitName(item.name);
    final ctl = TextEditingController(text: split.middle);
    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('重命名'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          Row(children: [
            if (split.prefix.isNotEmpty) Text(split.prefix, style: const TextStyle(fontSize: 13)),
            Expanded(
              child: TextField(
                controller: ctl,
                autofocus: true,
                decoration: const InputDecoration(isDense: true, border: OutlineInputBorder()),
              ),
            ),
            Text(split.suffix + split.ext, style: const TextStyle(fontSize: 13)),
          ]),
          const SizedBox(height: 8),
          Text('前缀和后缀是命名规则，不在这里改。', style: TextStyle(fontSize: 11, color: Theme.of(ctx).colorScheme.onSurfaceVariant)),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, ctl.text.trim()), child: const Text('保存')),
        ],
      ),
    );
    ctl.dispose();
    if (result == null || result.isEmpty) return;
    final name = split.prefix + result + split.suffix;
    final clash = widget.items.any((x) => x.id != item.id &&
        (x.displayName == name || x.name.replaceAll(RegExp(r'\.[^.]+$'), '') == name));
    if (clash) {
      _snack('这个名字已经有人用了，换一个。');
      return;
    }
    final r = await bridgeStickerUpdate(id: item.id, name: name);
    if (!mounted) return;
    if (r != null && r['ok'] == true) {
      widget.onChanged();
      _snack('已改名（回读校验通过）');
    } else {
      _snack('没改成：' + (r?['error'] ?? '没连上主程序').toString());
    }
  }

  Future<void> _editTags(FishCollectionItem item) async {
    if (item.id.isEmpty) {
      _snack('这张图不在索引里，改不了标签。');
      return;
    }
    final tags = [...item.tags];
    final ctl = TextEditingController();
    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(builder: (ctx, setD) {
        void add(String raw) {
          final v = raw.trim();
          if (v.isEmpty || tags.contains(v)) return;
          setD(() => tags.add(v));
          ctl.clear();
        }
        return AlertDialog(
          title: const Text('编辑标签'),
          content: SizedBox(
            width: 420,
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Wrap(spacing: 6, runSpacing: 6, children: [
                for (final tag in tags)
                  InputChip(label: Text(tag), onDeleted: () => setD(() => tags.remove(tag))),
                if (tags.isEmpty) Text('还没有标签。', style: TextStyle(fontSize: 12, color: Theme.of(ctx).colorScheme.onSurfaceVariant)),
              ]),
              const SizedBox(height: 10),
              TextField(
                controller: ctl,
                decoration: const InputDecoration(isDense: true, hintText: '输入标签，回车添加', border: OutlineInputBorder()),
                onSubmitted: add,
              ),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('保存标签')),
          ],
        );
      }),
    );
    ctl.dispose();
    if (saved != true) return;
    final r = await bridgeStickerUpdate(id: item.id, tags: tags);
    if (!mounted) return;
    if (r != null && r['ok'] == true) {
      widget.onChanged();
      _snack('标签已保存（回读校验通过）');
    } else {
      _snack('没存成：' + (r?['error'] ?? '没连上主程序').toString());
    }
  }

  void _snack(String text) {
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(text), duration: const Duration(seconds: 2)));
  }
}

/// 拆成「前缀 / 主词 / 后缀 / 扩展名」：只让主词可改。
({String prefix, String middle, String suffix, String ext}) _splitName(String name) {
  final dot = name.lastIndexOf('.');
  final ext = dot > 0 ? name.substring(dot) : '';
  var base = dot > 0 ? name.substring(0, dot) : name;
  var suffix = '';
  final m = RegExp(r'(-[0-9]+)$').firstMatch(base);
  if (m != null) {
    suffix = m.group(1)!;
    base = base.substring(0, base.length - suffix.length);
  }
  var prefix = '';
  final mid = base.indexOf('·');
  if (mid >= 0) {
    prefix = base.substring(0, mid + 1);
    base = base.substring(mid + 1);
  } else {
    final space = base.indexOf(' ');
    if (space > 0) {
      prefix = base.substring(0, space + 1);
      base = base.substring(space + 1);
    }
  }
  return (prefix: prefix, middle: base, suffix: suffix, ext: ext);
}

class _GalleryTagChip extends StatelessWidget {
  final String label;
  final int count;
  final bool selected;
  final VoidCallback onTap;
  const _GalleryTagChip({required this.label, required this.count, required this.selected, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Focus(
      onKeyEvent: (node, event) {
        final k = event.logicalKey;
        if (k == LogicalKeyboardKey.arrowLeft || k == LogicalKeyboardKey.arrowRight) {
          FocusScope.of(context).focusInDirection(k == LogicalKeyboardKey.arrowLeft ? TraversalDirection.left : TraversalDirection.right);
          return KeyEventResult.handled;
        }
        if ((k == LogicalKeyboardKey.enter || k == LogicalKeyboardKey.space) && count > 0) {
          onTap();
          return KeyEventResult.handled;
        }
        return KeyEventResult.ignored;
      },
      child: InkWell(
      onTap: count == 0 ? null : onTap,
      focusColor: scheme.primary.withValues(alpha: 0.14),
      borderRadius: BorderRadius.circular(999),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        decoration: BoxDecoration(
          color: selected ? scheme.primary.withValues(alpha: 0.14) : scheme.surfaceContainerHighest.withValues(alpha: 0.35),
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: selected ? scheme.primary.withValues(alpha: 0.5) : scheme.outlineVariant),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Text(label, style: TextStyle(fontSize: 11, color: count == 0 ? scheme.onSurfaceVariant.withValues(alpha: 0.4) : (selected ? scheme.primary : scheme.onSurface))),
          const SizedBox(width: 5),
          Text(count.toString(), style: TextStyle(fontSize: 10, color: count == 0 ? scheme.onSurfaceVariant.withValues(alpha: 0.4) : scheme.onSurfaceVariant, fontFeatures: const [FontFeature.tabularFigures()])),
        ]),
      ),
    ),
    );
  }
}

class _GalleryTile extends StatefulWidget {
  final FishCollectionItem item;
  final List<String> roots;
  final VoidCallback? onRemove;
  final VoidCallback? onRename;
  final VoidCallback? onTags;
  const _GalleryTile({required this.item, required this.roots, this.onRemove, this.onRename, this.onTags});

  @override
  State<_GalleryTile> createState() => _GalleryTileState();
}

class _GalleryTileState extends State<_GalleryTile> {
  bool _hover = false;
  bool _focused = false;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final item = widget.item;
    return Focus(
      onFocusChange: (v) => setState(() => _focused = v),
      onKeyEvent: (node, event) {
        final k = event.logicalKey;
        TraversalDirection? dir;
        if (k == LogicalKeyboardKey.arrowLeft) dir = TraversalDirection.left;
        if (k == LogicalKeyboardKey.arrowRight) dir = TraversalDirection.right;
        if (k == LogicalKeyboardKey.arrowUp) dir = TraversalDirection.up;
        if (k == LogicalKeyboardKey.arrowDown) dir = TraversalDirection.down;
        if (dir != null) {
          FocusScope.of(context).focusInDirection(dir);
          return KeyEventResult.handled;
        }
        if (k == LogicalKeyboardKey.contextMenu || (k == LogicalKeyboardKey.f10 && HardwareKeyboard.instance.isShiftPressed)) {
          _openMenuAtTile();
          return KeyEventResult.handled;
        }
        if (k == LogicalKeyboardKey.keyE && widget.onRename != null) {
          widget.onRename!.call();
          return KeyEventResult.handled;
        }
        return KeyEventResult.ignored;
      },
      child: MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onSecondaryTapDown: (d) => _openMenu(context, d.globalPosition),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Expanded(
            child: Stack(fit: StackFit.expand, children: [
              Container(
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(WhaleTokens.rMd),
                  border: _focused ? Border.all(color: scheme.primary, width: 2) : null,
                ),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(WhaleTokens.rMd),
                  child: GalleryThumb(name: item.name, roots: widget.roots),
                ),
              ),
              if (_hover) ...[
                if (widget.onRename != null)
                  Positioned(
                    top: 2,
                    right: 26,
                    child: _TileAction(icon: Icons.edit_outlined, color: scheme.onSurface, onTap: widget.onRename!),
                  ),
                if (widget.onRemove != null)
                  Positioned(
                    top: 2,
                    right: 2,
                    child: _TileAction(icon: Icons.delete_outline, color: scheme.error, onTap: widget.onRemove!),
                  ),
              ],
            ]),
          ),
          const SizedBox(height: 4),
          Row(children: [
            Expanded(child: Text(item.displayName.isEmpty ? item.name : item.displayName, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: WhaleTokens.fsCaption, color: scheme.onSurfaceVariant))),
            if (item.auto)
              Container(
                margin: const EdgeInsets.only(left: 4),
                padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                decoration: BoxDecoration(color: scheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(3)),
                child: Text('自动', style: TextStyle(fontSize: 9, color: scheme.onSurfaceVariant)),
              ),
          ]),
          Text(item.tags.isEmpty ? '未分类' : item.tags.take(2).join(' · '),
              maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant.withValues(alpha: 0.7))),
        ]),
      ),
      ),
    );
  }

  void _openMenuAtTile() {
    final box = context.findRenderObject() as RenderBox?;
    if (box == null) return;
    _openMenu(context, box.localToGlobal(Offset.zero));
  }

  void _openMenu(BuildContext context, Offset global) {
    final overlay = Overlay.of(context).context.findRenderObject() as RenderBox?;
    if (overlay == null) return;
    showMenu<String>(
      context: context,
      position: RelativeRect.fromRect(global & const Size(1, 1), Offset.zero & overlay.size),
      items: [
        if (widget.onRename != null) const PopupMenuItem(value: 'rename', child: Text('重命名')),
        if (widget.onTags != null) const PopupMenuItem(value: 'tags', child: Text('编辑标签')),
        if (widget.onRemove != null) const PopupMenuItem(value: 'remove', child: Text('移入回收站')),
      ],
    ).then((v) {
      if (v == 'rename') widget.onRename?.call();
      if (v == 'tags') widget.onTags?.call();
      if (v == 'remove') widget.onRemove?.call();
    });
  }
}

class _TileAction extends StatelessWidget {
  final IconData icon;
  final Color color;
  final VoidCallback onTap;
  const _TileAction({required this.icon, required this.color, required this.onTap});
  @override
  Widget build(BuildContext context) => Material(
    color: Theme.of(context).colorScheme.surface.withValues(alpha: 0.9),
    shape: const CircleBorder(),
    child: InkWell(
      customBorder: const CircleBorder(),
      onTap: onTap,
      child: Padding(padding: const EdgeInsets.all(3), child: Icon(icon, size: 13, color: color)),
    ),
  );
}
