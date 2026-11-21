import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/semantics.dart';
import 'theme/whale_tokens.dart';
import 'theme_controller.dart';
import 'app_shell.dart';
import 'theme_boot_stub.dart' if (dart.library.io) 'theme_boot_io.dart' as boot;
import 'desktop/qq_service_stub.dart'
    if (dart.library.io) 'desktop/qq_service_io.dart' as desk;

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const WhaleGirlApp());
}

/// 入口：深/浅双态主题，配色全部来自 WhaleTokens（仅此文件引用 hex）。
class WhaleGirlApp extends StatefulWidget {
  const WhaleGirlApp({super.key});

  @override
  State<WhaleGirlApp> createState() => _WhaleGirlAppState();
}

class _WhaleGirlAppState extends State<WhaleGirlApp> {
  late final ThemeController _theme;

  @override
  void initState() {
    super.initState();
    if (!kIsWeb) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        desk.startDesktopQqService();
      });
    }
    // 深链：?theme=light|dark|system（便于分享/截图/测试；默认深色）
    ThemeMode mode = ThemeMode.dark;
    try {
      final t = Uri.base.queryParameters['theme'];
      if (t == 'light') {
        mode = ThemeMode.light;
      } else if (t == 'system') {
        mode = ThemeMode.system;
      }
    } catch (_) {}
    if (mode == ThemeMode.dark) {
      final t = boot.bootTheme();
      if (t == 'light') mode = ThemeMode.light;
    }
    _theme = ThemeController(mode);
    if (kIsWeb) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        SemanticsBinding.instance.ensureSemantics();
      });
    }
  }

  @override
  void dispose() {
    _theme.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ThemeScope(
        controller: _theme,
        child: ListenableBuilder(
          listenable: _theme,
          builder: (_, __) => MaterialApp(
            title: '鱼的世界',
            theme: buildWhaleLightTheme(),
            darkTheme: buildWhaleDarkTheme(),
            themeMode: _theme.mode,
            home: const AppShell(),
            debugShowCheckedModeBanner: false,
          ),
        ),
      );
}
