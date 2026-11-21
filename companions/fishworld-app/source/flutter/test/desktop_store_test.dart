import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/data/local_store_io.dart' as ls;
import 'package:whale_girl/data/model_store_io.dart' as ms;

void main() {
  test('local_store 桌面版写文件、重启后还在', () {
    final dir = Directory.systemTemp.createTempSync('wg-local-');
    addTearDown(() => dir.deleteSync(recursive: true));
    ls.useLocalStoreDirForTest(dir.path);
    ls.writeLocal('wg_notes_view', 'all');
    expect(
        File(dir.path + Platform.pathSeparator + 'local_store.json')
            .existsSync(),
        isTrue);
    expect(ls.readLocal('wg_notes_view'), 'all');
  });

  test('model.json 写盘、不回显 key、重启后可读', () async {
    final dir = Directory.systemTemp.createTempSync('wg-model-');
    addTearDown(() => dir.deleteSync(recursive: true));
    ms.useModelDirForTest(dir.path);
    await ms.saveModelConfig(
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        apiKey: 'sk-test');
    final f = File(dir.path + Platform.pathSeparator + 'model.json');
    expect(f.existsSync(), isTrue);
    final loaded = await ms.loadModelConfig();
    expect(loaded?['baseUrl'], 'https://api.deepseek.com');
    expect(loaded?['model'], 'deepseek-chat');
    expect(loaded?['hasKey'], isTrue);
    expect(loaded?.containsKey('apiKey'), isFalse);
  });
}
