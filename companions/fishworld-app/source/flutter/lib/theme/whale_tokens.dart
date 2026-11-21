import 'package:flutter/material.dart';

/// 蓝鲸娘配色 / 字号 / 圆角真源（全仓唯一允许写十六进制处）。
/// 值来自 docs/蓝鲸娘-UI-token-表.md + renderer/style.css 的 :root / dark 覆盖。
/// 组件层一律读 Theme.of(context)，禁止在 Widget 内写死颜色与字号。
class WhaleTokens {
  WhaleTokens._();

  // —— 颜色 · Dark（本体默认就是深色）——
  static const bgDark = Color(0xFF10131A); // --bg-2 侧栏 / 次级底
  static const canvasDark = Color(0xFF0B0D10); // --bg 画布
  static const glowDark = Color(0xFF12223A); // 画布顶部的藏青辉光
  static const surfaceDark = Color(0xFF14171D); // --surface 面板底

  /// 弹层遮罩：深色压暗 55%，浅色压暗 28%（不要用文字色当 barrier）。
  static Color scrimFor(Brightness b) => b == Brightness.light
      ? const Color.fromRGBO(0, 0, 0, 0.28)
      : const Color.fromRGBO(0, 0, 0, 0.55);
  static const surface2Dark = Color(0xFF232A36); // --surface-2 卡片/气泡次底
  static const textDark = Color(0xFFECEEF2); // --text
  static const dimDark = Color(0xFF9AA1AB); // --text-dim
  static const borderDark = Color(0xFF3A4356); // --border-strong
  static const borderSoftDark = Color(0xFF232833); // --border
  static const accentDark = Color(0xFF60A5FA); // 深态 --c-accent（浅蓝，深底上可读）
  static const accentSolidDark = Color(0xFF3B82F6); // 实心按钮/气泡用饱和蓝
  static const accentDeepDark = Color(0xFF1E3A8A); // 选中容器

  // —— 颜色 · Light ——
  static const bgLight = Color(0xFFE8EDF6);
  static const canvasLight = Color(0xFFFFFFFF);
  static const surfaceLight = Color(0xFFFFFFFF);
  static const surface2Light = Color(0xFFEEF2F8);
  static const textLight = Color(0xFF1F2328);
  static const dimLight = Color(0xFF57606A);
  static const borderLight = Color(0xFFB3BDCA);
  static const borderSoftLight = Color(0xFFD7DFEA);
  static const accentLight = Color(0xFF1D4ED8);
  static const accentSolidLight = Color(0xFF1D4ED8);
  static const accentDeepLight = Color(0xFF1E3A8A);
  static const primaryContainerLight = Color(0xFFDBEAFE);
  // —— 笔记无限画布（2026-11-08 用户指定的浅色白板）——
  static const notesCanvasLight = Color(0xFFF4F7FB);
  static const notesNodeLight = Color(0xFFFFFFFF);
  static const notesLineLight = Color(0xFFB9C5D6);
  static const notesToolbar = Color(0xE62A2A2A);
  // 2026-11-09 画布改「工具退居幕后」：工具栏走 notion-style 的浅底 + 1px 线，
  // 毛玻璃底用 70% 白（配 BackdropFilter），时间戳与锚点各降一档对比度。
  static const notesToolbarLight = Color(0xB3FFFFFF);
  static const notesToolbarBorderLight = Color(0x1F1F2328);
  static const notesCaptionLight = Color(0xFF8A94A6);
  static const notesAnchorLight = Color(0xFFA9B6C9);
  // 侧栏气泡：浅色 surface + 实描边，深色保持原深灰；箭头与气泡同源。
  static Color tooltipBgFor(Brightness b) => b == Brightness.light ? surfaceLight : const Color(0xF02A2A2A);
  static Color tooltipFgFor(Brightness b) => b == Brightness.light ? textLight : const Color(0xFFF7F8FA);
  static Color tooltipBorderFor(Brightness b) => b == Brightness.light ? borderLight : const Color(0x33FFFFFF);
  static List<BoxShadow> tooltipShadowFor(Brightness b) => b == Brightness.light
      ? const [BoxShadow(color: Color(0x14000000), blurRadius: 10, offset: Offset(0, 2))]
      : const [BoxShadow(color: Color(0x2E000000), blurRadius: 14, offset: Offset(0, 3))];

  // —— 鱼的状态页（2026-11-10 新 spec；页面只读 token，不写 hex）——
  static const fishCanvasDark = Color(0xFF0D111A);
  static const fishCanvasLight = Color(0xFFF4F7FB);
  static const fishCardDark = Color(0xFF151B27);
  static const fishCardLight = Color(0xFFFFFFFF);
  static const fishTextDark = Color(0xDBFFFFFF); // 86% white
  static const fishTextLight = Color(0xDB1F2328);
  static const fishMutedDark = Color(0x8CFFFFFF); // 55% white
  static const fishMutedLight = Color(0x8C57606A);
  static const fishBorderDark = Color(0x0DFFFFFF); // 5% white
  static const fishBorderLight = Color(0x14000000); // 8% black
  static const fishAccent = Color(0xFF4F8CFF);

