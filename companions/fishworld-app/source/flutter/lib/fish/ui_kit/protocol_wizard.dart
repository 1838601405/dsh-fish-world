import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show kIsWeb;

// ignore_for_file: prefer_interpolation_to_compose_strings

import '../../data/desk_env.dart';
import '../../desktop/protocol_endpoint.dart';
import '../../data/open_url_web.dart'
    if (dart.library.io) '../../data/open_url_stub.dart' as opener;
import '../../theme/whale_tokens.dart';

/// 协议端三步向导：**检测 → 一键 → 登录**。
///
/// 只做桌面；Web 端不渲染（没有本机进程可管）。
/// 每一步都摆「现在什么状态 + 下一步该点哪个按钮」，不做假成功：
/// 一键失败按退出码给话，登录步只说事实，不代输密码。
class ProtocolWizard extends StatefulWidget {
  /// 测试注入：不传就自己建一个真实现。
  final ProtocolEndpoint? endpoint;
  const ProtocolWizard({super.key, this.endpoint});

  @override
  State<ProtocolWizard> createState() => _ProtocolWizardState();
}

class _ProtocolWizardState extends State<ProtocolWizard> {
  late final ProtocolEndpoint _ep = widget.endpoint ?? createProtocolEndpoint();

  bool _loading = true;
  bool _busy = false;
  String _busyWhat = '';
  Map<String, dynamic> _detect = const {};
  String _msg = '';
  bool _msgErr = false;
  String _oneClickMsg = '';
  bool _oneClickErr = false;
  Map<String, dynamic> _oneResult = const {};
  final _token = TextEditingController();
  final _uin = TextEditingController();
  final _qqPwd = TextEditingController();
  bool _showPwd = false;
  Map<String, dynamic> _cred = const {'hasCredential': false};

  @override
  void initState() {
    super.initState();
    // 自动探测一次，但 flutter test 里不探：widget 测试跑在 fake_async 里，
    // 真去连 127.0.0.1 会留下未决 timer（实测把「设置页有外观切换」打成红）。
    // 探测逻辑由 protocol_endpoint_test 用假传输层验，不靠这里。
    if (widget.endpoint != null || !isUnderFlutterTest) {
      _refresh();
    } else {
      _loading = false;
    }
  }

  @override
  void dispose() {
    _token.dispose();
    _uin.dispose();
    _qqPwd.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    setState(() => _loading = true);
    final d = await _ep.detect();
    if (!mounted) return;
    setState(() {
      _detect = d;
      _cred = _ep.credentialStatus();
      _loading = false;
    });
  }

