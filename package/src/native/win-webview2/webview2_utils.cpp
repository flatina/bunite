#include "webview2_internal.h"

#include <shlobj.h>

namespace bunite_webview2 {

std::wstring utf8ToWide(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  std::wstring out(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), n);
  return out;
}

std::string wideToUtf8(LPCWSTR s) {
  if (!s || !*s) return {};
  int len = static_cast<int>(wcslen(s));
  int n = WideCharToMultiByte(CP_UTF8, 0, s, len, nullptr, 0, nullptr, nullptr);
  std::string out(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, s, len, out.data(), n, nullptr, nullptr);
  return out;
}

std::string wideToUtf8(const std::wstring& s) {
  return wideToUtf8(s.c_str());
}

std::string escapeJsonString(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 2);
  for (char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char buf[8];
          snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out += c;
        }
    }
  }
  return out;
}

bool globMatchCaseInsensitive(const std::string& pattern, const std::string& value) {
  auto lower = [](char c) -> char {
    return (c >= 'A' && c <= 'Z') ? static_cast<char>(c + 32) : c;
  };
  size_t pi = 0, vi = 0, star = std::string::npos, match = 0;
  while (vi < value.size()) {
    if (pi < pattern.size() && (pattern[pi] == '?' ||
                                lower(pattern[pi]) == lower(value[vi]))) {
      pi++; vi++;
    } else if (pi < pattern.size() && pattern[pi] == '*') {
      star = pi++; match = vi;
    } else if (star != std::string::npos) {
      pi = star + 1; vi = ++match;
    } else {
      return false;
    }
  }
  while (pi < pattern.size() && pattern[pi] == '*') pi++;
  return pi == pattern.size();
}

// Very small JSON-array-of-string parser. Tolerant: returns empty vector on
// any malformed input.
static std::vector<std::string> parseStringArrayJson(const std::string& json) {
  std::vector<std::string> out;
  size_t i = 0;
  while (i < json.size() && std::isspace(static_cast<unsigned char>(json[i]))) ++i;
  if (i >= json.size() || json[i] != '[') return out;
  ++i;
  while (i < json.size()) {
    while (i < json.size() &&
           (std::isspace(static_cast<unsigned char>(json[i])) || json[i] == ',')) ++i;
    if (i < json.size() && json[i] == ']') break;
    if (i >= json.size() || json[i] != '"') return {};
    ++i;
    std::string item;
    while (i < json.size() && json[i] != '"') {
      if (json[i] == '\\' && i + 1 < json.size()) {
        char nxt = json[i + 1];
        switch (nxt) {
          case 'n': item += '\n'; break;
          case 'r': item += '\r'; break;
          case 't': item += '\t'; break;
          case '"': item += '"'; break;
          case '\\': item += '\\'; break;
          case '/': item += '/'; break;
          default: item += nxt; break;
        }
        i += 2;
      } else {
        item += json[i++];
      }
    }
    if (i < json.size()) ++i;   // consume closing quote
    out.push_back(std::move(item));
  }
  return out;
}

std::vector<std::string> parseNavigationRulesJson(const std::string& json) {
  return parseStringArrayJson(json);
}

std::vector<std::string> parsePreloadOriginsJson(const std::string& json) {
  return parseStringArrayJson(json);
}

// Tiny string-keyed JSON object parser for the three keys we care about. We
// don't want a JSON library dependency for so few values.
static std::string findStringField(const std::string& json, const std::string& key) {
  std::string needle = "\"" + key + "\"";
  size_t k = json.find(needle);
  if (k == std::string::npos) return {};
  k = json.find(':', k + needle.size());
  if (k == std::string::npos) return {};
  ++k;
  while (k < json.size() && std::isspace(static_cast<unsigned char>(json[k]))) ++k;
  if (k >= json.size() || json[k] != '"') return {};
  ++k;
  std::string out;
  while (k < json.size() && json[k] != '"') {
    if (json[k] == '\\' && k + 1 < json.size()) {
      char nxt = json[k + 1];
      switch (nxt) {
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        default: out += nxt; break;
      }
      k += 2;
    } else {
      out += json[k++];
    }
  }
  return out;
}

