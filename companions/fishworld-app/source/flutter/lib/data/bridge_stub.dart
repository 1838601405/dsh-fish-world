/// 非 Web（测试 / 桌面 VM）：没有桥，返回 null（调用方自己降级）。
Future<Map<String, dynamic>?> bridgeChat(
        List<Map<String, String>> messages) async =>
    null;

Future<Map<String, dynamic>?> bridgeFeedback(
        String action, String detail) async =>
    null;

Future<Map<String, dynamic>?> bridgeModelConfig() async => null;

Future<Map<String, dynamic>?> bridgeModelConfigSave(
        {String? baseUrl, String? model, String? apiKey}) async =>
    null;

/// 鱼的世界只读快照（GET /api/fish/snapshot）；非 Web 没有桥，交给打包快照回落。
Future<Map<String, dynamic>?> bridgeFishSnapshot() async => null;

//// QQ 单一状态机（GET /api/qq/state）；非 Web 没有桥。
Future<Map<String, dynamic>?> bridgeQqState() async => null;

// QQ 接收状态（GET /api/qq/status）；非 Web 没有桥。
Future<Map<String, dynamic>?> bridgeQqStatus() async => null;

/// QQ 接收开关（POST /api/qq/recv，action = start / stop）；非 Web 没有桥。
Future<Map<String, dynamic>?> bridgeQqRecv(String action) async => null;

Future<Map<String, dynamic>?> bridgeFishDiaryComment(
        String id, String text, {String quote = ''}) async =>
    null;
Future<Map<String, dynamic>?> bridgeFishMemoryAction(
        String id, String action) async =>
    null;
Future<Map<String, dynamic>?> bridgeFishWishDecision(
        String id, String decision) async =>
    null;

Future<Map<String, dynamic>?> bridgeDiaryDates(String month) async => null;
Future<Map<String, dynamic>?> bridgeDiaryDay(String date) async => null;

Future<Map<String, dynamic>?> bridgeFishDiaryDecision(
        String id, String decision) async =>
    null;
Future<Map<String, dynamic>?> bridgeFishGrowthRevise(
        String id, String text) async =>
    null;
Future<Map<String, dynamic>?> bridgeFishGrowthRetract(String id) async => null;

Future<Map<String, dynamic>?> bridgeQqField(String key, Object? value) async => null;

Future<Map<String, dynamic>?> bridgeQqTargets() async => null;

Future<Map<String, dynamic>?> bridgeProtocolStart() async => null;

Future<Map<String, dynamic>?> bridgeBiliConfig({required bool enabled}) async => null;

Future<Map<String, dynamic>?> bridgeBiliField(String key, Object? value) async => null;

Future<Map<String, dynamic>?> bridgeQqConfig(
        {bool? enabled, String? baseUrl, String? token, bool? atOnly}) async =>
    null;
Future<Map<String, dynamic>?> bridgeFishGalleryRemove(String name) async =>
    null;

Future<Map<String, dynamic>?> bridgeActivityRecord({required String platform, required String kind, String text = '', String actor = 'fish'}) async => null;

Future<Map<String, dynamic>?> bridgeStickerUpdate({String id = '', String? name, List<String>? tags}) async =>
    null;

Future<Map<String, dynamic>?> bridgeKbSearch(String q, {String status = ''}) async => null;
Future<Map<String, dynamic>?> bridgeMemeStatus(String id, String status) async => null;
Future<Map<String, dynamic>?> bridgeKbUpdate(
        Map<String, Object?> fields) async =>
    null;

Future<Map<String, dynamic>?> bridgeQqInbox() async => null;
Future<Map<String, dynamic>?> bridgeQqForward(String id) async => null;

Future<Map<String, dynamic>?> bridgeNotes() async => null;
Future<Map<String, dynamic>?> bridgeNoteMove(String id, String folder) async =>
    null;

Future<bool> bridgeHealth() async => false;

Future<Map<String, dynamic>?> bridgeConfigGet() async => null;
Future<Map<String, dynamic>?> bridgeConfigSave(Map<String, Object?> patch) async => null;

Future<Map<String, dynamic>?> bridgeQqChatAction(Map<String, Object?> body) async => null;

Future<Map<String, dynamic>?> bridgeQqChatMode(String chatKey, String mode) async => null;

Future<Map<String, dynamic>?> bridgeFishProfileGet() async => null;
Future<Map<String, dynamic>?> bridgeFishProfile({String? name, String? ownerTitle, String? persona, String? ownerQQ, String? ownerSession}) async => null;
Future<Map<String, dynamic>?> bridgeFishPersonaGet([String roleId = '']) async => null;
Future<Map<String, dynamic>?> bridgeFishPersonaSave(String roleId, String text) async => null;
Future<Map<String, dynamic>?> bridgeFishRoles(String action, {String id = '', String name = '', bool? pinned}) async => null;
Future<Map<String, dynamic>?> bridgeFishRoleImage(String id, String base64) async => null;
Future<Map<String, dynamic>?> bridgeProtocolStatus() async => null;
Future<Map<String, dynamic>?> bridgeStickerWishes() async => null;
Future<Map<String, dynamic>?> bridgeStickerWishDecide(String id, bool accept) async => null;
String stickerWishImageUrl(String id) => '';
String fishPortraitUrl({num? mood, Map<String, int> dims = const {}}) => '';
Future<Map<String, dynamic>?> bridgeProtocolStop() async => null;
Future<Map<String, dynamic>?> bridgeQqProbeLogin() async => null;
Future<Map<String, dynamic>?> bridgeNoteSave({String? id, required String title, required String body, required String folder, double? x, double? y}) async => null;
Future<Map<String, dynamic>?> bridgeNoteDelete(String id) async => null;
