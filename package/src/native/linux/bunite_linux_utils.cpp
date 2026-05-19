#include "bunite_linux_internal.h"

#include <json-glib/json-glib.h>

#include <cctype>
#include <cstdio>
#include <cstring>

namespace bunite_linux {

void emitWindowEvent(uint32_t window_id, const char* event_name, const std::string& payload) {
  if (BuniteWindowEventHandler h = g_runtime.window_event_handler) {
    h(window_id, strdup(event_name ? event_name : ""), strdup(payload.c_str()));
  }
}

void emitWebviewEvent(uint32_t view_id, const char* event_name, const std::string& payload) {
  if (BuniteWebviewEventHandler h = g_runtime.webview_event_handler) {
    h(view_id, strdup(event_name ? event_name : ""), strdup(payload.c_str()));
  }
}

std::string escapeJsonString(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (unsigned char c : value) {
    switch (c) {
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  return out;
}

bool globMatchCaseInsensitive(const std::string& pattern, const std::string& value) {
  size_t pi = 0, vi = 0;
  size_t star_p = std::string::npos, star_v = 0;
  while (vi < value.size()) {
    if (pi < pattern.size() &&
        std::tolower(static_cast<unsigned char>(pattern[pi])) ==
        std::tolower(static_cast<unsigned char>(value[vi]))) {
      ++pi; ++vi;
    } else if (pi < pattern.size() && pattern[pi] == '*') {
      star_p = pi++; star_v = vi;
    } else if (star_p != std::string::npos) {
      pi = star_p + 1; vi = ++star_v;
    } else {
      return false;
    }
  }
  while (pi < pattern.size() && pattern[pi] == '*') ++pi;
  return pi == pattern.size();
}

std::vector<std::string> parseNavigationRulesJson(const std::string& json) {
  std::vector<std::string> rules;
  if (json.empty()) return rules;

  JsonParser* parser = json_parser_new();
  if (!json_parser_load_from_data(parser, json.c_str(), (gssize)json.size(), nullptr)) {
    g_object_unref(parser);
    return rules;
  }
  JsonNode* root = json_parser_get_root(parser);
  if (!root || JSON_NODE_TYPE(root) != JSON_NODE_ARRAY) {
    g_object_unref(parser);
    return rules;
  }
  JsonArray* arr = json_node_get_array(root);
  const guint n = json_array_get_length(arr);
  rules.reserve(n);
  for (guint i = 0; i < n; ++i) {
    JsonNode* item = json_array_get_element(arr, i);
    if (!item || json_node_get_value_type(item) != G_TYPE_STRING) continue;
    const gchar* s = json_node_get_string(item);
    if (s && *s) rules.emplace_back(s);
  }
  g_object_unref(parser);
  return rules;
}

bool shouldAlwaysAllowNavigationUrl(const std::string& url) {
  // Exact-match — prefix would let `../../evil` style paths bypass scrutiny.
  return url == "about:blank" || url == "appres://app.internal/internal/index.html";
}

bool shouldAllowNavigation(const ViewState* view, const std::string& url) {
  if (!view || shouldAlwaysAllowNavigationUrl(url) || view->navigation_rules.empty()) {
    return true;
  }
  bool allowed = true;  // default-allow, last-match-wins
  for (const std::string& raw : view->navigation_rules) {
    const bool block = !raw.empty() && raw.front() == '^';
    const std::string pattern = block ? raw.substr(1) : raw;
    if (pattern.empty()) continue;
    if (globMatchCaseInsensitive(pattern, url)) allowed = !block;
  }
  return allowed;
}

}  // namespace bunite_linux
