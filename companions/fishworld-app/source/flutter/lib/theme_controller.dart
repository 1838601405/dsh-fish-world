import 'package:flutter/material.dart';

/// 主题模式控制器（system / light / dark）。
/// ★ 为什么单独一个类：设置页要改、MaterialApp 要读，隔着多层 Widget，
///   用 InheritedNotifier 传比一层层往下塞参数干净。
class ThemeController extends ChangeNotifier {
  ThemeMode _mode;
  ThemeController([this._mode = ThemeMode.dark]);

  ThemeMode get mode => _mode;

  void setMode(ThemeMode m) {
    if (m == _mode) return;
    _mode = m;
    notifyListeners();
  }
}

/// 把控制器放到组件树上，任何后代都能 ThemeScope.of(context) 拿到。
class ThemeScope extends InheritedNotifier<ThemeController> {
  const ThemeScope({
    super.key,
    required ThemeController controller,
    required super.child,
  }) : super(notifier: controller);

  static ThemeController of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<ThemeScope>();
    assert(scope != null, 'ThemeScope 不在上层 —— 检查 main.dart 有没有包');
    return scope!.notifier!;
  }
}