  // —— 外发/危险开关（2026-11-12 主人："红色太突兀"）：低饱和赭红，不是报错红 ——
  static const dangerDark = Color(0xFFB4715F);
  static const dangerLight = Color(0xFFA85C4E);
  static Color dangerFor(Brightness b) => b == Brightness.light ? dangerLight : dangerDark;

  // —— 语义状态色（2026-11-12 规则：只用于状态反馈：点/图标/文字/1px 描边，禁整块填充）——
  static const successDark = Color(0xFF4ADE80);
  static const successLight = Color(0xFF1A7F37);
  static Color successFor(Brightness b) => b == Brightness.light ? successLight : successDark;

  // —— 提醒色（2026-11-17）：没绑上、配置缺失这类“还没好”的状态 ——
  // 和 error 分工：warning = 需要你动手，但没出错；error 只给“动作失败”。
  static const warningDark = Color(0xFFE0B341);
  static const warningLight = Color(0xFF8A6A00);
  static Color warningFor(Brightness b) => b == Brightness.light ? warningLight : warningDark;

  // —— 字号（本体只有这 7 档）——
  static const fsCaption = 10.0;
  static const fsSmall = 11.0;
  static const fsBody = 12.0; // 主力正文
  static const fsLabel = 13.0;
  static const fsSub = 14.0;
  static const fsTitle = 16.0;
  static const fsPage = 20.0;
  static const fsHero = 32.0;

  // —— 通用语义色（P6：页面不许再写十六进制）——
  static const onlineGreen = Color(0xFF46D18A);
  static const canvasGlowLight = Color(0xFFF2F6FF);
  static const statBlue = Color(0xFF6B8EFF);
  static const statPink = Color(0xFFE38DBA);
  static const statAmber = Color(0xFFE3B23C);
  static const trackDark = Color(0x0DFFFFFF);

  // —— 沉浸式对话（2026-11-15）——
  static const chatBgStart = Color(0xFF18181B);
  static const chatBgEnd = Color(0xFF1C1C20);
  /// 用户气泡：由 primary 派生，深浅主题自动算；不再写死色值。
  static Color bubbleUserFor(ColorScheme s) =>
      Color.alphaBlend(s.primary.withValues(alpha: s.brightness == Brightness.light ? 0.16 : 0.55), s.surface);

  static Color bubbleUserFgFor(ColorScheme s) => s.onSurface;

  // —— 栅格（P3：桌面 12 / 手机 8）——
  static const gap = 12.0;
  static const pageGutter = 16.0;
  static const gapNarrow = 8.0;

  // —— 圆角（P3：只留两级 8 / 12；大卡/胶囊另算）——
  static const rSm = 8.0;
  static const rMd = 8.0;
  static const rLg = 12.0;
  static const rXl = 12.0;
  static const r2xl = 12.0;
  static const rHero = 20.0;

  static TextTheme _text(Color fg, Color dim) => TextTheme(
        bodyLarge: TextStyle(fontSize: fsBody, color: fg, height: 1.5),
        bodyMedium: TextStyle(fontSize: fsBody, color: fg, height: 1.5),
        bodySmall: TextStyle(fontSize: fsSmall, color: dim, height: 1.4),
        labelLarge: TextStyle(
            fontSize: fsLabel, color: fg, fontWeight: FontWeight.w500),
        labelMedium: TextStyle(fontSize: fsSmall, color: dim),
        labelSmall: TextStyle(fontSize: fsCaption, color: dim),
        titleMedium:
            TextStyle(fontSize: fsSub, color: fg, fontWeight: FontWeight.w600),
        titleLarge: TextStyle(
            fontSize: fsTitle, color: fg, fontWeight: FontWeight.w600),
        headlineSmall:
            TextStyle(fontSize: fsPage, color: fg, fontWeight: FontWeight.w700),
      ).apply(fontFamilyFallback: const [
        'Microsoft YaHei',
        'PingFang SC',
        'Noto Sans SC',
        'Segoe UI',
      ]);

