import 'package:flutter/material.dart';
import 'data/ui_store.dart';
import 'data/notes_source.dart';
import 'fish_nav.dart';
import 'package:flutter/services.dart';
import 'sidebar.dart';
import 'theme_controller.dart';
import 'theme/whale_tokens.dart';
import 'fish_tooltip.dart';
import 'bento.dart';
import 'notes_canvas.dart';
import 'feedback.dart';
import 'fish/fish_pages.dart';
import 'fish/ui_kit/ui_kit.dart';
import 'fish/ui_kit/protocol_wizard.dart';
import 'data/model_store.dart';
import 'data/local_store.dart';
import 'data/whale_data.dart';
import 'version.dart';

/// 每个导航项对应的一页。
class RouteMeta {
  final String label;
  final IconData icon;
  final String hint;
  const RouteMeta(this.label, this.icon, this.hint);
}

const Map<NavRoute, RouteMeta> routeMeta = {
  NavRoute.chat: RouteMeta('对话', Icons.chat_bubble_outline, '这里会是和她的对话'),
  NavRoute.notes: RouteMeta('鱼的笔记', Icons.note_alt_outlined, '鱼自己整理的知识与笔记'),
  NavRoute.overview: RouteMeta('总览', Icons.space_dashboard_outlined, '鱼的世界总览'),
  NavRoute.diary: RouteMeta('鱼的日记', Icons.book_outlined, '她写下的日记'),
  NavRoute.wish: RouteMeta('鱼的请求', Icons.star_outline, '鱼主动提出的事'),
  NavRoute.growth: RouteMeta('鱼的成长', Icons.trending_up_outlined, '她形成理解的过程'),
  NavRoute.memory:
      RouteMeta('鱼的记忆', Icons.psychology_outlined, '记忆册 / 知识库 / 时间档案'),
  NavRoute.status: RouteMeta('鱼的状态', Icons.favorite_outline, '最新记忆摘要'),
  NavRoute.collections:
      RouteMeta('鱼的收藏', Icons.collections_bookmark_outlined, '图片收藏与链接收藏'),
  NavRoute.profile: RouteMeta('鱼的设定', Icons.badge_outlined, '名字 / 人设卡 / 存储位置'),
  NavRoute.platforms: RouteMeta('鱼与世界', Icons.public_outlined, '本轮只接 QQ'),
  NavRoute.qq: RouteMeta('鱼与世界', Icons.public_outlined, '本轮只接 QQ'),
  NavRoute.gallery:
      RouteMeta('鱼的收藏', Icons.collections_bookmark_outlined, '图片收藏'),
  NavRoute.links:
      RouteMeta('鱼的收藏', Icons.collections_bookmark_outlined, '链接收藏'),
  NavRoute.settings: RouteMeta('设置', Icons.settings_outlined, '这里会是设置项'),
  NavRoute.about: RouteMeta('关于', Icons.info_outline, '这里会是版本与说明'),
};

/// 页面外壳：顶栏（可选汉堡）+ 内容区（限宽 960，本体也是窄内容区）。
class RoutePage extends StatelessWidget {
  final NavRoute route;
  final Widget? leading;
  const RoutePage({super.key, required this.route, this.leading});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final meta = routeMeta[route]!;
    return Column(children: [
      FishPageHeader(icon: meta.icon, leading: leading, title: meta.label),
      Expanded(
        child: Align(
          alignment: Alignment.topCenter,
          child: ConstrainedBox(
            constraints: BoxConstraints(
                maxWidth:
                    (route == NavRoute.settings || route == NavRoute.about)
                        ? 960
                        : 1680),
            child: SizedBox(width: double.infinity, child: _bodyFor(context, meta, scheme, route)),
          ),
        ),
      ),
    ]);
  }

  Widget _bodyFor(BuildContext context, RouteMeta meta, ColorScheme scheme,
      NavRoute route) {
    if (route == NavRoute.settings) return const SettingsBody();
    if (route == NavRoute.notes) return const NotesPage();
    if (route == NavRoute.about) return const AboutPage();
    // 鱼的世界九页统一走 fish/ 下的出口（总览 / 日记 / 请求 / 成长 / 记忆 /
    // 状态 / 收藏 / 设定 / 鱼与世界）；其余路由落到下面的旧页面或空态。
    final fishPage = fishPageFor(route);
    if (fishPage != null) return fishPage;
    return _Empty(icon: meta.icon, title: meta.hint, hint: '这个页面还没接入数据');
  }
}

/// 面板：本体里所有内容都装在这种带标题的卡片里。
class _Panel extends StatelessWidget {
  final String? title;
  final String? subtitle;
  final List<Widget> children;
  const _Panel({this.title, this.subtitle, required this.children});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child:
            Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (title != null) ...[
            Row(children: [
              Text(title!,
                  style: TextStyle(
                      fontSize: WhaleTokens.fsSub,
                      fontWeight: FontWeight.w600,
                      color: scheme.onSurface)),
              const Spacer(),
              if (subtitle != null)
                Text(subtitle!,
                    style: TextStyle(
                        fontSize: WhaleTokens.fsSmall,
                        color: scheme.onSurfaceVariant)),
            ]),
            const SizedBox(height: WhaleTokens.rMd),
          ],
          ...children,
        ]),
      ),
    );
  }
}

class _RowTile extends StatelessWidget {
  final IconData icon;
  final String label;
  const _RowTile({required this.icon, required this.label});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return InkWell(
      onTap: null,
      borderRadius: BorderRadius.circular(WhaleTokens.rMd),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 9, horizontal: 2),
        child: Row(children: [
          Icon(icon, size: 16, color: scheme.onSurfaceVariant),
          const SizedBox(width: 10),
          Expanded(
            child: Text(label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                    fontSize: WhaleTokens.fsBody, color: scheme.onSurface)),
          ),
        ]),
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? hint;
  const _Empty({required this.icon, required this.title, this.hint});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon,
              size: 40, color: scheme.onSurfaceVariant.withValues(alpha: 0.55)),
          const SizedBox(height: 12),
          Text(title,
              textAlign: TextAlign.center,
              style: TextStyle(
                  fontSize: WhaleTokens.fsBody,
                  color: scheme.onSurfaceVariant)),
          if (hint != null) ...[
            const SizedBox(height: 6),
            Text(hint!,
                textAlign: TextAlign.center,
                style: TextStyle(
                    fontSize: WhaleTokens.fsSmall,
                    color: scheme.onSurfaceVariant.withValues(alpha: 0.7))),
          ],
        ]),
      ),
    );
  }
}

// ---------------- 设置 ----------------
class SettingsBody extends StatefulWidget {
  const SettingsBody({super.key});

  @override
  State<SettingsBody> createState() => _SettingsBodyState();
}

