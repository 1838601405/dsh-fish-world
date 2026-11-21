import 'ui_store_stub.dart' if (dart.library.html) 'ui_store_web.dart' as impl;

/// 面板本地状态：网页端写 localStorage，非网页端退回内存。
class UiStore {
  static String? get(String key) => impl.get(key);
  static void set(String key, String value) => impl.set(key, value);
}
