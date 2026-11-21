import 'dart:async';

import 'package:flutter/material.dart';
import 'theme/whale_tokens.dart';
import 'fish/ui_kit/ui_kit.dart';
import 'data/qq_gateway.dart';
import 'desktop/chat_bridge.dart';
import 'feedback.dart';
import 'avatar_tap.dart';
import 'chat_feed.dart';
import 'ui_motion.dart';

String _fmt(DateTime t) =>
    '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

class ChatPanel extends StatefulWidget {
  final double? width;
  final Widget? leading;
  const ChatPanel({super.key, this.width = 380, this.leading});

  @override
  State<ChatPanel> createState() => _ChatPanelState();
}

class _ChatPanelState extends State<ChatPanel> {
  List<ChatMessage> get _messages => chatFeed;
  final _scrollCtl = ScrollController();
  StreamSubscription<Map<String, String>>? _qqSub;
  bool get _desktop => qqGateway.isDesktop;

  @override
  void initState() {
    super.initState();
    chatFeedTick.addListener(_onFeed);
    if (_desktop) {
      _qqSub = chatEvents.listen((e) {
        if (!mounted) return;
        final text = (e['text'] ?? '').trim();
        if (text.isEmpty) return;
        addChatMessage(text,
            role: e['kind'] == 'in' ? MessageRole.user : MessageRole.ai);
      });
    }
  }

  void _onFeed() {
    if (!mounted) return;
    setState(() {});
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollCtl.hasClients)
        _scrollCtl.jumpTo(_scrollCtl.position.maxScrollExtent);
    });
  }

  @override
  void dispose() {
    chatFeedTick.removeListener(_onFeed);
    _qqSub?.cancel();
    _scrollCtl.dispose();
    super.dispose();
  }

  bool _waiting = false;

  Future<void> _handleSend(String text) async {
    final v = text.trim();
    if (v.isEmpty || _waiting) return;
    sayFeedback('在想了…');
    setState(() => _waiting = true);
    addChatMessage(v, role: MessageRole.user);
    final history = _messages
        .where((m) => !m.isProactive)
        .map((m) => {
              'role': m.role == MessageRole.user ? 'user' : 'assistant',
              'content': m.text,
            })
        .toList();
    final res = await chatReply(history);
    String reply;
    if (res == null) {
      reply = _desktop
          ? '（本地模型没答上：去设置看看 API 地址 / 模型 / Key）'
          : '（没连上主程序：先把蓝鲸娘应用开着，再试一次）';
    } else if (res['ok'] == true) {
      reply = (res['reply'] ?? '').toString();
      if (reply.isEmpty) reply = '（她没说话）';
    } else {
      reply = '连上了但没答上：${res['error'] ?? '未知'}';
    }
    if (!mounted) return;
    sayFeedback(res == null
        ? (_desktop ? '本地模型没答上' : '没连上主程序')
        : (res['ok'] == true ? '说完啦' : '没答上'));
    setState(() => _waiting = false);
    addChatMessage(reply);
  }

  void _newChat() {
    clearChatFeed();
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      width: widget.width,
      color: Colors.transparent,
      child: Column(children: [
        _Header(leading: widget.leading, onNew: _newChat),
        Expanded(
          child: _messages.isEmpty
              ? const _EmptyChat()
              : ListView.builder(
                  controller: _scrollCtl,
                  primary: false,
                  // 贴边但别贴死：左右 14，仍随窗口自适应
                  padding: const EdgeInsets.fromLTRB(WhaleTokens.pageGutter,
                      WhaleTokens.pageGutter, WhaleTokens.pageGutter, 110),
                  itemCount: _messages.length + 1,
                  itemBuilder: (_, i) => i == 0
                      ? const _DayDivider('今天')
                      : _MessageBubble(_messages[i - 1]),
                ),
        ),
        _InputArea(onSend: _handleSend),
      ]),
    );
  }
}

/// 顶栏：头像 + 名字 + 状态药丸 + 新对话（照 DSH 主对话的样子）
class _Header extends StatelessWidget {
  final Widget? leading;
  final VoidCallback onNew;
  const _Header({this.leading, required this.onNew});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return LayoutBuilder(builder: (ctx, cons) {
      final narrow = cons.maxWidth < 520;
      return FishPageHeader(
        leading: leading ?? AvatarTap(radius: 13),
        title: '蓝鲸娘',
        trailing: Row(mainAxisSize: MainAxisSize.min, children: [
          if (!narrow) ...[
            const _StatusPill(text: '在线 · 本地'),
            const SizedBox(width: 10)
          ],
          FilledButton(
            onPressed: onNew,
            style: FilledButton.styleFrom(
              backgroundColor: scheme.primary.withValues(alpha: 0.16),
              foregroundColor: scheme.primary,
              padding:
                  narrow ? const EdgeInsets.symmetric(horizontal: 8) : null,
            ),
            child:
                narrow ? const Icon(Icons.add, size: 18) : const Text('＋ 新对话'),
          ),
          const SizedBox(width: 4),
          IconButton(
              icon: Icon(Icons.more_horiz, color: scheme.onSurfaceVariant),
              onPressed: () {}),
        ]),
      );
    });
  }
}

class _StatusPill extends StatelessWidget {
  final String text;
  const _StatusPill({required this.text});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: scheme.primary.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Container(
          width: 6,
          height: 6,
          decoration: const BoxDecoration(
              color: WhaleTokens.onlineGreen, shape: BoxShape.circle),
        ),
        const SizedBox(width: 6),
        Text(text,
            style: TextStyle(
                fontSize: WhaleTokens.fsCaption,
                color: scheme.onSurfaceVariant)),
      ]),
    );
  }
}

