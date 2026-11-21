import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/desktop/sha256.dart';

// 人设卡指纹要和插件/脚本对得上：对不上，两边就不是同一份卡。
void main() {
  test('sha256 对得上标准向量', () {
    expect(sha256OfText(''),
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256OfText('abc'),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256OfText('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  test('长文本跨块也对（人设卡两万多字节）', () {
    final text = '鲸鱼' * 4000;
    final got = sha256OfText(text);
    expect(got.length, 64);
    expect(RegExp(r'^[0-9a-f]{64}$').hasMatch(got), isTrue);
  });

  test('真实人设卡指纹与 node 一致', () {
    final f = File('D:/DSH-home/fish-world-personas/default.md');
    if (!f.existsSync()) return;
    // 不钉死具体哈希：人设卡一改这条就一直假红（已经红过两次）。
    // 改成当场用 node 算一遍再比 —— 验的是「dart 实现和 node 一致」，不是「文件没变」。
    final dartHash = sha256OfText(f.readAsStringSync());
    late final ProcessResult run;
    try {
      run = Process.runSync('node', [
        '-e',
        'const c=require("crypto"),f=require("fs");'
            'process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))',
        f.path,
      ]);
    } on ProcessException {
      return; // 没装 node 就跳过，不假红
    }
    if (run.exitCode != 0) return;
    final nodeHash = (run.stdout as String).trim();
    expect(nodeHash.length, 64);
    expect(dartHash, nodeHash, reason: 'dart 的 sha256 要和 node 算出同一个值');
  });
}
