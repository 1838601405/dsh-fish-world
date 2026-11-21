import 'package:flutter_test/flutter_test.dart';
import 'package:whale_girl/desktop/protocol_endpoint.dart';

/// 真 DPAPI 往返：不注入假编解码，走 PowerShell + ProtectedData。
/// 这条慢（每次起两个 powershell），但**必须能真绿**——
/// 「加密能解回来」是凭据功能唯一的硬判据，用假实现验等于没验。
void main() {
  test('DPAPI 真往返：中文密码加密后能解回原文，密文不含明文', () async {
    final codec = PowershellDpapiCodec();
    const plain = '鱼的口令-abc123';
    final blob = await codec.protect(plain);
    expect(blob.isNotEmpty, isTrue);
    expect(blob.contains('鱼'), isFalse, reason: '密文里不该出现明文');
    expect(blob.contains('abc123'), isFalse, reason: '密文里不该出现明文');
    final back = await codec.unprotect(blob);
    expect(back, plain);
  }, timeout: const Timeout(Duration(minutes: 3)));
}
