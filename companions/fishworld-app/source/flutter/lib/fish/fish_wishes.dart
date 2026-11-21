import 'package:flutter/material.dart';

import '../data/bridge.dart';
import '../data/fish_data.dart';
import '../data/wish_source_common.dart';
import '../theme/whale_tokens.dart';
import 'fish_common.dart' hide FishEmpty;
import 'ui_kit/ui_kit.dart';
// ignore_for_file: prefer_interpolation_to_compose_strings

/// 鱼的请求：待处理 / 已处理 / 想收藏。只读查看，批复在桌面端做。
class FishWishesPage extends StatefulWidget {
  const FishWishesPage({super.key});

  @override
  State<FishWishesPage> createState() => _FishWishesPageState();
}

class _FishWishesPageState extends State<FishWishesPage> {
  Future<FishSnapshot> _future = FishWorld.load();
  List<Map<String, dynamic>>? _cands;
  List<String> _roots = const [];
  int _galleryDelta = 0;

  @override
  void initState() {
    super.initState();
    _loadCands();
  }

  Future<void> _loadCands() async {
    final data = await FishWorld.load();
    final r = await loadWishes(data.roots);
    if (!mounted) return;
    final items = (r['items'] as List?) ?? const [];
    setState(() {
      _roots = data.roots;
      _cands = [for (final e in items) if (e is Map) Map<String, dynamic>.from(e)];
    });
  }

  void _dropCand(String id) {
    setState(() => _cands = [for (final c in (_cands ?? [])) if (c['id'] != id) c]);
  }