class _SettingsBodyState extends State<SettingsBody> {
  final _base = TextEditingController();
  final _model = TextEditingController();
  final _key = TextEditingController();
  bool _busy = false;
  bool _hasKey = false;
  String _msg = '';
  bool _msgErr = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final r = await loadModelConfig();
    if (!mounted || r == null) return;
    setState(() {
      _base.text = (r['baseUrl'] ?? '').toString();
      _model.text = (r['model'] ?? '').toString();
      _hasKey = r['hasKey'] == true;
      UiStore.set('model.draft.baseUrl', _base.text);
      UiStore.set('model.draft.model', _model.text);
    });
  }

  Future<void> _save() async {
    if (_busy) return;
    // 前端先拦一道：缺哪项说哪项，不许静默存空。
    final b = _base.text.trim();
    final m = _model.text.trim();
    final k = _key.text.trim();
    if (b.isEmpty) { setState(() { _msg = '还没填 API 地址'; _msgErr = true; }); return; }
    if (m.isEmpty) { setState(() { _msg = '还没填模型名（常用 deepseek-chat）'; _msgErr = true; }); return; }
    if (k.isEmpty && !_hasKey) { setState(() { _msg = '还没填 API Key'; _msgErr = true; }); return; }
    setState(() {
      _busy = true;
      _msg = '保存中…';
      _msgErr = false;
    });
    final r = await saveModelConfig(
      baseUrl: _base.text,
      model: _model.text,
      apiKey: _key.text,
    );
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (r != null && r['ok'] == true) {
        _hasKey = r['hasKey'] == true || _hasKey;
        _key.clear();
        _msg = '已保存；聊天会用这份 API';
        _msgErr = false;
        UiStore.set('model.draft.baseUrl', _base.text.trim());
        UiStore.set('model.draft.model', _model.text.trim());
      } else {
        _msg = '没存成：${r?['error'] ?? '没连上主程序'}';
        _msgErr = true;
      }
    });
  }

  @override
  void dispose() {
    _base.dispose();
    _model.dispose();
    _key.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ctrl = ThemeScope.of(context);
    final scheme = Theme.of(context).colorScheme;
    Widget apiField(TextEditingController controller, String label, String hint,
        {bool obscure = false, void Function(String)? onChanged}) {
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label,
            style: TextStyle(
                fontSize: WhaleTokens.fsSmall,
                color: scheme.onSurfaceVariant)),
        const SizedBox(height: 4),
        Container(
          height: 44,
          decoration: BoxDecoration(
            color: scheme.surfaceContainerHighest.withValues(alpha: 0.45),
            border: Border.all(color: scheme.outline),
            borderRadius: BorderRadius.circular(8),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 10),
          alignment: Alignment.centerLeft,
          child: TextField(
            controller: controller,
            obscureText: obscure,
            onChanged: onChanged,
            style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurface),
            decoration: InputDecoration.collapsed(
              hintText: hint,
              hintStyle: TextStyle(
                  fontSize: WhaleTokens.fsSmall,
                  color: scheme.onSurfaceVariant.withValues(alpha: 0.7)),
            ),
          ),
        ),
      ]);
    }

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        FishAnchor(anchor: 'settings.model', child: _Panel(title: '模型 API', subtitle: '填自己的 OpenAI 兼容接口', children: [
          apiField(_base, 'API 地址', 'https://api.example.com/v1', onChanged: (v) => UiStore.set('model.draft.baseUrl', v)),
          const SizedBox(height: 8),
          apiField(_model, '模型名', 'deepseek-chat', onChanged: (v) => UiStore.set('model.draft.model', v)),
          const SizedBox(height: 8),
          apiField(_key, 'API Key', _hasKey ? '已保存；留空 = 不改' : '填入你的 key', obscure: true, onChanged: (v) => UiStore.set('model.draft.key', v)),
          const SizedBox(height: 10),
          Row(children: [
            FilledButton(
              onPressed: _busy ? null : _save,
              child: Text(_busy ? '保存中…' : '保存模型 API'),
            ),
            const SizedBox(width: 10),
            Expanded(child: Text(_msg, style: TextStyle(fontSize: WhaleTokens.fsSmall, color: _msgErr ? scheme.error : scheme.onSurfaceVariant))),
            if (_msg.contains('模型名')) TextButton(onPressed: _busy ? null : () { _model.text = 'deepseek-chat'; UiStore.set('model.draft.model', 'deepseek-chat'); _save(); }, child: const Text('用默认 deepseek-chat')),
          ]),
          const SizedBox(height: 6),
          Text('只支持 OpenAI 兼容的 /chat/completions；key 存在本机 0600 文件，不回显。',
              style: TextStyle(fontSize: WhaleTokens.fsCaption, color: scheme.onSurfaceVariant)),
        ])),
        const ProtocolWizard(),
        _Panel(title: '外观', subtitle: '即时生效', children: [
          SegmentedButton<ThemeMode>(
            segments: const [
              ButtonSegment(
                  value: ThemeMode.light,
                  label: Text('浅色'),
                  icon: Icon(Icons.light_mode_outlined, size: 16)),
              ButtonSegment(
                  value: ThemeMode.dark,
                  label: Text('深色'),
                  icon: Icon(Icons.dark_mode_outlined, size: 16)),
              ButtonSegment(
                  value: ThemeMode.system,
                  label: Text('跟随'),
                  icon: Icon(Icons.brightness_auto_outlined, size: 16)),
            ],
            selected: {ctrl.mode},
            showSelectedIcon: false,
            style: SegmentedButton.styleFrom(
              textStyle: const TextStyle(fontSize: WhaleTokens.fsLabel),
              selectedBackgroundColor: scheme.primary.withValues(alpha: 0.18),
              selectedForegroundColor: scheme.primary,
              foregroundColor: scheme.onSurfaceVariant,
              side: BorderSide(color: scheme.outlineVariant),
            ),
            onSelectionChanged: (s) {
              ctrl.setMode(s.first);
              sayFeedback(s.first == ThemeMode.light
                  ? '换成浅色啦'
                  : (s.first == ThemeMode.dark ? '换成深色啦' : '跟着系统走'));
            },
          ),
          const SizedBox(height: 10),
          Text('配色与字号来自蓝鲸娘本体 token（12px 正文 / 16px 标题 / 5·8·10·12 圆角）。',
              style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurfaceVariant)),
        ]),
        _Panel(title: '数据', subtitle: '本地快照', children: [
          const _RowTile(icon: Icons.description_outlined, label: '内容来自鱼的世界导出快照'),
          const _RowTile(icon: Icons.folder_outlined, label: 'flutter/assets/data/*.json'),
          const SizedBox(height: 8),
          Text('改完数据源后跑 tools/export_flutter_data.mjs 重新导出即可，页面不用改。',
              style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurfaceVariant)),
        ]),
      ],
    );
  }
}

// ---------------- 笔记 ----------------
typedef NoteSaveFn = Future<Map<String, dynamic>?> Function({String? id, required String title, required String body, required String folder});
class _NotesBanner extends StatelessWidget {
  final String text;
  const _NotesBanner({required this.text});
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      color: scheme.tertiaryContainer.withValues(alpha: 0.35),
      child: Text(text, style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurface)),
    );
  }
}

class NotesPage extends StatefulWidget {
  /// 测试注入；正式运行时为 null，走 NotesSource。
  final List<NoteItem>? initialNotes;
  final NoteSaveFn? saveNote;
  const NotesPage({super.key, this.initialNotes, this.saveNote});
  @override
  State<NotesPage> createState() => _NotesPageState();
}

