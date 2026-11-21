import 'bridge.dart';

Future<Map<String, dynamic>?> loadModelConfig() => bridgeModelConfig();

Future<Map<String, dynamic>?> saveModelConfig(
        {String? baseUrl, String? model, String? apiKey}) =>
    bridgeModelConfigSave(baseUrl: baseUrl, model: model, apiKey: apiKey);

Future<Map<String, dynamic>?> readModelRaw() => bridgeModelConfig();
