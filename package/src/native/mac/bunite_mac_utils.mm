// String conversion + event emit helpers + navigation rule matching.

#import "bunite_mac_internal.h"

#include <cctype>
#include <cstdio>
#include <cstring>  // strdup

namespace bunite_mac {

NSString* utf8ToNSString(const char* value) {
  if (!value) return @"";
  return [NSString stringWithUTF8String:value] ?: @"";
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

NSRect topLeftToBottomLeft(double x, double y, double width, double height) {
  CGFloat screenH = [NSScreen mainScreen].frame.size.height;
  return NSMakeRect(x, screenH - y - height, width, height);
}

void bottomLeftToTopLeft(NSRect frame, double* out_x, double* out_y, double* out_w, double* out_h) {
  CGFloat screenH = [NSScreen mainScreen].frame.size.height;
  *out_x = frame.origin.x;
  *out_y = screenH - frame.origin.y - frame.size.height;
  *out_w = frame.size.width;
  *out_h = frame.size.height;
}

void emitWindowEvent(uint32_t window_id, const char* event_name, const std::string& payload) {
  // Bun calls bunite_free_cstring — strdup so we don't return .rodata or temporary pointers.
  if (BuniteWindowEventHandler h = g_runtime.window_event_handler) {
    h(window_id, strdup(event_name ? event_name : ""), strdup(payload.c_str()));
  }
}

void emitWebviewEvent(uint32_t view_id, const char* event_name, const std::string& payload) {
  if (BuniteWebviewEventHandler h = g_runtime.webview_event_handler) {
    h(view_id, strdup(event_name ? event_name : ""), strdup(payload.c_str()));
  }
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

std::vector<std::string> parseNavigationRulesJson(NSString* json) {
  std::vector<std::string> rules;
  if (json.length == 0) return rules;
  NSData* data = [json dataUsingEncoding:NSUTF8StringEncoding];
  if (!data) return rules;
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![parsed isKindOfClass:[NSArray class]]) return rules;
  for (id entry in (NSArray*)parsed) {
    if (![entry isKindOfClass:[NSString class]]) continue;
    const char* s = [(NSString*)entry UTF8String];
    if (s && *s) rules.emplace_back(s);
  }
  return rules;
}

bool shouldAlwaysAllowNavigationUrl(const std::string& url) {
  return url == "about:blank" ||
         url.rfind("appres://app.internal/internal/", 0) == 0;
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

} // namespace bunite_mac