class _NotesPageState extends State<NotesPage> {
  late Future<List<NoteItem>> _future = _loadNotes();
  String _view = _initialView();
  String? _selectedId;
  bool _notesReadOnly = false;
  String _notesNotice = '';
  List<NoteItem> _lastItems = const [];
  final TransformationController _canvasController = TransformationController();
  final Map<String, ScrollController> _scrolls = {};

  @override
  void initState() {
    super.initState();
    HardwareKeyboard.instance.addHandler(_onHardwareKey);
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_onHardwareKey);
    _canvasController.dispose();
    for (final c in _scrolls.values) { c.dispose(); }
    super.dispose();
  }

  bool _typing() {
    try {
      final c = FocusManager.instance.primaryFocus?.context;
      return c != null && c.findAncestorWidgetOfExactType<EditableText>() != null;
    } catch (_) { return false; }
  }

  bool _onHardwareKey(KeyEvent e) {
    if (_typing()) return false;
    if (e is! KeyDownEvent) return false;
    return _notesKey(e, _lastItems) == KeyEventResult.handled;
  }

  KeyEventResult _notesKey(KeyEvent e, List<NoteItem> items) {
    final k = e.logicalKey;
    if (items.isEmpty) return KeyEventResult.ignored;
    if (k == LogicalKeyboardKey.enter || k == LogicalKeyboardKey.space) {
      var id = _selectedId;
      if (id == null || !items.any((n) => n.id == id)) id = items.first.id;
      _openNote(context, items.firstWhere((n) => n.id == id));
      return KeyEventResult.handled;
    }
    if (k == LogicalKeyboardKey.escape) {
      if (_selectedId != null) setState(() => _selectedId = null);
      return KeyEventResult.handled;
    }
    final fwd = k == LogicalKeyboardKey.arrowRight || k == LogicalKeyboardKey.arrowDown;
    final back = k == LogicalKeyboardKey.arrowLeft || k == LogicalKeyboardKey.arrowUp;
    if (!fwd && !back) return KeyEventResult.ignored;
    final idx = items.indexWhere((n) => n.id == _selectedId);
    final next = idx < 0 ? (fwd ? 0 : items.length - 1) : (idx + (fwd ? 1 : -1)).clamp(0, items.length - 1);
    setState(() => _selectedId = items[next].id);
    return KeyEventResult.handled;
  }

  Widget _viewBody(BuildContext context, List<NoteItem> items) {
    if (_view == 'canvas') {
      return NotesCanvas(
        items: items,
        selectedId: _selectedId,
        controller: _canvasController,
        onSelect: (id) => setState(() => _selectedId = id),
        onOpen: (n) => _openNote(context, n),
        onDelete: (n) => _deleteNote(n),
        onMove: _moveNote,
      );
    }
    return LayoutBuilder(builder: (_, box) {
      if (_view == 'kanban') return _kanban(context, items);
      if (_view == 'tree') return _tree(context, items);
      if (_view == 'mindmap') return _mindmap(context, items);
      final pad = box.maxWidth >= 900 ? 16.0 : 10.0;
      final avail = box.maxWidth - pad * 2;
      final double gap = box.maxWidth >= 900 ? 12 : 8;
      final int cols = avail >= 1600 ? 6 : avail >= 1280 ? 5 : avail >= 960 ? 4 : avail >= 620 ? 2 : 1;
      final unit = (avail - gap * (cols - 1)) / cols;
      final double noteH = cols >= 4 ? 120 : (cols == 2 ? 108 : 96);
      final double heroH = cols >= 4 ? 190 : 150;
      final scheme = Theme.of(context).colorScheme;
      return SingleChildScrollView(
        key: const PageStorageKey('notes-scroll-bento'),
        padding: EdgeInsets.all(pad),
        child: BentoBoard(boardId: 'notes', items: [
          BentoItem(
            id: 'hero',
            width: unit * 2 + gap,
            height: heroH,
            child: BentoPanel(
              title: '鱼的笔记',
              note: '她整理了 ' + items.length.toString() + ' 条',
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Icon(Icons.auto_stories_outlined, size: 26, color: scheme.primary),
                const Spacer(),
                Text('左手柄拖动换位置（Alt+方向键也行），右下角拖大小。', maxLines: 3, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: WhaleTokens.fsSmall, height: 1.5, color: scheme.onSurfaceVariant)),
              ]),
            ),
          ),
          for (var i = 0; i < items.length; i++)
            BentoItem(
              id: 'n' + i.toString(),
              width: unit,
              height: noteH,
              child: Card(child: InkWell(
                borderRadius: BorderRadius.circular(WhaleTokens.rLg),
                onTap: () => _openNote(context, items[i]),
                child: Padding(padding: const EdgeInsets.fromLTRB(14, 14, 14, 12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  const Spacer(),
                  Text(items[i].title, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: WhaleTokens.fsBody, color: scheme.onSurface)),
                ])),
              )),
            ),
        ]),
      );
    });
  }


  Future<void> _moveNote(NoteItem n, double x, double y) async {
    final r = await NotesSource.save(id: n.id, title: n.title, body: n.body, folder: n.folder, x: x, y: y);
    if (r != null && r['ok'] == true) _reloadNotes();
  }

  void _reloadNotes() {
    setState(() {
      _future = _loadNotes();
    });
  }

  Future<List<NoteItem>> _loadNotes() async {
    // 插件有数据就用插件；否则读打包快照 / 本地文件（桌面版）。
    if (widget.initialNotes != null) return widget.initialNotes!;
    final got = await NotesSource.load();
    _notesReadOnly = got.readOnly;
    _notesNotice = got.notice;
    return [for (final e in got.items) NoteItem.fromJson(_noteMap(e))];
  }

  Map<String, dynamic> _noteMap(Map e) {
    final m = Map<String, dynamic>.from(e);
    m['mtime'] = (m['mtime'] ?? m['updatedAt'] ?? '').toString();
    return m;
  }

  Future<void> _deleteNote(NoteItem n) async {
    if (_notesReadOnly) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(_notesNotice)));
      return;
    }
    final ok = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: const Text('删除笔记'),
      content: Text('删掉「' + n.title + '」？不可撤销。', style: const TextStyle(fontSize: 13)),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')), FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('删除'))],
    ));
    if (ok != true || !mounted) return;
    final r = await NotesSource.remove(n.id);
    if (!mounted) return;
    if (r != null && r['ok'] == true) {
      _reloadNotes();
    } else {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text('删除失败：' + (r == null ? '没连上主程序' : (r['error'] ?? '未知错误').toString()))));
    }
  }

  /// '2026-11-04 06:02' → '11-04'。统计卡窄，塞不下完整日期（原来会被截成「2026-1…」）。
  static String _shortDay(String mtime) {
    if (mtime.isEmpty) return '—';
    final d = mtime.split(' ').first;
    return d.length >= 10 ? d.substring(5) : d;
  }

  static String _initialView() {
    try {
      final v = readLocal('wg_notes_view');
      if (v == 'kanban' || v == 'canvas' || v == 'tree' || v == 'mindmap') {
        return v!;
      }
    } catch (_) {}
    // 2026-11-15：默认进「便当视图」。无限画布按每条笔记存的 x/y 摆位（旧窗口坐标），
    // 5 条笔记散在左上、右半屏全空，看起来像布局坏了；画布改为手动选择。
    return 'bento';
  }

  void _setView(String v) {
    setState(() => _view = v);
    try {
      writeLocal('wg_notes_view', v);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<List<NoteItem>>(
      future: _future,
      builder: (ctx, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snap.hasError) {
          return _Empty(
              icon: Icons.error_outline, title: '读取失败', hint: '${snap.error}');
        }
        final items = snap.data ?? const <NoteItem>[];
        if (items.isEmpty) {
          return _Empty(icon: Icons.note_alt_outlined, title: _notesNotice.isEmpty ? '本地还没有笔记数据' : _notesNotice);
        }
        _lastItems = items;
        return Focus(
          autofocus: true,
          onKeyEvent: (node, e) => _notesKey(e, items),
          child: Column(children: [
            if (_notesNotice.isNotEmpty) _NotesBanner(text: _notesNotice),
            _topBar(context, items),
            Expanded(child: _viewBody(context, items)),
          ]),
        );
      },
    );
  }

  Widget _topBar(BuildContext context, List<NoteItem> items) {
    final scheme = Theme.of(context).colorScheme;
    var latest = '';
    for (final n in items) {
      if (n.mtime.compareTo(latest) > 0) latest = n.mtime;
    }
    Widget stat(IconData icon, String value, String label) => Container(
          margin: const EdgeInsets.only(right: 8, bottom: 6),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          decoration: BoxDecoration(
            color: scheme.surface,
            borderRadius: BorderRadius.circular(WhaleTokens.rMd),
            border: Border.all(color: scheme.outlineVariant),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(icon, size: 16, color: scheme.primary),
            const SizedBox(width: 8),
            Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(value,
                      maxLines: 1,
                      style: TextStyle(
                          fontSize: WhaleTokens.fsSub,
                          fontWeight: FontWeight.w700,
                          color: scheme.onSurface)),
                  Text(label,
                      style: TextStyle(
                          fontSize: WhaleTokens.fsCaption,
                          color: scheme.onSurfaceVariant)),
                ]),
          ]),
        );
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        // 2026-11-15：条带按内容收，不再 stretch 撑满整行（原先一屏宽的框里只躺两张小卡）。
        Align(
          alignment: Alignment.centerLeft,
          child: Container(
            padding: const EdgeInsets.fromLTRB(8, 8, 8, 2),
            decoration: BoxDecoration(
              color: scheme.surfaceContainerLow,
              borderRadius: BorderRadius.circular(WhaleTokens.rLg),
              border: Border.all(color: scheme.outlineVariant),
            ),
            child: Wrap(children: [
              stat(Icons.auto_stories_outlined, items.length.toString(), '她整理的'),
              // 只显示 MM-DD：原来把 10 位完整日期塞进卡里，必被截成「2026-1…」。
              stat(Icons.schedule_outlined, _shortDay(latest), '最近更新'),
              if (_selectedId != null && items.any((n) => n.id == _selectedId))
                Padding(
                  padding: const EdgeInsets.only(left: 8),
                  child: Chip(
                    visualDensity: VisualDensity.compact,
                    label: Text('已选：' + items.firstWhere((n) => n.id == _selectedId).title, style: TextStyle(fontSize: WhaleTokens.fsCaption, color: Theme.of(context).colorScheme.onSurface)),
                  ),
                ),
            ]),
          ),
        ),
        const SizedBox(height: 6),
        // 底部留 10：切换器原来紧贴内容区边界，看起来压在分隔线上。
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Row(children: [
          const Spacer(),
          Focus(
            onKeyEvent: (node, event) {
              final k = event.logicalKey;
              if (k != LogicalKeyboardKey.arrowLeft && k != LogicalKeyboardKey.arrowRight) return KeyEventResult.ignored;
              const views = ['canvas', 'bento', 'kanban', 'tree', 'mindmap'];
              final i = views.indexOf(_view);
              final next = (i + (k == LogicalKeyboardKey.arrowRight ? 1 : -1)) % views.length;
              _setView(views[(next + views.length) % views.length]);
              return KeyEventResult.handled;
            },
            child: SegmentedButton<String>(
            segments: const [
              ButtonSegment(
                  value: 'canvas',
                  icon: FishTooltip(
                      message: '无限画布',
                      child:
                          Icon(Icons.dashboard_customize_outlined, size: 16))),
              ButtonSegment(
                  value: 'bento',
                  icon: FishTooltip(
                      message: '便当视图',
                      child: Icon(Icons.grid_view_outlined, size: 16))),
              ButtonSegment(
                  value: 'kanban',
                  icon: FishTooltip(
                      message: '看板视图',
                      child: Icon(Icons.view_kanban_outlined, size: 16))),
              ButtonSegment(
                  value: 'tree',
                  icon: FishTooltip(
                      message: '目录树',
                      child: Icon(Icons.account_tree_outlined, size: 16))),
              ButtonSegment(
                  value: 'mindmap',
                  icon: FishTooltip(
                      message: '导图',
                      child: Icon(Icons.hub_outlined, size: 16))),
            ],
            selected: {_view},
            onSelectionChanged: (v) => _setView(v.first),
            style: const ButtonStyle(visualDensity: VisualDensity.compact),
          ),
          ),
          ]),
        ),
      ]),
    );
  }

  Future<void> _openNote(BuildContext context, NoteItem n) async {
    final titleCtl = TextEditingController(text: n.title);
    final bodyCtl = TextEditingController(text: n.body);
    var state = '编辑中';
    var saving = false;
    var err = '';
    var savedAt = '';
    Future<void> Function()? saveNow;
    bool handleKeys(KeyEvent e) {
      if (e is KeyDownEvent && e.logicalKey == LogicalKeyboardKey.escape) {
        final nav = Navigator.of(context);
        if (nav.canPop()) nav.pop();
        return true;
      }
      if (e is KeyDownEvent && e.logicalKey == LogicalKeyboardKey.keyS && HardwareKeyboard.instance.isControlPressed) {
        saveNow?.call();
        return true;
      }
      return false;
    }
    HardwareKeyboard.instance.addHandler(handleKeys);
    try {
    await showGeneralDialog<void>(
      context: context,
      barrierDismissible: true,
      barrierLabel: 'close-note',
      barrierColor: Colors.black26,
      transitionDuration: const Duration(milliseconds: 220),
      pageBuilder: (ctx, _, __) {
        final scheme = Theme.of(ctx).colorScheme;
        final w = MediaQuery.sizeOf(ctx).width;
        return Align(
          alignment: Alignment.centerRight,
          child: Material(
            color: scheme.surface,
            child: SafeArea(
              child: SizedBox(
                width: w < 560 ? w * 0.94 : 460,
                height: double.infinity,
                child: StatefulBuilder(builder: (ctx2, setD) {
                  final dirty = titleCtl.text != n.title || bodyCtl.text != n.body;
                  Future<void> save() async {
                    if (_notesReadOnly) { setD(() { err = _notesNotice; }); return; }
                    final t = titleCtl.text.trim();
                    if (t.isEmpty) { setD(() { err = '标题不能为空'; }); return; }
                    setD(() { saving = true; state = '保存中…'; err = ''; });
                    final r = widget.saveNote != null
                        ? await widget.saveNote!(id: n.id, title: t, body: bodyCtl.text, folder: n.folder)
                        : await NotesSource.save(id: n.id, title: t, body: bodyCtl.text, folder: n.folder);
                    if (!mounted) return;
                    final ok = r != null && r['ok'] == true;
                    final hm = DateTime.now();
                    final hhmm = hm.hour.toString().padLeft(2, '0') + ':' + hm.minute.toString().padLeft(2, '0');
                    setD(() {
                      saving = false;
                      if (ok) { state = '已保存 ' + hhmm; savedAt = hhmm; } else { state = '保存失败'; err = r == null ? '没连上主程序' : (r['error'] ?? '未知错误').toString(); }
                    });
                    if (ok) { _reloadNotes(); }
                  }
                  saveNow = save;
                  Future<void> del() async {
                    Navigator.pop(ctx2);
                    await _deleteNote(n);
                  }
                  return Padding(
                    padding: const EdgeInsets.fromLTRB(18, 14, 18, 16),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Row(children: [
                        Icon(Icons.sticky_note_2_outlined, size: 18, color: scheme.primary),
                        const SizedBox(width: 8),
                        Text('编辑笔记', style: TextStyle(fontSize: WhaleTokens.fsSub, fontWeight: FontWeight.w700, color: scheme.onSurface)),
                        const Spacer(),
                        IconButton(onPressed: () => Navigator.pop(ctx2), icon: const Icon(Icons.close, size: 18)),
                      ]),
                      const SizedBox(height: 6),
                      Wrap(spacing: 6, runSpacing: 6, children: [
                        if (n.folder.trim().isNotEmpty) _chip(ctx2, Icons.folder_outlined, n.folder),
                        if (n.src.isNotEmpty) _chip(ctx2, Icons.account_tree_outlined, n.src == 'mindmap' ? '导图节点' : n.src),
                      ]),
                      const SizedBox(height: 12),
                      TextField(controller: titleCtl, onChanged: (_) => setD(() {}), style: TextStyle(fontSize: WhaleTokens.fsPage, fontWeight: FontWeight.w700, color: scheme.onSurface), decoration: const InputDecoration(labelText: '标题', border: OutlineInputBorder(), isDense: true)),
                      const SizedBox(height: 12),
                      Expanded(child: TextField(controller: bodyCtl, onChanged: (_) => setD(() {}), maxLines: null, expands: true, style: TextStyle(fontSize: WhaleTokens.fsBody, height: 1.7, color: scheme.onSurface), decoration: const InputDecoration(labelText: '正文', alignLabelWithHint: true, border: OutlineInputBorder(), isDense: true))),
                      const SizedBox(height: 10),
                      Row(children: [
                        if (err.isNotEmpty) Expanded(child: Text(err, style: TextStyle(fontSize: 12, color: scheme.error))),
                        if (err.isNotEmpty) TextButton(onPressed: saving ? null : save, child: const Text('重试')),
                        if (err.isEmpty) Expanded(child: Text(dirty && savedAt.isEmpty ? '编辑中 · 有未保存的修改' : state, style: TextStyle(fontSize: 12, color: dirty && savedAt.isEmpty ? scheme.onSurfaceVariant : WhaleTokens.successFor(scheme.brightness)))),
                        TextButton(onPressed: () => del(), child: const Text('删除')),
                        const SizedBox(width: 6),
                        TextButton(onPressed: () => Navigator.pop(ctx2), child: const Text('取消')),
                        const SizedBox(width: 6),
                        FilledButton(onPressed: saving ? null : save, child: Text(saving ? '保存中…' : '保存')),
                      ]),
                    ]),
                  );
                }),
              ),
            ),
          ),
        );
      },
      transitionBuilder: (ctx, anim, _, child) => SlideTransition(
        position: Tween<Offset>(begin: const Offset(1, 0), end: Offset.zero).animate(CurvedAnimation(parent: anim, curve: Curves.easeOutCubic)),
        child: child,
      ),
    );
    } finally {
      HardwareKeyboard.instance.removeHandler(handleKeys);
    }
    titleCtl.dispose();
    bodyCtl.dispose();
  }
  Widget _chip(BuildContext context, IconData icon, String text) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
          color: scheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(999)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 12, color: scheme.onSurfaceVariant),
        const SizedBox(width: 4),
        Text(text,
            style: TextStyle(
                fontSize: WhaleTokens.fsCaption,
                color: scheme.onSurfaceVariant)),
      ]),
    );
  }

  Widget _tree(BuildContext context, List<NoteItem> items) {
    final scheme = Theme.of(context).colorScheme;
    final Map<String, List<NoteItem>> groups = {};
    for (final n in items) {
      final k = n.folder.trim().isNotEmpty
          ? n.folder.trim()
          : (n.src == 'favorite' ? '收藏' : '未分组');
      groups.putIfAbsent(k, () => []).add(n);
    }
    final keys = groups.keys.toList()..sort((a, b) => a.compareTo(b));
    return ListView(
      key: const PageStorageKey('notes-scroll-tree'),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 20),
      children: [
        for (final k in keys)
          Container(
            margin: const EdgeInsets.only(bottom: 10),
            decoration: BoxDecoration(
              color: scheme.surfaceContainerLow,
              borderRadius: BorderRadius.circular(WhaleTokens.rLg),
              border: Border.all(color: scheme.outlineVariant),
            ),
            child: Theme(
              data:
                  Theme.of(context).copyWith(dividerColor: Colors.transparent),
              child: ExpansionTile(
                initiallyExpanded: true,
                leading: Icon(Icons.folder_outlined,
                    size: 17, color: scheme.primary),
                title: Text(k,
                    style: TextStyle(
                        fontSize: WhaleTokens.fsSmall,
                        fontWeight: FontWeight.w700,
                        color: scheme.onSurface)),
                subtitle: Text('${groups[k]!.length} 条',
                    style: TextStyle(
                        fontSize: WhaleTokens.fsCaption,
                        color: scheme.onSurfaceVariant)),
                children: [
                  for (final n in groups[k]!)
                    ListTile(
                      dense: true,
                      visualDensity: VisualDensity.compact,
                      contentPadding:
                          const EdgeInsets.only(left: 44, right: 14),
                      onTap: () => _openNote(context, n),
                      title: Text(n.title,
                          maxLines: 3,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                              fontSize: WhaleTokens.fsBody,
                              height: 1.45,
                              color: scheme.onSurface)),
                      subtitle: n.mtime.isEmpty
                          ? null
                          : Text(n.mtime,
                              style: TextStyle(
                                  fontSize: WhaleTokens.fsCaption,
                                  color: scheme.onSurfaceVariant)),
                    ),
                ],
              ),
            ),
          ),
      ],
    );
  }

  Widget _mindmap(BuildContext context, List<NoteItem> items) {
    final scheme = Theme.of(context).colorScheme;
    const nw = 168.0;
    const nh = 46.0;
    const pad = 30.0;
    const gap = 26.0;
    final groups = <String, List<NoteItem>>{};
    for (final n in items) {
      final k = n.folder.trim().isNotEmpty
          ? n.folder.trim()
          : (n.src == 'favorite' ? '收藏' : '未分组');
      groups.putIfAbsent(k, () => []).add(n);
    }
    final keys = groups.keys.toList()..sort();
    final rects = <String, Rect>{};
    final labels = <String, double>{};
    var totalW = 0.0;
    var cursorY = pad;
    for (final k in keys) {
      final list = groups[k]!;
      var gminX = double.infinity,
          gminY = double.infinity,
          gmaxX = -1e9,
          gmaxY = -1e9;
      for (final n in list) {
        if (n.x < gminX) gminX = n.x;
        if (n.y < gminY) gminY = n.y;
        if (n.x + nw > gmaxX) gmaxX = n.x + nw;
        if (n.y + nh > gmaxY) gmaxY = n.y + nh;
      }
      if (!gminX.isFinite) {
        gminX = 0;
        gminY = 0;
        gmaxX = 800;
        gmaxY = 600;
      }
      final gw = (gmaxX - gminX) + pad * 2;
      final gh = (gmaxY - gminY) + pad * 2;
      if (gw > totalW) totalW = gw;
      labels[k] = cursorY;
      for (final n in list) {
        rects[n.id] = Rect.fromLTWH(
            n.x - gminX + pad, cursorY + (n.y - gminY + pad), nw, nh);
      }
      cursorY += gh + gap;
    }
    final w = totalW;
    final h = cursorY;
    final sc = ((MediaQuery.sizeOf(context).width - 320) / w).clamp(0.2, 1.0);
    final ids = {for (final n in items) n.id};
    final folderOf = {for (final n in items) n.id: n.folder};
    final edges = <List<String>>[];
    for (final n in items) {
      if (n.parent.isNotEmpty &&
          ids.contains(n.parent) &&
          folderOf[n.parent] == n.folder) {
        edges.add([n.parent, n.id]);
      }
      for (final l in n.links) {
        if (ids.contains(l) && folderOf[l] == n.folder) edges.add([n.id, l]);
      }
    }
    final sr = {
      for (final e in rects.entries)
        e.key: Rect.fromLTWH(
            e.value.left * sc, e.value.top * sc, e.value.width, e.value.height)
    };
    return InteractiveViewer(
      minScale: 0.35,
      maxScale: 2.0,
      constrained: false,
      boundaryMargin: const EdgeInsets.all(120),
      child: SizedBox(
        width: w * sc,
        height: h * sc,
        child: Stack(children: [
          Positioned.fill(
              child: CustomPaint(
                  painter: _NoteEdgePainter(
                      rects: sr, edges: edges, color: scheme.outline))),
          for (final k in keys)
            Positioned(
                left: 6,
                top: labels[k]! * sc,
                child: Text(k,
                    style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                        color: scheme.primary))),
          for (final n in items)
            Positioned(
              left: sr[n.id]!.left,
              top: sr[n.id]!.top,
              width: nw,
              height: nh,
              child: Material(
                color:
                    n.parent.isEmpty ? scheme.primaryContainer : scheme.surface,
                borderRadius: BorderRadius.circular(WhaleTokens.rMd),
                child: InkWell(
                  borderRadius: BorderRadius.circular(WhaleTokens.rMd),
                  onTap: () => _openNote(context, n),
                  child: Container(
                    alignment: Alignment.centerLeft,
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(WhaleTokens.rMd),
                      border: Border.all(
                          color: n.parent.isEmpty
                              ? scheme.primary
                              : scheme.outlineVariant),
                    ),
                    child: Text(n.title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                            fontSize: WhaleTokens.fsSmall,
                            height: 1.3,
                            fontWeight: n.parent.isEmpty
                                ? FontWeight.w700
                                : FontWeight.w500,
                            color: n.parent.isEmpty
                                ? scheme.onPrimaryContainer
                                : scheme.onSurface)),
                  ),
                ),
              ),
            ),
        ]),
      ),
    );
  }

  Widget _kanban(BuildContext context, List<NoteItem> items) {
    final scheme = Theme.of(context).colorScheme;
    final Map<String, List<NoteItem>> cols = {};
    for (final n in items) {
      final key = n.folder.trim().isNotEmpty ? n.folder.trim() : (n.src == 'favorite' ? '收藏' : '未分组');
      cols.putIfAbsent(key, () => []).add(n);
    }
    final keys = cols.keys.toList()..sort((x, y) => cols[y]!.length.compareTo(cols[x]!.length));
    return SingleChildScrollView(
      key: PageStorageKey('notes-scroll-kanban'),
      padding: const EdgeInsets.all(12),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          for (final k in keys)
            Container(
              width: 280,
              margin: const EdgeInsets.only(right: 12),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: scheme.surfaceContainerLow,
                borderRadius: BorderRadius.circular(WhaleTokens.rLg),
                border: Border.all(color: scheme.outlineVariant),
              ),
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Row(children: [
                  Icon(Icons.folder_outlined, size: 15, color: scheme.onSurfaceVariant),
                  const SizedBox(width: 6),
                  Expanded(child: Text(k, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: WhaleTokens.fsSmall, fontWeight: FontWeight.w700, color: scheme.onSurface))),
                  Container(padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1), decoration: BoxDecoration(color: scheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(999)), child: Text(cols[k]!.length.toString(), style: TextStyle(fontSize: WhaleTokens.fsCaption, color: scheme.onSurfaceVariant))),
                ]),
                const SizedBox(height: 8),
                for (final n in cols[k]!) _kanbanCard(context, n),
                if (cols[k]!.isEmpty)
                  Text('这一栏还没有笔记', style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurfaceVariant)),
              ]),
            ),
        ]),
      ),
    );
  }

  Widget _kanbanCard(BuildContext context, NoteItem n) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.fromLTRB(11, 9, 11, 9),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(WhaleTokens.rMd),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: InkWell(
        onTap: () => _openNote(context, n),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(n.title,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                  fontSize: WhaleTokens.fsBody,
                  height: 1.45,
                  color: scheme.onSurface)),
          if (n.mtime.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 5),
              child: Text(n.mtime,
                  style: TextStyle(
                      fontSize: WhaleTokens.fsCaption,
                      color: scheme.onSurfaceVariant)),
            ),
        ]),
      ),
    );
  }
}

