import 'package:flutter/material.dart';

import 'ui_kit.dart';

/// P2 示例：7 件组件的唯一用法演示。不参与路由，仅保证可编译、可参照。
class FishUiKitGallery extends StatelessWidget {
  const FishUiKitGallery({super.key});

  @override
  Widget build(BuildContext context) {
    return ListView(padding: const EdgeInsets.all(12), children: [
      FishUiCard(
        level: FishCardLevel.outer,
        title: 'FishUiCard · outer',
        note: 'surface + 1px 边框 + r8',
        child: Text('外层卡', style: TextStyle(color: Theme.of(context).colorScheme.onSurface)),
      ),
      const SizedBox(height: 12),
      FishUiCard(
        level: FishCardLevel.inset,
        title: 'FishUiCard · inset',
        child: FishSwitch(value: true, onChanged: (_) {}),
      ),
      const SizedBox(height: 12),
      FishStatusAction(
        status: FishStatusKind.ok,
        message: 'FishStatusAction：状态必须带下一步',
        action: FishAction(label: '重试', kind: FishActionKind.retry, handler: () {}),
      ),
      const FishEmpty(text: 'FishEmpty：空态一句话 + 可选动作', action: null),
      FishTooltip(message: 'FishTooltip：全站唯一 tooltip', child: const Text('悬停我')),
      FishKeys.onActivate(onActivate: () {}, child: const Text('FishKeys：Enter/Space')),
      FishActionButton(action: FishAction(label: 'FishActionButton', kind: FishActionKind.gotoPage, handler: () {})),
    ]);
  }
}