void parseEngineConfig(const std::string& json, std::wstring& user_data,
                       std::wstring& browser_args, std::wstring& language) {
  if (json.empty()) return;
  std::string s = findStringField(json, "userDataFolder");
  if (!s.empty()) user_data = utf8ToWide(s);
  s = findStringField(json, "additionalBrowserArguments");
  if (!s.empty()) browser_args = utf8ToWide(s);
  s = findStringField(json, "language");
  if (!s.empty()) language = utf8ToWide(s);
}

std::string normalizeAppResPath(const std::string& url) {
  static const std::string prefix = "appres://app.internal";
  if (url.compare(0, prefix.size(), prefix) != 0) return {};
  std::string p = url.substr(prefix.size());
  size_t q = p.find_first_of("?#");
  if (q != std::string::npos) p = p.substr(0, q);
  if (p.empty()) return "/";
  return p;
}

std::string getMimeType(const std::filesystem::path& p) {
  std::string ext = p.extension().string();
  for (auto& c : ext) c = static_cast<char>(::tolower(static_cast<unsigned char>(c)));
  if (ext == ".html" || ext == ".htm")  return "text/html; charset=utf-8";
  if (ext == ".js" || ext == ".mjs")    return "application/javascript; charset=utf-8";
  if (ext == ".css")                    return "text/css; charset=utf-8";
  if (ext == ".json")                   return "application/json; charset=utf-8";
  if (ext == ".svg")                    return "image/svg+xml";
  if (ext == ".png")                    return "image/png";
  if (ext == ".jpg" || ext == ".jpeg")  return "image/jpeg";
  if (ext == ".gif")                    return "image/gif";
  if (ext == ".webp")                   return "image/webp";
  if (ext == ".woff")                   return "font/woff";
  if (ext == ".woff2")                  return "font/woff2";
  if (ext == ".ico")                    return "image/x-icon";
  if (ext == ".wasm")                   return "application/wasm";
  if (ext == ".map")                    return "application/json; charset=utf-8";
  return "application/octet-stream";
}

std::wstring exeDir() {
  wchar_t buf[MAX_PATH];
  DWORD n = GetModuleFileNameW(nullptr, buf, MAX_PATH);
  if (n == 0 || n == MAX_PATH) return {};
  std::wstring path(buf, n);
  size_t slash = path.find_last_of(L"\\/");
  return slash == std::wstring::npos ? std::wstring{} : path.substr(0, slash);
}

std::string defaultUserDataFolder() {
  wchar_t* base = nullptr;
  if (SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &base) != S_OK || !base) {
    if (base) CoTaskMemFree(base);
    return {};
  }
  std::wstring full(base);
  CoTaskMemFree(base);
  full += L"\\Bunite\\WebView2";
  return wideToUtf8(full);
}

uint32_t permissionKindToBuniteBit(COREWEBVIEW2_PERMISSION_KIND kind) {
  switch (kind) {
    case COREWEBVIEW2_PERMISSION_KIND_MICROPHONE:           return BUNITE_PERMISSION_MICROPHONE;
    case COREWEBVIEW2_PERMISSION_KIND_CAMERA:               return BUNITE_PERMISSION_CAMERA;
    case COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION:          return BUNITE_PERMISSION_GEOLOCATION;
    case COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS:        return BUNITE_PERMISSION_NOTIFICATIONS;
    case COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ:       return BUNITE_PERMISSION_CLIPBOARD;
    default:                                                return 0;
  }
}

COREWEBVIEW2_PERMISSION_STATE buniteStateToWebView2(uint32_t state) {
  // bunite passes 0=default, 1=allow, 2=deny
  switch (state) {
    case 1: return COREWEBVIEW2_PERMISSION_STATE_ALLOW;
    case 2: return COREWEBVIEW2_PERMISSION_STATE_DENY;
    default: return COREWEBVIEW2_PERMISSION_STATE_DEFAULT;
  }
}

bool shouldAllowNavigation(const ViewHost* view, const std::string& url) {
  if (!view || view->navigation_rules.empty()) return true;
  for (const auto& rule : view->navigation_rules) {
    if (rule.empty()) continue;
    bool allow = (rule[0] != '!');
    const std::string& pat = allow ? rule : rule.substr(1);
    if (globMatchCaseInsensitive(pat, url)) return allow;
  }
  return true;
}

}  // namespace bunite_webview2