class _NoteEdgePainter extends CustomPainter {
  final Map<String, Rect> rects;
  final List<List<String>> edges;
  final Color color;
  _NoteEdgePainter(
      {required this.rects, required this.edges, required this.color});
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()
      ..color = color.withValues(alpha: 0.55)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.4;
    for (final e in edges) {
      final a = rects[e[0]], b = rects[e[1]];
      if (a == null || b == null) continue;
      final p1 = a.centerRight, p2 = b.centerLeft;
      final dx = ((p2.dx - p1.dx).abs() / 2).clamp(20.0, 120.0);
      final path = Path()
        ..moveTo(p1.dx, p1.dy)
        ..cubicTo(p1.dx + dx, p1.dy, p2.dx - dx, p2.dy, p2.dx, p2.dy);
      canvas.drawPath(path, p);
    }
  }

  @override
  bool shouldRepaint(covariant _NoteEdgePainter old) =>
      old.edges != edges || old.rects != rects;
}

// ---------------- 记忆 ----------------
class MemoryPage extends StatefulWidget {
  const MemoryPage({super.key});
  @override
  State<MemoryPage> createState() => _MemoryPageState();
}

class _MemoryPageState extends State<MemoryPage> {
  late final Future<MemorySnapshot> _future = WhaleData.memory();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return FutureBuilder<MemorySnapshot>(
      future: _future,
      builder: (ctx, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snap.hasError) {
          return _Empty(
              icon: Icons.error_outline, title: '读取失败', hint: '${snap.error}');
        }
        final m = snap.data;
        final list = m?.personas ?? const <PersonaItem>[];
        if (list.isEmpty) {
          return const _Empty(icon: Icons.psychology_outlined, title: '还没有记忆');
        }
        return SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: bentoWrap([
            SizedBentoCard(
              id: 'mem-kb',
              defaultWidth: 340,
              defaultHeight: 170,
              child: BentoPanel(
                title: '知识库',
                note: '由鱼的世界维护',
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('梗 / 外观 / 约定 —— 条目 8763 条',
                          style: TextStyle(
                              fontSize: WhaleTokens.fsBody,
                              color: scheme.onSurface)),
                      const Spacer(),
                      Text('位置：鱼的记忆/知识库.json（本页只读人设，知识库在桌面端管理）',
                          style: TextStyle(
                              fontSize: WhaleTokens.fsSmall,
                              height: 1.5,
                              color: scheme.onSurfaceVariant)),
                    ]),
              ),
            ),
            SizedBentoCard(
              id: 'mem-count',
              defaultWidth: 220,
              defaultHeight: 170,
              child: BentoPanel(
                title: '人设',
                child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('${list.length}',
                          style: TextStyle(
                              fontSize: 34,
                              fontWeight: FontWeight.w700,
                              color: scheme.primary)),
                      Text('个角色设定',
                          style: TextStyle(
                              fontSize: WhaleTokens.fsSmall,
                              color: scheme.onSurfaceVariant)),
                    ]),
              ),
            ),
            for (final p in list)
              SizedBentoCard(
                id: 'mem-${p.id}',
                defaultWidth: 340,
                defaultHeight: 190,
                child: BentoPanel(
                  title: p.name,
                  note: p.id == m?.active ? '当前' : null,
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(p.preview,
                            maxLines: 4,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                                fontSize: WhaleTokens.fsBody,
                                height: 1.6,
                                color: scheme.onSurfaceVariant)),
                        const Spacer(),
                        Text('共 ${p.length} 字',
                            style: TextStyle(
                                fontSize: WhaleTokens.fsCaption,
                                color: scheme.onSurfaceVariant
                                    .withValues(alpha: 0.8))),
                      ]),
                ),
              ),
          ]),
        );
      },
    );
  }
}