  Future<void> _runOneClick() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _busyWhat = '一键就绪';
      _oneClickMsg = '正在找协议端、拉起、注入并等上线…（最多 2 分钟）';
      _oneClickErr = false;
    });
    Map<String, dynamic> r;
    try {
      r = await _ep.oneClick(
        uin: _uin.text.trim().isEmpty ? null : _uin.text.trim(),
        webuiToken: _token.text.trim().isEmpty ? null : _token.text.trim(),
      );
    } catch (e) {
      r = {'ok': false, 'code': -1, 'message': e.toString(), 'stage': 'exception'};
    }
    if (!mounted) return;
    setState(() {
      _busy = false;
      _oneResult = r;
      final ok = r['ok'] == true;
      _oneClickErr = !ok;
      _oneClickMsg = ok
          ? (r['message'] ?? '就绪').toString()
          : codeName((r['code'] as num?)?.toInt() ?? -1) +
              '：' +
              (r['message'] ?? '').toString();
    });
    await _refresh();
  }

  Future<void> _savePwd() async {
    final pwd = _qqPwd.text;
    if (pwd.trim().isEmpty) {
      setState(() {
        _msg = '密码是空的，没存';
        _msgErr = true;
      });
      return;
    }
    setState(() => _busy = true);
    try {
      final r = await _ep.saveCredential(pwd);
      if (!mounted) return;
      setState(() {
        _busy = false;
        _cred = _ep.credentialStatus();
        if (r['ok'] == true) {
          _qqPwd.clear();
          _msg = '已加密保存（DPAPI）。登录时仍由你在 QQ 里完成，App 不代输密码。';
          _msgErr = false;
        } else {
          _msg = '没存成：' + (r['error'] ?? '未知错误').toString();
          _msgErr = true;
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _msg = '没存成：' + e.toString();
        _msgErr = true;
      });
    }
  }

  void _clearPwd() {
    _ep.clearCredential();
    setState(() {
      _cred = _ep.credentialStatus();
      _msg = '已清掉保存的凭据引用';
      _msgErr = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (kIsWeb) return const SizedBox.shrink();
    final scheme = Theme.of(context).colorScheme;
    final steps = (_detect['steps'] as List?) ?? const [];
    final dirOk = _detect['usable'] == true;
    final running = _detect['protocolRunning'] == true;
    final logged = _detect['logged'] == true;
    final webui = (_detect['webuiUrl'] ?? 'http://127.0.0.1:5099').toString();

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            Icon(Icons.cable_outlined, size: 16, color: scheme.primary),
            const SizedBox(width: 8),
            Text('协议端',
                style: TextStyle(
                    fontSize: WhaleTokens.fsSub,
                    fontWeight: FontWeight.w600,
                    color: scheme.onSurface)),
            const SizedBox(width: 8),
            Text('检测 · 一键 · 登录',
                style: TextStyle(
                    fontSize: WhaleTokens.fsSmall, color: scheme.onSurfaceVariant)),
            const Spacer(),
            if (_busy)
              Text(_busyWhat + '…',
                  style: TextStyle(fontSize: WhaleTokens.fsCaption, color: scheme.primary)),
            IconButton(
              visualDensity: VisualDensity.compact,
              tooltip: '重新检测',
              onPressed: _busy || _loading ? null : _refresh,
              icon: Icon(Icons.refresh, size: 18, color: scheme.onSurfaceVariant),
            ),
          ]),
          const SizedBox(height: 4),
          if (_loading)
            LinearProgressIndicator(
                minHeight: 3, color: scheme.primary)
          else
            for (var i = 0; i < steps.length; i++) _stepRow(context, i + 1, steps[i] as Map),
          const SizedBox(height: 8),
          const Divider(height: 1),
          const SizedBox(height: 10),

          // ---- 第 2 步：一键 ----
          _title(context, '② 一键就绪',
              dirOk ? '会做什么：找目录 → 起协议端 → 拿 WebUI 令牌 → 注入已开着的 QQ → 等上线 → 核对账号' : '先解决上面的目录问题'),
          const SizedBox(height: 6),
          Row(children: [
            Expanded(
              child: _field(
                context,
                controller: _uin,
                hint: '指定鱼的 QQ 号（可留空，自动挑已登录的那个）',
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _field(
                context,
                controller: _token,
                hint: 'WebUI 访问令牌（非首次运行才需要）',
                obscure: true,
              ),
            ),
          ]),
          const SizedBox(height: 8),
          Row(children: [
            FilledButton(
              onPressed: _busy || !dirOk ? null : _runOneClick,
              child: Text(_busy && _busyWhat == '一键就绪' ? '进行中…' : '一键就绪'),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                _oneClickMsg,
                style: TextStyle(
                    fontSize: WhaleTokens.fsSmall,
                    color: _oneClickErr ? scheme.error : scheme.onSurfaceVariant),
              ),
            ),
            if (_oneClickErr)
              TextButton(
                onPressed: _busy ? null : _runOneClick,
                child: const Text('重试', style: TextStyle(fontSize: 12)),
              ),
          ]),
          if ((_oneResult['uin'] ?? '').toString().isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              '就绪账号：' +
                  (_oneResult['nickname'] ?? '').toString() +
                  ' (' +
                  _oneResult['uin'].toString() +
                  ')',
              style: TextStyle(
                  fontSize: WhaleTokens.fsCaption,
                  color: WhaleTokens.successFor(scheme.brightness)),
            ),
          ],
          const SizedBox(height: 12),

          // ---- 第 3 步：登录 ----
          _title(context, '③ 登录 QQ', logged ? '已登录' : '两步：先拧开 QQ，再用它扫码'),
          const SizedBox(height: 6),
          Text(
            '扫码（默认）：下面两个按钮分别打开协议端登录页和 QQ 本体，你在 QQ 里扫码登录；'
            '登录完回来点「重新检测」。',
            style: TextStyle(
                fontSize: WhaleTokens.fsSmall,
                height: 1.5,
                color: scheme.onSurfaceVariant),
          ),
          const SizedBox(height: 8),
          Wrap(spacing: 8, runSpacing: 8, children: [
            OutlinedButton.icon(
              onPressed: () => opener.openUrl(webui),
              icon: const Icon(Icons.open_in_new, size: 15),
              label: const Text('打开协议端登录页（5099）', style: TextStyle(fontSize: 12)),
            ),
            OutlinedButton.icon(
              onPressed: () async {
                final r = await _ep.launchQq();
                if (!mounted) return;
                if (r['ok'] == true) {
                  setState(() {
                    _msg = r['launched'] == true ? 'QQ 已打开，扫码登录后回来点「重新检测」' : '测试里没真启动 QQ';
                    _msgErr = false;
                  });
                } else {
                  setState(() {
                    _msg = (r['error'] ?? 'QQ 打不开').toString();
                    _msgErr = true;
                  });
                }
              },
              icon: const Icon(Icons.login, size: 15),
              label: const Text('打开 QQ', style: TextStyle(fontSize: 12)),
            ),
            TextButton.icon(
              onPressed: _busy || _loading ? null : _refresh,
              icon: const Icon(Icons.refresh, size: 15),
              label: const Text('重新检测', style: TextStyle(fontSize: 12)),
            ),
          ]),
          const SizedBox(height: 10),

          // ---- 高级：密码凭据 ----
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            childrenPadding: const EdgeInsets.only(bottom: 4),
            visualDensity: VisualDensity.compact,
            title: Text('高级：保存 QQ 密码凭据',
                style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurface)),
            subtitle: Text(
              _cred['hasCredential'] == true
                  ? '已保存（' +
                      (_cred['algorithm'] ?? 'DPAPI').toString() +
                      ' 加密，仅存引用）'
                  : '未保存',
              style: TextStyle(fontSize: WhaleTokens.fsCaption, color: scheme.onSurfaceVariant),
            ),
            children: [
              Text(
                '密码用 Windows DPAPI 加密后只存密文引用，界面 / 日志 / 配置都不出现明文；'
                '登录仍然由你在 QQ 里完成，App 不代输密码，所以这条不会替你把 QQ 登上——'
                '它只是留一个加密凭据引用，避免你每次都要翻密码本。',
                style: TextStyle(
                    fontSize: WhaleTokens.fsCaption, height: 1.5, color: scheme.onSurfaceVariant),
              ),
              const SizedBox(height: 8),
              Row(children: [
                Expanded(
                  child: _field(
                    context,
                    controller: _qqPwd,
                    hint: 'QQ 密码（只在内存里过一遍，落盘即密文）',
                    obscure: !_showPwd,
                    trailing: IconButton(
                      visualDensity: VisualDensity.compact,
                      tooltip: _showPwd ? '隐藏' : '显示',
                      onPressed: () => setState(() => _showPwd = !_showPwd),
                      icon: Icon(_showPwd ? Icons.visibility_off : Icons.visibility,
                          size: 16, color: scheme.onSurfaceVariant),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton.tonal(
                  onPressed: _busy ? null : _savePwd,
                  child: const Text('加密保存'),
                ),
                if (_cred['hasCredential'] == true) ...[
                  const SizedBox(width: 6),
                  TextButton(
                    onPressed: _busy ? null : _clearPwd,
                    child: const Text('清掉', style: TextStyle(fontSize: 12)),
                  ),
                ],
              ]),
              if (_msg.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(_msg,
                      style: TextStyle(
                          fontSize: WhaleTokens.fsCaption,
                          color: _msgErr ? scheme.error : scheme.onSurfaceVariant)),
                ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            '口令与账号只在本机：令牌存 ' +
                (running ? '内存/本机配置' : '本机配置') +
                '，不写日志。',
            style: TextStyle(fontSize: WhaleTokens.fsCaption, color: scheme.onSurfaceVariant),
          ),
        ]),
      ),
    );
  }

  Widget _title(BuildContext context, String text, String hint) {
    final scheme = Theme.of(context).colorScheme;
    return Row(children: [
      Text(text,
          style: TextStyle(
              fontSize: WhaleTokens.fsSmall,
              fontWeight: FontWeight.w600,
              color: scheme.onSurface)),
      const SizedBox(width: 8),
      Expanded(
        child: Text(hint,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: WhaleTokens.fsCaption, color: scheme.onSurfaceVariant)),
      ),
    ]);
  }

  Widget _stepRow(BuildContext context, int idx, Map step) {
    final scheme = Theme.of(context).colorScheme;
    final ok = step['ok'] == true;
    final color = ok ? WhaleTokens.successFor(scheme.brightness) : scheme.error;
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SizedBox(
            width: 18,
            child: Text(idx.toString(),
                style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: color))),
        Padding(
          padding: const EdgeInsets.only(top: 1),
          child: Icon(ok ? Icons.check_circle : Icons.error_outline, size: 14, color: color),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text.rich(TextSpan(children: [
            TextSpan(
                text: (step['title'] ?? '').toString() + '：',
                style: TextStyle(
                    fontSize: WhaleTokens.fsSmall,
                    fontWeight: FontWeight.w600,
                    color: scheme.onSurface)),
            TextSpan(
                text: (step['detail'] ?? '').toString(),
                style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurfaceVariant)),
          ])),
        ),
      ]),
    );
  }

  Widget _field(
    BuildContext context, {
    required TextEditingController controller,
    required String hint,
    bool obscure = false,
    Widget? trailing,
  }) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      height: 40,
      padding: const EdgeInsets.only(left: 10, right: 2),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.45),
        border: Border.all(color: scheme.outlineVariant),
        borderRadius: BorderRadius.circular(WhaleTokens.rSm),
      ),
      child: Row(children: [
        Expanded(
          child: TextField(
            controller: controller,
            obscureText: obscure,
            style: TextStyle(fontSize: WhaleTokens.fsSmall, color: scheme.onSurface),
            decoration: InputDecoration.collapsed(
              hintText: hint,
              hintStyle: TextStyle(
                  fontSize: WhaleTokens.fsCaption,
                  color: scheme.onSurfaceVariant.withValues(alpha: 0.7)),
            ),
          ),
        ),
        if (trailing != null) trailing,
      ]),
    );
  }
}
