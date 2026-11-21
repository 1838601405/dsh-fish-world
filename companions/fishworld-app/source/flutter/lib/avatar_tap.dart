import 'package:flutter/material.dart';

import 'data/bridge.dart';
import 'fish_tooltip.dart';
import 'feedback.dart';
import 'chat_feed.dart';

/// 可戳的头像：点一下弹一下 + 让她按状态回一句。
class AvatarTap extends StatefulWidget {
  final double radius;
  final String who;
  final double padding;
  const AvatarTap(
      {super.key, this.radius = 13, this.who = '蓝鲸娘', this.padding = 6});

  @override
  State<AvatarTap> createState() => _AvatarTapState();
}

class _AvatarTapState extends State<AvatarTap> {
  double _scale = 1;

  Future<void> _tap() async {
    setState(() => _scale = 0.88);
    Future.delayed(const Duration(milliseconds: 90), () {
      if (mounted) setState(() => _scale = 1);
    });
    // 20s 缓存命中的重复戳只弹气泡，不重复记账。
    if (!feedbackCacheHit('戳了戳她的头像', detail: widget.who)) {
      bridgeActivityRecord(platform: 'app', kind: 'poke', text: '戳了戳她的头像', actor: 'owner');
    }
    final line = await sayFeedbackAsync('戳了戳她的头像', detail: widget.who, fallback: '别戳啦，呆毛要歪了~');
    addChatMessage(line == null || line.trim().isEmpty ? '别戳啦，呆毛要歪了~' : line.trim());
  }

  @override
  Widget build(BuildContext context) {
    return FishTooltip(
      message: '戳一下',
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: _tap,
          child: Padding(
            padding: EdgeInsets.all(widget.padding),
            child: AnimatedScale(
              scale: _scale,
              duration: const Duration(milliseconds: 90),
              child: CircleAvatar(
                radius: widget.radius,
                backgroundColor: Theme.of(context).colorScheme.primaryContainer,
                backgroundImage: const AssetImage('assets/avatar.png'),
                onBackgroundImageError: (_, __) {},
                child: const SizedBox.shrink(),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