// ---------------- 成长 ----------------
class GrowthPage extends StatefulWidget {
  const GrowthPage({super.key});
  @override
  State<GrowthPage> createState() => _GrowthPageState();
}

class _GrowthPageState extends State<GrowthPage> {
  late final Future<List<GrowthItem>> _f = WhaleDataMore.growth();

  static String _kindLabel(String k) {
    switch (k) {
      case 'insight':
        return '认识';
      case 'next':
        return '下一步';
      case 'milestone':
        return '里程碑';
      default:
        return k;
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return FutureBuilder<List<GrowthItem>>(
      future: _f,
      builder: (ctx, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snap.hasError) {
          return _Empty(
              icon: Icons.error_outline, title: '读取失败', hint: '${snap.error}');
        }
        final items = snap.data ?? const <GrowthItem>[];
        if (items.isEmpty) {
          return const _Empty(
              icon: Icons.trending_up_outlined, title: '还没有成长记录');
        }
        return SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: bentoWrap([
            SizedBentoCard(
              id: 'gr-overview',
              defaultWidth: 320,
              defaultHeight: 160,
              child: BentoPanel(
                title: '成长概况',
                note: '幼鱼',
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('刚开始记事，什么都很新鲜。',
                          style: TextStyle(
                              fontSize: WhaleTokens.fsBody,
                              color: scheme.onSurface)),
                      const Spacer(),
                      Text('记录 ${items.length} 条',
                          style: TextStyle(
                              fontSize: WhaleTokens.fsSmall,
                              color: scheme.onSurfaceVariant)),
                    ]),
              ),
            ),
            SizedBentoCard(
              id: 'gr-life',
              defaultWidth: 360,
              defaultHeight: 160,
              child: BentoPanel(
                title: '和主人的生活记录',
                note: '从第一次聊天开始算',
                child: Center(
                    child: Text('还没有和主人说过话。收到第一条消息后，这里会开始记。',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                            fontSize: WhaleTokens.fsSmall,
                            color: scheme.onSurfaceVariant))),
              ),
            ),
            for (var i = 0; i < items.length; i++)
              SizedBentoCard(
                id: 'gr-$i',
                defaultWidth: 460,
                defaultHeight: 180,
                child: BentoPanel(
                  title: '成长记录',
                  note: '${items[i].day} · ${_kindLabel(items[i].kind)}',
                  child: Text(items[i].text,
                      maxLines: 4,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          fontSize: WhaleTokens.fsBody,
                          height: 1.6,
                          color: scheme.onSurface)),
                ),
              ),
          ]),
        );
      },
    );
  }
}

