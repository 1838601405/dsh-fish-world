import 'bridge_web.dart' as bridge;
import 'qq_gateway_base.dart';

QqGateway createQqGateway() => _BridgeQqGateway();

class _BridgeQqGateway implements QqGateway {
  @override
  bool get isDesktop => false;
  @override
  Future<Map<String, dynamic>?> loginState() async => await bridge.bridgeQqState() ?? await bridge.bridgeQqStatus();
  @override
  Future<Map<String, dynamic>?> probeLogin() => bridge.bridgeQqProbeLogin();
  @override
  Future<Map<String, dynamic>?> startProtocol() => bridge.bridgeProtocolStart();
  @override
  Future<Map<String, dynamic>?> stopProtocol() => bridge.bridgeProtocolStop();
  @override
  Future<Map<String, dynamic>?> setReceiving(bool running) => bridge.bridgeQqRecv(running ? 'start' : 'stop');
  @override
  Future<Map<String, dynamic>?> listTargets() => bridge.bridgeQqTargets();
  @override
  Future<Map<String, dynamic>?> send(String chatKey, String text) async => null;
  @override
  Future<Map<String, dynamic>?> loadConfig() => bridge.bridgeConfigGet();
  @override
  Future<Map<String, dynamic>?> saveConfig({String? baseUrl, String? token}) => bridge.bridgeQqConfig(baseUrl: baseUrl, token: token);
  @override
  Future<Map<String, dynamic>?> saveField(String key, Object? value) => bridge.bridgeQqField(key, value);
  @override
  Future<Map<String, dynamic>?> undelivered() => bridge.bridgeQqUndelivered();
  @override
  Future<Map<String, dynamic>?> redeliver({String? id, bool all = false}) =>
      bridge.bridgeQqRedeliver(id: id, all: all);
}
