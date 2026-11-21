# 源码快照

这里放的是「鱼的世界新版」的 **Flutter 源码**（`flutter/` 下 git 跟踪的部分），
随插件仓一起发布，方便一处拿到东西就能两边都重建。

## 它是什么

- **来源**：app 仓 `E:\WhaleGirl` 的 `flutter/` 目录
- **内容**：`lib/`（126 个 .dart）· `assets/`（1.4MB）· `web/` · `test/` · `windows/runner` · `pubspec.*`
- **不含**：`build/`、`.dart_tool/`（那是构建产物，由 `flutter build` 生成）
- **体积**：约 2.2 MB

## 怎么用

```bash
cd companions/fishworld-app/source
flutter pub get
flutter build web --base-href=/dsh-fish-world/fishworld/     # 插件版
flutter build windows                                         # 桌面版
```

产物分别拷到：
- 插件版 → `E:\dsh_fish_world\ui\fishworld\`
- 桌面版 → `D:\大肥鱼\鱼的世界-应用\`

## ⚠️ 这是快照，不是主力开发位

改代码请在 app 仓改，然后把改动同步过来。**不要在这里直接改并指望它回流** ——
两边同时改会让 diff 失去意义。

每次同步时用这个命令核对「源码快照 vs app 仓」是否一致：

```bash
# 在 app 仓里算 flutter 源码的指纹
cd E:/WhaleGirl
git ls-files flutter | where-object { $_ -notmatch '^flutter/(build|\.dart_tool)' } | ForEach-Object { (Get-Item $_).Length } | Measure-Object -Sum | Select-Object Sum
```

## 为什么产物不进 git

两边产物各约 29MB（web 57 文件 / Windows 24 文件），是可再生的构建产物。
进仓库会让每次小改动都塞一个几十 MB 的 blob。产物走 GitHub Releases。

## 未验证

- 用这份快照单独构建是否成功（没有在干净环境里跑过 `flutter pub get` +
  `flutter build`；依赖 `pubspec.lock` 里的版本可能和当前 Flutter SDK 不兼容）