// ---------------- 日记 ----------------
class DiaryPage extends StatefulWidget {
  const DiaryPage({super.key});
  @override
  State<DiaryPage> createState() => _DiaryPageState();
}

class _DiaryPageState extends State<DiaryPage> {
  late final Future<List<DiaryItem>> _f = WhaleDiary.load();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return FutureBuilder<List<DiaryItem>>(
      future: _f,
      builder: (ctx, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snap.hasError) {
          return _Empty(
              icon: Icons.error_outline, title: '读取失败', hint: '${snap.error}');
        }
        final items = snap.data ?? const <DiaryItem>[];
        if (items.isEmpty) {
          return const _Empty(icon: Icons.book_outlined, title: '她还没写过日记');
        }
        return SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: bentoWrap([
            SizedBentoCard(
              id: 'diary-count',
              defaultWidth: 220,
              defaultHeight: 150,
              child: BentoPanel(
                title: '日记',
                child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('${items.length}',
                          style: TextStyle(
                              fontSize: 34,
                              fontWeight: FontWeight.w700,
                              color: scheme.primary)),
                      Text('篇（含待确认）',
                          style: TextStyle(
                              fontSize: WhaleTokens.fsSmall,
                              color: scheme.onSurfaceVariant)),
                    ]),
              ),
            ),
            for (var i = 0; i < items.length; i++)
              SizedBentoCard(
                id: 'diary-$i',
                defaultWidth: 420,
                defaultHeight: 190,
                child: BentoPanel(
                  title: items[i].date,
                  note: items[i].status == 'approved' ? null : '待确认',
                  child: Text(items[i].text,
                      maxLines: 4,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          fontSize: WhaleTokens.fsBody,
                          height: 1.7,
                          color: scheme.onSurface)),
                ),
              ),
          ]),
        );
      },
    );
  }
}

