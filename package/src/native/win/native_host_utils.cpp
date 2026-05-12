#include "native_host_internal.h"

namespace bunite_win {

// ---------------------------------------------------------------------------
// String / encoding utilities
// ---------------------------------------------------------------------------

std::wstring utf8ToWide(const std::string& value) {
  if (value.empty()) {
    return {};
  }

  const int required = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);
  if (required <= 0) {
    return {};
  }

  std::wstring converted(required - 1, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, converted.data(), required);
  return converted;
}

std::string escapeJsonString(const std::string& value) {
  std::string escaped;
  escaped.reserve(value.size());

  for (const unsigned char ch : value) {
    switch (ch) {
      case '\\':
        escaped += "\\\\";
        break;
      case '"':
        escaped += "\\\"";
        break;
      case '\n':
        escaped += "\\n";
        break;
      case '\r':
        escaped += "\\r";
        break;
      case '\t':
        escaped += "\\t";
        break;
      default:
        if (ch < 0x20) {
          char buffer[7];
          std::snprintf(buffer, sizeof(buffer), "\\u%04x", ch);
          escaped += buffer;
        } else {
          escaped.push_back(static_cast<char>(ch));
        }
        break;
    }
  }

  return escaped;
}

// ---------------------------------------------------------------------------
// Chromium flags parsing
// ---------------------------------------------------------------------------