  Future<void> _keepSticker(Map<String, dynamic> item) async {
    final id = (item['id'] ?? '').toString();
    final out = await FishWrite.run(
      label: '收进图库',
      write: () => bridgeStickerWishDecide(id, true),
      readBack: () => bridgeStickerWishes(),
      verify: (r) {
        final list = (r?['items'] as List?) ?? const [];
        return !list.any((e) => e is Map && e['id'] == id);
      },
    );
    if (!mounted) return;
    if (out.ok) {
      _dropCand(id);
      setState(() => _galleryDelta += 1);
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(const SnackBar(content: Text('已收进她的图库'), duration: Duration(seconds: 2)));
    } else {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(out.message), backgroundColor: Theme.of(context).colorScheme.errorContainer));
    }
  }

  Future<void> _rejectSticker(Map<String, dynamic> item) async {
    final id = (item['id'] ?? '').toString();
    final ok = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: const Text('不要这张图'),
      content: const Text('会删掉鱼提交的这张候选图，不能恢复。', style: TextStyle(fontSize: 13)),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')), FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('不要了'))],
    ));
    if (ok != true || !mounted) return;
    final out = await FishWrite.run(
      label: '不要这张图',
      write: () => bridgeStickerWishDecide(id, false),
      readBack: () => bridgeStickerWishes(),
      verify: (r) {
        final list = (r?['items'] as List?) ?? const [];
        return !list.any((e) => e is Map && e['id'] == id);
      },
    );
    if (!mounted) return;
    if (out.ok) { _dropCand(id); } else {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(out.message), backgroundColor: Theme.of(context).colorScheme.errorContainer));
    }
  }

  void _reload() { setState(() => _future = FishWorld.load()); }

  Future<void> _decide(String id, String decision) async {
    final r = await bridgeFishWishDecision(id, decision);
    if (!mounted) return;
    if (r != null && r['ok'] == true) {
      _reload();
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          SnackBar(content: Text(decision == 'approve' ? '已同意（回读校验通过）' : '已拒绝（回读校验通过）'), duration: const Duration(seconds: 2)));
    } else {
      final err = r == null ? '这台机器上没有可处理的请求' : (r['error'] ?? '未知错误').toString();
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          SnackBar(content: Text('没处理成：$err'), backgroundColor: Theme.of(context).colorScheme.errorContainer));
    }
  }

  @override
  Widget build(BuildContext context) {
    return FishPageLayout(
      pageKey: 'wishes',
      future: _future,
      buildCards: _cards,
    );
  }

  List<Widget> _cards(BuildContext context, FishSnapshot data) {
    final wishes = data.wishes;
    if (!data.ok) {
      return [_empty('还没读到鱼的请求。确认桌面端在跑，或先导出快照。')];
    }
    final pending = wishes.items.where((w) => w.status == 'pending').toList();
    final decided = wishes.items.where((w) => w.status != 'pending').toList();
    final scheme = Theme.of(context).colorScheme;
    return [
      FishCard(
        id: 'wish-hero',
        title: '鱼的请求',
        note: '待处理 ' + wishes.pending.toString() + ' 条',
        width: 1400,
        height: wishes.voice.isEmpty ? 170 : 196,
        child: Row(children: [
          Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
            Text(wishes.pending.toString(), style: TextStyle(fontSize: 42, height: 1, fontWeight: FontWeight.w700, color: scheme.primary, fontFeatures: const [FontFeature.tabularFigures()])),
            const SizedBox(height: 6),
            Text('件还等着你回', style: TextStyle(fontSize: WhaleTokens.fsSub, color: scheme.onSurfaceVariant)),
            if (wishes.voice.isNotEmpty) ...[
              const SizedBox(height: 6),
              SizedBox(
                width: 320,
                child: Text(wishes.voice,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 10, height: 1.5, color: scheme.onSurfaceVariant)),
              ),
            ],
          ]),
          const SizedBox(width: 40),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
            Text('她想做点什么、想要什么、想换个相处方式，都写在这里。', style: TextStyle(fontSize: WhaleTokens.fsBody, height: 1.6, color: scheme.onSurface)),
            const SizedBox(height: 6),
            Text('同意 / 拒绝会回到她那边；已处理的请求也留着，不消失。', style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurfaceVariant)),
          ])),
        ]),
      ),
      FishCard(
        id: 'wish-pending',
        title: '等待处理',
        note: pending.length.toString() + ' 条',
        width: 760,
        height: pending.isEmpty ? 76 : 300,
        child: pending.isEmpty
            ? Row(children: [
                Icon(Icons.check_circle_outline, size: 14, color: scheme.onSurfaceVariant),
                const SizedBox(width: 7),
                Text(wishes.total == 0 ? '今天还没提要什么' : '该提的都提过了，暂时没新的',
                    style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurfaceVariant)),
              ])
            : FishScrollList(
                children: [
                  for (final w in pending) _wishBlock(context, w, showStatus: false),
                ],
              ),
      ),
      FishCard(
        id: 'wish-decided',
        title: '已处理',
        note: decided.length.toString() + ' 条',
        width: 760,
        height: decided.isEmpty ? 88 : (decided.length == 1 ? 150 : 240),
        child: decided.isEmpty
            ? Text('你还没回过我什么。', style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurfaceVariant))
            : FishScrollList(
                children: [
                  for (final w in decided) _wishBlock(context, w, showStatus: true),
                ],
              ),
      ),
      FishCard(
        id: 'wish-stickers',
        title: '鱼想收藏',
        note: '图库 ' + (data.gallery.items.length + _galleryDelta).toString() + ' 张 · 你点头才进库',
        width: 760,
        height: (_cands == null || _cands!.isEmpty) ? 140 : (96.0 + 84 * (_cands!.length.clamp(1, 4))),
        child: _cands == null
            ? const Center(child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 1.6)))
            : (_cands!.isEmpty
                ? Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                    Text('这台机器上还没有想收藏的图', style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurfaceVariant)),
                    const SizedBox(height: 6),
                    TextButton(onPressed: _loadCands, child: const Text('重试')),
                  ])
                : FishScrollList(children: [
                    for (final item in _cands!) _stickerWishRow(context, item),
                  ])),
      )
    ];
  }

  Widget _stickerWishRow(BuildContext context, Map<String, dynamic> item) {
    final scheme = Theme.of(context).colorScheme;
    final id = (item['id'] ?? '').toString();
    final name = (item['name'] ?? '未命名').toString();
    final reason = (item['reason'] ?? '').toString();
    final file = (item['file'] ?? '').toString();
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: SizedBox(
            width: 56,
            height: 56,
            child: WishThumb(id: id, file: file, roots: _roots),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: WhaleTokens.fsBody, fontWeight: FontWeight.w600, color: scheme.onSurface)),
          const SizedBox(height: 4),
          FishTooltip(message: reason.isEmpty ? '（她没写理由）' : reason, child: Text(reason.isEmpty ? '（她没写理由）' : reason, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurfaceVariant))),
        ])),
        if (wishCanDecide) ...[
          const SizedBox(width: 12),
          FilledButton(
            style: FilledButton.styleFrom(visualDensity: VisualDensity.compact, padding: const EdgeInsets.symmetric(horizontal: 14)),
            onPressed: () => _keepSticker(item),
            child: const Text('收下'),
          ),
          const SizedBox(width: 6),
          TextButton(onPressed: () => _rejectSticker(item), child: const Text('不要')),
        ],
      ]),
    );
  }

  Widget _wishBlock(BuildContext context, FishWish wish, {required bool showStatus}) {
    final scheme = Theme.of(context).colorScheme;
    final meta = <String>[
      if (wish.day.isNotEmpty) wish.day,
      wish.kindLabel,
      if (showStatus && wish.statusLabel.isNotEmpty) wish.statusLabel,
      if (wish.urgency == 'high') '着急',
    ];
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            meta.join(' · '),
            style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurfaceVariant),
          ),
          const SizedBox(height: 3),
          Text(
            wish.text.isEmpty ? '（空）' : wish.text,
            style: TextStyle(fontSize: WhaleTokens.fsBody, height: 1.6, color: scheme.onSurface),
          ),
          if (wish.reply.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Text(
                '你的答复：${wish.reply}',
                style: TextStyle(fontSize: WhaleTokens.fsSmall, height: 1.5, color: scheme.onSurfaceVariant),
              ),
            ),
          if (!showStatus && wish.id.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Row(children: [
                TextButton(
                  onPressed: () => _decide(wish.id, 'approve'),
                  style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
                  child: const Text('同意'),
                ),
                const SizedBox(width: 4),
                TextButton(
                  onPressed: () => _decide(wish.id, 'reject'),
                  style: TextButton.styleFrom(visualDensity: VisualDensity.compact, foregroundColor: scheme.error),
                  child: const Text('拒绝'),
                ),
              ]),
            ),
        ],
      ),
    );
  }

  Widget _empty(String text) => FishCard(
        id: 'wish-empty',
        title: '鱼的请求',
        width: 460,
        height: 150,
        child: FishScrollText(text: '', emptyText: text),
      );
}