// ---------------- 通用列表（愿望/图库/链接） ----------------
class SimpleListPage extends StatefulWidget {
  final String file;
  final String emptyText;
  final IconData icon;
  const SimpleListPage(
      {super.key,
      required this.file,
      required this.emptyText,
      required this.icon});
  @override
  State<SimpleListPage> createState() => _SimpleListPageState();
}

class _SimpleListPageState extends State<SimpleListPage> {
  late final Future<List<SimpleItem>> _f = WhaleDataMore.simple(widget.file);

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return FutureBuilder<List<SimpleItem>>(
      future: _f,
      builder: (ctx, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snap.hasError) {
          return _Empty(
              icon: Icons.error_outline, title: '读取失败', hint: '${snap.error}');
        }
        final items = snap.data ?? const <SimpleItem>[];
        if (items.isEmpty) {
          return _Empty(icon: widget.icon, title: widget.emptyText);
        }
        return SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: bentoWrap([
            SizedBentoCard(
              id: 'list-count-${widget.file}',
              defaultWidth: 200,
              defaultHeight: 130,
              child: BentoPanel(
                title: '共',
                child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('${items.length}',
                          style: TextStyle(
                              fontSize: 34,
                              fontWeight: FontWeight.w700,
                              color: scheme.primary)),
                      Text('个',
                          style: TextStyle(
                              fontSize: WhaleTokens.fsSmall,
                              color: scheme.onSurfaceVariant)),
                    ]),
              ),
            ),
            for (var i = 0; i < items.length; i++)
              SizedBentoCard(
                id: 'item-${widget.file}-$i',
                defaultWidth: 180,
                defaultHeight: 88,
                minWidth: 120,
                minHeight: 64,
                child: Card(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 12, vertical: 10),
                    child: Row(children: [
                      Icon(widget.icon,
                          size: 16, color: scheme.onSurfaceVariant),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(items[i].name,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                                fontSize: WhaleTokens.fsBody,
                                color: scheme.onSurface)),
                      ),
                    ]),
                  ),
                ),
              ),
          ]),
        );
      },
    );
  }
}