class _DayDivider extends StatelessWidget {
  final String text;
  const _DayDivider(this.text);

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Center(
        child: Text(text,
            style: TextStyle(
                fontSize: WhaleTokens.fsCaption,
                color: scheme.onSurfaceVariant.withValues(alpha: 0.8))),
      ),
    );
  }
}

class _EmptyChat extends StatelessWidget {
  const _EmptyChat();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Icon(Icons.chat_bubble_outline,
            size: 40, color: scheme.onSurfaceVariant.withValues(alpha: 0.55)),
        const SizedBox(height: 12),
        Text('还没聊过',
            style: TextStyle(
                fontSize: WhaleTokens.fsBody, color: scheme.onSurfaceVariant)),
        const SizedBox(height: 6),
        Text('在下面说点什么，她就来了',
            style: TextStyle(
                fontSize: WhaleTokens.fsSmall,
                color: scheme.onSurfaceVariant.withValues(alpha: 0.7))),
      ]),
    );
  }
}

class _MessageBubble extends StatelessWidget {
  final ChatMessage msg;
  const _MessageBubble(this.msg);

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final isAi = msg.role == MessageRole.ai;
    final dark = Theme.of(context).brightness == Brightness.dark;

    // 沉浸式：AI 是极浅半透明，用户是低饱和深蓝；都不描边。
    final bg = isAi
        ? (dark
            ? Colors.white.withValues(alpha: 0.05)
            : Colors.black.withValues(alpha: 0.04))
        : WhaleTokens.bubbleUserFor(scheme);
    final fg = isAi ? scheme.onSurface : WhaleTokens.bubbleUserFgFor(scheme);

    return LayoutBuilder(
      builder: (_, c) {
        final maxW = c.maxWidth * 0.78;
        return Align(
          alignment: isAi ? Alignment.centerLeft : Alignment.centerRight,
          child: Container(
            margin: const EdgeInsets.only(bottom: 16),
            constraints: BoxConstraints(maxWidth: maxW),
            child: Column(
              crossAxisAlignment:
                  isAi ? CrossAxisAlignment.start : CrossAxisAlignment.end,
              children: [
                Container(
                  padding: const EdgeInsets.fromLTRB(16, 13, 16, 13),
                  decoration: BoxDecoration(
                    color: bg,
                    borderRadius: BorderRadius.circular(16),
                    boxShadow: isAi
                        ? null
                        : [
                            BoxShadow(
                                color: Colors.black
                                    .withValues(alpha: dark ? 0.14 : 0.06),
                                blurRadius: 14,
                                offset: const Offset(0, 4))
                          ],
                  ),
                  child: Text(msg.text,
                      style: TextStyle(color: fg, fontSize: 13, height: 1.7)),
                ),
                Padding(
                  padding: const EdgeInsets.only(top: 5, left: 4, right: 4),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    Text(_fmt(msg.time),
                        style: TextStyle(
                            fontSize: WhaleTokens.fsCaption,
                            color: scheme.onSurfaceVariant
                                .withValues(alpha: 0.65))),
                    if (isAi && msg.isProactive) ...[
                      const SizedBox(width: 8),
                      Text('她主动',
                          style: TextStyle(
                              fontSize: WhaleTokens.fsCaption,
                              color: scheme.onSurfaceVariant
                                  .withValues(alpha: 0.65))),
                    ],
                  ]),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _InputArea extends StatefulWidget {
  final ValueChanged<String> onSend;
  const _InputArea({required this.onSend});

  @override
  State<_InputArea> createState() => _InputAreaState();
}

class _InputAreaState extends State<_InputArea> {
  final _ctrl = TextEditingController();
  final _focus = FocusNode();
  bool _focused = false;
  bool get _canSend => _ctrl.text.trim().isNotEmpty;

  @override
  void initState() {
    super.initState();
    _focus.addListener(() {
      if (mounted) setState(() => _focused = _focus.hasFocus);
    });
  }

  @override
  void dispose() {
    _focus.dispose();
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Padding(
      padding: const EdgeInsets.fromLTRB(
          WhaleTokens.pageGutter, 8, WhaleTokens.pageGutter, 22),
      child: FocusSweepBorder(
        focused: _focused,
        radius: 14,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 140),
          padding: const EdgeInsets.fromLTRB(16, 4, 6, 4),
          decoration: BoxDecoration(
            color: dark ? const Color(0xFF161A21) : const Color(0xFFF1F4F9),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Expanded(
              child: TextField(
                controller: _ctrl,
                focusNode: _focus,
                minLines: 1,
                maxLines: 5,
                onChanged: (_) => setState(() {}),
                style: TextStyle(fontSize: 13, color: scheme.onSurface),
                decoration: InputDecoration(
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                  isDense: true,
                  contentPadding: const EdgeInsets.symmetric(vertical: 12),
                  hintText: '和鲸鱼娘说点什么…',
                  hintStyle: TextStyle(
                      fontSize: 13,
                      color: scheme.onSurfaceVariant.withValues(alpha: 0.75)),
                ),
              ),
            ),
            const SizedBox(width: 2),
            SizedBox(
              width: 36,
              height: 36,
              child: IconButton(
                padding: EdgeInsets.zero,
                onPressed: _canSend
                    ? () {
                        widget.onSend(_ctrl.text);
                        _ctrl.clear();
                        setState(() {});
                      }
                    : null,
                style: IconButton.styleFrom(
                  backgroundColor: _canSend
                      ? scheme.primary
                      : scheme.onSurface.withValues(alpha: 0.06),
                  foregroundColor:
                      _canSend ? scheme.onPrimary : scheme.onSurfaceVariant,
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12)),
                ),
                icon: const Icon(Icons.arrow_upward, size: 18),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}
