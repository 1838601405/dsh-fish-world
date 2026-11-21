import 'dart:async';

/// QQ 平台能力：桌面直连 OneBot，插件走桥。UI 只认这一层。
abstract class QqGateway {
  bool get isDesktop;
  Future<Map<String, dynamic>?> loginState();
  Future<Map<String, dynamic>?> probeLogin();
  Future<Map<String, dynamic>?> startProtocol();
  Future<Map<String, dynamic>?> stopProtocol();
  Future<Map<String, dynamic>?> setReceiving(bool running);
  Future<Map<String, dynamic>?> listTargets();
  Future<Map<String, dynamic>?> send(String chatKey, String text);
  Future<Map<String, dynamic>?> loadConfig();
  Future<Map<String, dynamic>?> saveConfig({String? baseUrl, String? token});
  Future<Map<String, dynamic>?> saveField(String key, Object? value);
  // ⭐ 2026-11-20：桥超窗未投的消息（主人要求 A）。
  //   「投不进去就丢掉」以前只写桥自己的日志，主人看不到 —— 这里给面板一条读的路。
  Future<Map<String, dynamic>?> undelivered();
  /// 手动补投：给 id 补一条，给 all=true 补全部。
  Future<Map<String, dynamic>?> redeliver({String? id, bool all = false});
}