// ---------------- 鱼的收藏（图片收藏 + 链接收藏） ----------------
class CollectionsPage extends StatefulWidget {
  final int initialTab;
  const CollectionsPage({super.key, this.initialTab = 0});
  @override
  State<CollectionsPage> createState() => _CollectionsPageState();
}

class _CollectionsPageState extends State<CollectionsPage> {
  late int _tab = widget.initialTab;
  late final Future<List<List<SimpleItem>>> _f = Future.wait([
    WhaleDataMore.gallery(),
    WhaleDataMore.links(),
  ]);

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return FutureBuilder<List<List<SimpleItem>>>(
      future: _f,
      builder: (ctx, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snap.hasError) {
          return _Empty(
              icon: Icons.error_outline, title: '读取失败', hint: '${snap.error}');
        }
        final imgs = snap.data?[0] ?? const <SimpleItem>[];
        final links = snap.data?[1] ?? const <SimpleItem>[];
        final items = _tab == 0 ? imgs : links;
        final icon = _tab == 0 ? Icons.image_outlined : Icons.link_outlined;
        return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 14, 16, 4),
                child: Row(children: [
                  _tabChip('图片收藏', 0, imgs.length),
                  const SizedBox(width: 8),
                  _tabChip('链接收藏', 1, links.length),
                ]),
              ),
              Expanded(
                child: items.isEmpty
                    ? _Empty(
                        icon: icon, title: _tab == 0 ? '图库还是空的' : '还没有收藏的链接')
                    : LayoutBuilder(builder: (_, box) {
                        final pad = box.maxWidth >= 900 ? 16.0 : 10.0;
                        final avail = box.maxWidth - pad * 2;
                        final double gap = box.maxWidth >= 900 ? 12 : 8;
                        final int cols = avail >= 1600
                            ? 8
                            : avail >= 1280
                                ? 7
                                : avail >= 960
                                    ? 5
                                    : avail >= 620
                                        ? 3
                                        : 2;
                        final unit = (avail - gap * (cols - 1)) / cols;
                        final double ch =
                            _tab == 0 ? (unit * 0.72).clamp(96.0, 150.0) : 84.0;
                        return SingleChildScrollView(
                          padding: EdgeInsets.all(pad),
                          child: BentoBoard(
                            boardId: 'collections-$_tab',
                            items: [
                              for (var i = 0; i < items.length; i++)
                                BentoItem(
                                  id: 'c$i',
                                  width: unit,
                                  height: ch,
                                  child: Card(
                                    child: Padding(
                                      padding: const EdgeInsets.symmetric(
                                          horizontal: 12, vertical: 10),
                                      child: Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            Icon(icon,
                                                size: 15,
                                                color: _tab == 0
                                                    ? scheme.primary
                                                    : scheme.onSurfaceVariant),
                                            const Spacer(),
                                            Text(items[i].name,
                                                maxLines: 2,
                                                overflow: TextOverflow.ellipsis,
                                                style: TextStyle(
                                                    fontSize:
                                                        WhaleTokens.fsBody,
                                                    color: scheme.onSurface)),
                                          ]),
                                    ),
                                  ),
                                ),
                            ],
                          ),
                        );
                      }),
              ),
            ]);
      },
    );
  }

  Widget _tabChip(String label, int idx, int count) {
    final on = _tab == idx;
    final scheme = Theme.of(context).colorScheme;
    return ChoiceChip(
      label: Text('$label · $count'),
      selected: on,
      onSelected: (_) => setState(() => _tab = idx),
      // 选中：用主题容器色 + 对应前景色（深/浅都对比够）
      selectedColor: scheme.primaryContainer,
      backgroundColor: scheme.surfaceContainerHighest,
      side: BorderSide(color: on ? scheme.primary : scheme.outlineVariant),
      showCheckmark: false,
      labelStyle: TextStyle(
        fontSize: WhaleTokens.fsSmall,
        fontWeight: on ? FontWeight.w600 : FontWeight.w400,
        color: on ? scheme.onPrimaryContainer : scheme.onSurfaceVariant,
      ),
    );
  }
}

// ---------------- 关于 ----------------
class AboutPage extends StatelessWidget {
  const AboutPage({super.key});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    Widget kv(String k, String v) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SizedBox(
                width: 88,
                child: Text(k,
                    style: TextStyle(
                        fontSize: WhaleTokens.fsBody,
                        color: scheme.onSurfaceVariant))),
            Expanded(
                child: Text(v,
                    style: TextStyle(
                        fontSize: WhaleTokens.fsBody,
                        color: scheme.onSurface))),
          ]),
        );
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _Panel(children: [
          Row(children: [
            Image.asset('assets/whale-logo.png', width: 40, height: 40),
            const SizedBox(width: 12),
            Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('蓝鲸娘',
                  style: TextStyle(
                      fontSize: WhaleTokens.fsPage,
                      fontWeight: FontWeight.w700,
                      color: scheme.onSurface)),
              Text('DeepSeek 小鲸鱼',
                  style: TextStyle(
                      fontSize: WhaleTokens.fsSmall,
                      color: scheme.onSurfaceVariant)),
            ]),
          ]),
        ]),
        _Panel(title: '版本', children: [
          kv('应用', appVersion),
          kv('插件', pluginVersion),
        ]),
        _Panel(title: '说明', children: [
          Text('角色设计与立绘归 QQ 机器人线；这里只做客户端外壳。',
              style: TextStyle(
                  fontSize: WhaleTokens.fsBody,
                  color: scheme.onSurfaceVariant)),
        ]),
      ],
    );
  }
}
