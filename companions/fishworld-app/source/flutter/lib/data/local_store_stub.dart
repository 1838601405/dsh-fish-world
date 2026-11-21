final Map<String, String> _mem = {};
String? readLocal(String key) => _mem[key];
void writeLocal(String key, String value) => _mem[key] = value;
