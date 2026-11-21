import 'package:flutter/services.dart';

const MethodChannel _channel = MethodChannel('fish/window');

bool get supportsCustomChrome => true;

Future<void> windowMinimize() => _channel.invokeMethod<void>('minimize');
Future<void> windowToggleMaximize() => _channel.invokeMethod<void>('toggleMaximize');
Future<void> windowClose() => _channel.invokeMethod<void>('close');
Future<void> windowStartDrag() => _channel.invokeMethod<void>('startDrag');
Future<void> windowStartResize(String edge) => _channel.invokeMethod<void>('startResize', edge);
