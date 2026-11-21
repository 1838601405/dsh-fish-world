/// 运行时环境探针：桌面端会真连本机端口，widget 测试里不能那么干。
///
/// 拆成条件导入，是因为 `dart:io` 在 Web 构建里不可用。
library;

import 'desk_env_io.dart' if (dart.library.js) 'desk_env_stub.dart' as env;

/// 是否跑在 flutter test 里（fake_async + 不留未决 timer）。
bool get isUnderFlutterTest => env.isUnderFlutterTest;