  static ThemeData _build({
    required Brightness brightness,
    required ColorScheme scheme,
    required Color fgDim,
    required Color surface2,
  }) {
    final base = ThemeData(
        useMaterial3: true, brightness: brightness, colorScheme: scheme);
    return base.copyWith(
      textTheme: _text(scheme.onSurface, fgDim),
      primaryTextTheme: _text(scheme.onSurface, fgDim),
      scaffoldBackgroundColor: Colors.transparent, // 画布渐变由 AppShell 铺
      canvasColor: Colors.transparent,
      dividerTheme: DividerThemeData(
          color: scheme.outlineVariant, thickness: 1, space: 1),
      cardTheme: CardThemeData(
        color: surface2,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(rLg),
          side: BorderSide(
            color: scheme.outlineVariant,
            width: 1,
            strokeAlign: BorderSide.strokeAlignInside,
          ),
        ),
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: TextStyle(
            fontSize: fsTitle,
            fontWeight: FontWeight.w600,
            color: scheme.onSurface),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: surface2,
        isDense: true,
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        hintStyle: TextStyle(fontSize: fsBody, color: fgDim),
        border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(rMd),
            borderSide: BorderSide.none),
        enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(rMd),
            borderSide: BorderSide.none),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(rMd),
          borderSide: BorderSide(color: scheme.primary, width: 1),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(0, 32),
          padding: const EdgeInsets.symmetric(horizontal: 12),
          textStyle:
              const TextStyle(fontSize: fsLabel, fontWeight: FontWeight.w500),
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(rSm)),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          minimumSize: const Size(0, 32),
          padding: const EdgeInsets.symmetric(horizontal: 12),
          textStyle: const TextStyle(fontSize: fsLabel),
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(rSm)),
        ),
      ),
      iconTheme: IconThemeData(size: 18, color: scheme.onSurfaceVariant),
      listTileTheme: ListTileThemeData(
        dense: true,
        visualDensity: VisualDensity.compact,
        iconColor: scheme.onSurfaceVariant,
        textColor: scheme.onSurface,
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: surface2,
        contentTextStyle: TextStyle(fontSize: fsBody, color: scheme.onSurface),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(rMd)),
        behavior: SnackBarBehavior.floating,
      ),
      visualDensity: VisualDensity.compact,
    );
  }

  static ThemeData buildDark() => _build(
        brightness: Brightness.dark,
        fgDim: dimDark,
        surface2: surface2Dark,
        scheme: const ColorScheme.dark(
          primary: accentDark,
          onPrimary: Color(0xFF0B0D10),
          surface: surfaceDark,
          onSurface: textDark,
          surfaceContainerHighest: surface2Dark,
          onSurfaceVariant: dimDark,
          outline: borderDark,
          outlineVariant: borderSoftDark,
          primaryContainer: accentDeepDark,
          onPrimaryContainer: textDark,
          // 2026-11-15：补 secondary 一组。原本没定义，SegmentedButton 的选中段
          // 会退到 ColorScheme.dark() 的 legacy 默认值 Color(0xFF03DAC6)（青），
          // 在蓝灰里非常跳。这里明确映射到本主题的深蓝容器 + 浅蓝字。
          secondary: accentDark,
          onSecondary: Color(0xFF0B0D10),
          secondaryContainer: accentDeepDark,
          onSecondaryContainer: Color(0xFFDBEAFE),
        ),
      );

  static ThemeData buildLight() => _build(
        brightness: Brightness.light,
        fgDim: dimLight,
        surface2: surface2Light,
        scheme: const ColorScheme.light(
          primary: accentLight,
          onPrimary: Color(0xFFFFFFFF),
          surface: surfaceLight,
          onSurface: textLight,
          surfaceContainerHighest: surface2Light,
          onSurfaceVariant: dimLight,
          outline: borderLight,
          outlineVariant: borderSoftLight,
          primaryContainer: primaryContainerLight,
          onPrimaryContainer: accentLight,
          // 同 buildDark：补齐 secondary 一组，避免落到框架默认青色。
          secondary: accentLight,
          onSecondary: Color(0xFFFFFFFF),
          secondaryContainer: primaryContainerLight,
          onSecondaryContainer: accentLight,
        ),
      );
}

ThemeData buildWhaleLightTheme() => WhaleTokens.buildLight();
ThemeData buildWhaleDarkTheme() => WhaleTokens.buildDark();

/// 侧边栏固定深色（浅色主题下也是深栏），对应本体的深色导航条。

/// 侧栏跟主题走：深色用深栏，浅色用浅栏（2026-11-07 用户要求）
ColorScheme whaleSidebarSchemeFor(Brightness b) {
  if (b == Brightness.dark) return whaleSidebarScheme();
  return const ColorScheme.light(
    primary: WhaleTokens.accentLight,
    onPrimary: Color(0xFFFFFFFF),
    surface: WhaleTokens.surfaceLight,
    onSurface: WhaleTokens.textLight,
    surfaceContainerHighest: WhaleTokens.surface2Light,
    onSurfaceVariant: WhaleTokens.dimLight,
    outline: WhaleTokens.borderLight,
    outlineVariant: WhaleTokens.borderSoftLight,
    primaryContainer: WhaleTokens.primaryContainerLight,
    onPrimaryContainer: WhaleTokens.accentLight,
  );
}

ColorScheme whaleSidebarScheme() => const ColorScheme.dark(
      primary: WhaleTokens.accentDark,
      onPrimary: Color(0xFF0B0D10),
      surface: WhaleTokens.bgDark,
      onSurface: WhaleTokens.textDark,
      surfaceContainerHighest: WhaleTokens.surface2Dark,
      onSurfaceVariant: WhaleTokens.dimDark,
      outline: WhaleTokens.borderDark,
      outlineVariant: WhaleTokens.borderSoftDark,
      primaryContainer: WhaleTokens.accentDeepDark,
      onPrimaryContainer: WhaleTokens.textDark,
    );
