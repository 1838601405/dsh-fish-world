final Map<String, String> _memory = <String, String>{};

String? get(String key) => _memory[key];
void set(String key, String value) => _memory[key] = value;