// Flat JSON object parser for Chromium flags (Record<string, string|boolean>). No CEF dep — runs before CefInitialize.
std::map<std::string, std::string> parseChromiumFlagsJson(const std::string& json) {
  std::map<std::string, std::string> flags;
  if (json.empty()) {
    return flags;
  }

  size_t pos = json.find('{');
  if (pos == std::string::npos) {
    return flags;
  }
  ++pos;

  auto skipWhitespace = [&]() {
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t' || json[pos] == '\n' || json[pos] == '\r')) {
      ++pos;
    }
  };

  auto parseString = [&]() -> std::string {
    if (pos >= json.size() || json[pos] != '"') {
      return {};
    }
    ++pos;
    std::string result;
    while (pos < json.size() && json[pos] != '"') {
      if (json[pos] == '\\' && pos + 1 < json.size()) {
        ++pos;
      }
      result += json[pos++];
    }
    if (pos < json.size()) {
      ++pos; // closing quote
    }
    return result;
  };

  while (pos < json.size()) {
    skipWhitespace();
    if (pos >= json.size() || json[pos] == '}') {
      break;
    }
    if (json[pos] == ',') {
      ++pos;
      continue;
    }

    std::string key = parseString();
    if (key.empty()) {
      break;
    }

    skipWhitespace();
    if (pos >= json.size() || json[pos] != ':') {
      break;
    }
    ++pos;
    skipWhitespace();

    if (pos >= json.size()) {
      break;
    }

    if (json[pos] == '"') {
      flags[key] = parseString();
    } else if (json.compare(pos, 4, "true") == 0) {
      flags[key] = "true";
      pos += 4;
    } else if (json.compare(pos, 5, "false") == 0) {
      flags[key] = "false";
      pos += 5;
    } else {
      while (pos < json.size() && json[pos] != ',' && json[pos] != '}') {
        ++pos;
      }
    }
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Navigation rules
// ---------------------------------------------------------------------------

bool globMatchCaseInsensitive(const std::string& pattern, const std::string& value) {
  size_t pattern_index = 0;
  size_t value_index = 0;
  size_t star_pattern_index = std::string::npos;
  size_t star_value_index = 0;

  while (value_index < value.size()) {
    if (
      pattern_index < pattern.size() &&
      std::tolower(static_cast<unsigned char>(pattern[pattern_index])) ==
        std::tolower(static_cast<unsigned char>(value[value_index]))
    ) {
      pattern_index += 1;
      value_index += 1;
    } else if (pattern_index < pattern.size() && pattern[pattern_index] == '*') {
      star_pattern_index = pattern_index++;
      star_value_index = value_index;
    } else if (star_pattern_index != std::string::npos) {
      pattern_index = star_pattern_index + 1;
      value_index = ++star_value_index;
    } else {
      return false;
    }
  }

  while (pattern_index < pattern.size() && pattern[pattern_index] == '*') {
    pattern_index += 1;
  }

  return pattern_index == pattern.size();
}

std::vector<std::string> parseNavigationRulesJson(const std::string& rules_json) {
  std::vector<std::string> rules;
  if (rules_json.empty()) {
    return rules;
  }

  CefRefPtr<CefValue> parsed = CefParseJSON(rules_json, JSON_PARSER_RFC);
  if (!parsed || parsed->GetType() != VTYPE_LIST) {
    return rules;
  }

  CefRefPtr<CefListValue> list = parsed->GetList();
  if (!list) {
    return rules;
  }

  rules.reserve(list->GetSize());
  for (size_t index = 0; index < list->GetSize(); index += 1) {
    if (list->GetType(index) != VTYPE_STRING) {
      continue;
    }

    const std::string rule = list->GetString(index).ToString();
    if (!rule.empty()) {
      rules.push_back(rule);
    }
  }

  return rules;
}

bool shouldAlwaysAllowNavigationUrl(const std::string& url) {
  return url == "about:blank" || url.rfind("appres://app.internal/internal/", 0) == 0;
}

uint32_t cefPermissionsToBuniteKind(uint32_t cef_bits) {
  uint32_t bunite = 0;
  if (cef_bits & CEF_PERMISSION_TYPE_MIC_STREAM)    bunite |= BUNITE_PERMISSION_MICROPHONE;
  if (cef_bits & CEF_PERMISSION_TYPE_CAMERA_STREAM) bunite |= BUNITE_PERMISSION_CAMERA;
  if (cef_bits & CEF_PERMISSION_TYPE_GEOLOCATION)   bunite |= BUNITE_PERMISSION_GEOLOCATION;
  if (cef_bits & CEF_PERMISSION_TYPE_NOTIFICATIONS) bunite |= BUNITE_PERMISSION_NOTIFICATIONS;
  if (cef_bits & CEF_PERMISSION_TYPE_CLIPBOARD)     bunite |= BUNITE_PERMISSION_CLIPBOARD;
  if (cef_bits & CEF_PERMISSION_TYPE_POINTER_LOCK)  bunite |= BUNITE_PERMISSION_POINTER_LOCK;
  if (cef_bits & CEF_PERMISSION_TYPE_MIDI_SYSEX)    bunite |= BUNITE_PERMISSION_MIDI_SYSEX;
  return bunite;
}

uint32_t cefMediaAccessToBuniteKind(uint32_t cef_bits) {
  uint32_t bunite = 0;
  if (cef_bits & CEF_MEDIA_PERMISSION_DEVICE_AUDIO_CAPTURE) bunite |= BUNITE_PERMISSION_MICROPHONE;
  if (cef_bits & CEF_MEDIA_PERMISSION_DEVICE_VIDEO_CAPTURE) bunite |= BUNITE_PERMISSION_CAMERA;
  if (cef_bits & (CEF_MEDIA_PERMISSION_DESKTOP_AUDIO_CAPTURE |
                  CEF_MEDIA_PERMISSION_DESKTOP_VIDEO_CAPTURE)) bunite |= BUNITE_PERMISSION_SCREEN_CAPTURE;
  return bunite;
}

bool shouldAllowNavigation(const ViewHost* view, const std::string& url) {
  if (!view || shouldAlwaysAllowNavigationUrl(url) || view->navigation_rules.empty()) {
    return true;
  }

  bool allowed = true; // default-allow, last-match-wins
  for (const std::string& raw_rule : view->navigation_rules) {
    const bool is_block_rule = !raw_rule.empty() && raw_rule.front() == '^';
    const std::string pattern = is_block_rule ? raw_rule.substr(1) : raw_rule;

    if (pattern.empty()) {
      continue;
    }
    if (globMatchCaseInsensitive(pattern, url)) {
      allowed = !is_block_rule;
    }
  }

  return allowed;
}

// ---------------------------------------------------------------------------
// Event emit
// ---------------------------------------------------------------------------

void emitWindowEvent(uint32_t window_id, const char* event_name, const std::string& payload) {
  BuniteWindowEventHandler handler = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_runtime.lifecycle_mutex);
    handler = g_runtime.window_event_handler;
  }
  if (handler) {
    handler(window_id, _strdup(event_name ? event_name : ""), _strdup(payload.c_str()));
  }
}

void emitWebviewEvent(uint32_t view_id, const char* event_name, const std::string& payload) {
  BuniteWebviewEventHandler handler = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_runtime.lifecycle_mutex);
    handler = g_runtime.webview_event_handler;
  }
  if (handler) {
    handler(view_id, _strdup(event_name ? event_name : ""), _strdup(payload.c_str()));
  }
}

} // namespace bunite_win
