#include "../shared/ffi_exports.h"

#include <windows.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <queue>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_command_line.h"
#include "include/cef_parser.h"
#include "include/cef_permission_handler.h"
#include "include/cef_resource_handler.h"
#include "include/cef_resource_request_handler.h"
#include "include/cef_scheme.h"
#include "include/cef_task.h"
#include "include/wrapper/cef_helpers.h"

#include "../shared/cef_response_filter.h"
#include "../shared/webview_storage.h"

namespace {

constexpr wchar_t kMessageWindowClass[] = L"BuniteMessageWindow";
constexpr wchar_t kWindowClass[] = L"BuniteWindowClass";
constexpr UINT kRunQueuedTaskMessage = WM_APP + 1;

struct WindowHost;
struct ViewHost;
class BuniteCefClient;

enum class PermissionRequestKind {
  Prompt,
  MediaAccess
};

struct PendingPermissionRequest {
  PermissionRequestKind kind;
  uint32_t permissions = 0;
  CefRefPtr<CefPermissionPromptCallback> prompt_callback;
  CefRefPtr<CefMediaAccessCallback> media_callback;
};

struct PendingMessageBoxRequest {
  uint32_t view_id = 0;
  int32_t cancel_id = -1;
};

struct ViewHost {
  uint32_t id = 0;
  WindowHost* window = nullptr;
  RECT bounds{0, 0, 0, 0};
  std::string url;
  std::string html;
  std::string preload_script;
  std::string views_root;
  std::vector<std::string> navigation_rules;
  bool auto_resize = true;
  bool sandbox = false;
  std::atomic<bool> closing = false;
  CefRefPtr<CefBrowser> browser;
  CefRefPtr<BuniteCefClient> client;
};

struct WindowHost {
  uint32_t id = 0;
  HWND hwnd = nullptr;
  std::wstring title;
  std::wstring title_bar_style;
  RECT frame{0, 0, 0, 0};
  bool transparent = false;
  bool hidden = false;
  bool minimized = false;
  bool maximized = false;
  bool restore_maximized_after_minimize = false;
  std::atomic<bool> closing = false;
  std::vector<ViewHost*> views;
};

struct RuntimeState {
  std::mutex lifecycle_mutex;
  std::condition_variable lifecycle_cv;
  bool init_finished = false;
  bool init_success = false;
  bool initialized = false;
  bool shutting_down = false;

  std::thread ui_thread;
  DWORD ui_thread_id = 0;
  HWND message_window = nullptr;

  std::mutex task_mutex;
  std::queue<std::function<void()>> queued_tasks;

  std::mutex object_mutex;
  std::map<uint32_t, WindowHost*> windows_by_id;
  std::map<uint32_t, ViewHost*> views_by_id;
  std::map<int, uint32_t> browser_to_view_id;

  std::mutex permission_mutex;
  std::map<uint32_t, PendingPermissionRequest> pending_permissions;
  uint32_t next_permission_request_id = 1;

  std::mutex message_box_mutex;
  std::map<uint32_t, PendingMessageBoxRequest> pending_message_boxes;
  uint32_t next_message_box_request_id = 1;

  BuniteWebviewEventHandler webview_event_handler = nullptr;
  BuniteWindowEventHandler window_event_handler = nullptr;

  bool cef_initialized = false;
  std::string process_helper_path;
  std::string cef_dir;
  bool popup_blocking = false;
  std::map<std::string, std::string> chromium_flags;
  std::thread::id cef_owner_thread;
};

RuntimeState g_runtime;

void emitWindowEvent(uint32_t window_id, const char* event_name, const std::string& payload = {});
void emitWebviewEvent(uint32_t view_id, const char* event_name, const std::string& payload = {});

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

std::vector<std::string> splitButtonLabels(const std::string& buttons_csv) {
  std::vector<std::string> labels;
  if (buttons_csv.empty()) {
    return labels;
  }

  std::stringstream stream(buttons_csv);
  std::string label;
  while (std::getline(stream, label, '\x1f')) {
    const size_t first = label.find_first_not_of(" \t");
    if (first == std::string::npos) {
      continue;
    }
    const size_t last = label.find_last_not_of(" \t");
    std::string normalized = label.substr(first, last - first + 1);
    std::transform(
      normalized.begin(),
      normalized.end(),
      normalized.begin(),
      [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); }
    );
    if (!normalized.empty()) {
      labels.push_back(normalized);
    }
  }

  return labels;
}

std::string trimAsciiWhitespace(const std::string& value) {
  const size_t first = value.find_first_not_of(" \t\r\n");
  if (first == std::string::npos) {
    return {};
  }
  const size_t last = value.find_last_not_of(" \t\r\n");
  return value.substr(first, last - first + 1);
}

std::string toLowerAscii(std::string value) {
  std::transform(
    value.begin(),
    value.end(),
    value.begin(),
    [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); }
  );
  return value;
}

std::string buildButtonLabelsJson(const std::vector<std::string>& labels) {
  std::string json = "[";
  for (size_t index = 0; index < labels.size(); index += 1) {
    if (index > 0) {
      json += ",";
    }
    json += "\"";
    json += escapeJsonString(labels[index]);
    json += "\"";
  }
  json += "]";
  return json;
}

std::optional<std::pair<uint32_t, int32_t>> parseMessageBoxResponseUrl(const std::string& url) {
  constexpr std::string_view prefix = "views://internal/__bunite/message-box-response";
  if (url.rfind(prefix.data(), 0) != 0) {
    return std::nullopt;
  }

  const size_t query_pos = url.find('?');
  if (query_pos == std::string::npos || query_pos + 1 >= url.size()) {
    return std::nullopt;
  }

  uint32_t request_id = 0;
  int32_t response = -1;
  bool has_request_id = false;
  bool has_response = false;

  std::stringstream stream(url.substr(query_pos + 1));
  std::string pair;
  while (std::getline(stream, pair, '&')) {
    const size_t equals_pos = pair.find('=');
    if (equals_pos == std::string::npos) {
      continue;
    }

    const std::string key = pair.substr(0, equals_pos);
    const std::string value = pair.substr(equals_pos + 1);
    if (key == "requestId") {
      request_id = static_cast<uint32_t>(std::strtoul(value.c_str(), nullptr, 10));
      has_request_id = true;
    } else if (key == "response") {
      response = static_cast<int32_t>(std::strtol(value.c_str(), nullptr, 10));
      has_response = true;
    }
  }

  if (!has_request_id || !has_response) {
    return std::nullopt;
  }

  return std::make_pair(request_id, response);
}

bool tryResolvePendingMessageBoxRequest(uint32_t view_id, uint32_t request_id, int32_t response) {
  std::optional<PendingMessageBoxRequest> request;
  {
    std::lock_guard<std::mutex> lock(g_runtime.message_box_mutex);
    const auto it = g_runtime.pending_message_boxes.find(request_id);
    if (it == g_runtime.pending_message_boxes.end()) {
      return false;
    }
    request = it->second;
    g_runtime.pending_message_boxes.erase(it);
  }

  if (!request || request->view_id != view_id) {
    return false;
  }

  emitWebviewEvent(
    view_id,
    "message-box-response",
    "{\"requestId\":" + std::to_string(request_id) +
      ",\"response\":" + std::to_string(response) + "}"
  );
  return true;
}

void cancelPendingMessageBoxesForView(uint32_t view_id) {
  std::vector<std::pair<uint32_t, int32_t>> pending;
  {
    std::lock_guard<std::mutex> lock(g_runtime.message_box_mutex);
    for (const auto& [request_id, request] : g_runtime.pending_message_boxes) {
      if (request.view_id == view_id) {
        pending.emplace_back(request_id, request.cancel_id);
      }
    }
    for (const auto& [request_id, _] : pending) {
      g_runtime.pending_message_boxes.erase(request_id);
    }
  }

  for (const auto& [request_id, cancel_id] : pending) {
    emitWebviewEvent(
      view_id,
      "message-box-response",
      "{\"requestId\":" + std::to_string(request_id) +
        ",\"response\":" + std::to_string(cancel_id >= 0 ? cancel_id : -1) + "}"
    );
  }
}

void cancelPendingMessageBoxRequest(uint32_t request_id) {
  std::lock_guard<std::mutex> lock(g_runtime.message_box_mutex);
  g_runtime.pending_message_boxes.erase(request_id);
}

ViewHost* getPreferredMessageBoxView() {
  std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
  const HWND foreground = GetForegroundWindow();

  if (foreground) {
    for (const auto& [_, window] : g_runtime.windows_by_id) {
      if (!window || window->hwnd != foreground) {
        continue;
      }
      for (auto* view : window->views) {
        if (view && view->browser && !view->closing.load()) {
          return view;
        }
      }
    }
  }

  for (const auto& [_, window] : g_runtime.windows_by_id) {
    if (!window || window->hidden) {
      continue;
    }
    for (auto* view : window->views) {
      if (view && view->browser && !view->closing.load()) {
        return view;
      }
    }
  }

  for (const auto& [_, view] : g_runtime.views_by_id) {
    if (view && view->browser && !view->closing.load()) {
      return view;
    }
  }

  return nullptr;
}

std::string buildBrowserMessageBoxScript(
  uint32_t request_id,
  const std::string& type,
  const std::string& title,
  const std::string& message,
  const std::string& detail,
  const std::vector<std::string>& buttons,
  int32_t default_id,
  int32_t cancel_id
) {
  const int32_t safe_default_id =
    buttons.empty() ? 0 : std::clamp<int32_t>(default_id, 0, static_cast<int32_t>(buttons.size() - 1));
  const int32_t safe_cancel_id =
    cancel_id >= 0 && !buttons.empty()
      ? std::clamp<int32_t>(cancel_id, 0, static_cast<int32_t>(buttons.size() - 1))
      : cancel_id;

  return R"JS((() => {
  const spec = {
    requestId: )JS" + std::to_string(request_id) + R"JS(,
    type: ")JS" + escapeJsonString(type) + R"JS(",
    title: ")JS" + escapeJsonString(title) + R"JS(",
    message: ")JS" + escapeJsonString(message) + R"JS(",
    detail: ")JS" + escapeJsonString(detail) + R"JS(",
    buttons: )JS" + buildButtonLabelsJson(buttons) + R"JS(,
    defaultId: )JS" + std::to_string(safe_default_id) + R"JS(,
    cancelId: )JS" + std::to_string(safe_cancel_id) + R"JS(
  };
  const rootId = `__bunite_message_box_${spec.requestId}`;
  if (document.getElementById(rootId)) {
    return;
  }

  const submit = (response) => {
    const params = new URLSearchParams({
      requestId: String(spec.requestId),
      response: String(response)
    });
    fetch(`views://internal/__bunite/message-box-response?${params.toString()}`, {
      method: "GET",
      cache: "no-store"
    }).catch(() => {});
  };

  const mount = () => {
    const host = document.body ?? document.documentElement;
    if (!host) {
      return;
    }

    const overlay = document.createElement("div");
    overlay.id = rootId;
    overlay.dataset.buniteMessageBox = "true";
    overlay.dataset.buniteMessageBoxRequestId = String(spec.requestId);
    overlay.tabIndex = -1;
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "padding:24px",
      "background:rgba(15,23,42,0.42)",
      "backdrop-filter:blur(6px)",
      "z-index:2147483647",
      "font-family:Segoe UI, Arial, sans-serif"
    ].join(";");

    const panel = document.createElement("div");
    panel.style.cssText = [
      "width:min(480px, calc(100vw - 48px))",
      "border-radius:16px",
      "border:1px solid rgba(15,23,42,0.10)",
      "background:#ffffff",
      "box-shadow:0 24px 80px rgba(15,23,42,0.28)",
      "padding:20px 20px 18px",
      "color:#0f172a"
    ].join(";");

    const accent = document.createElement("div");
    const accentColor =
      spec.type === "error" ? "#dc2626" :
      spec.type === "warning" ? "#d97706" :
      spec.type === "question" ? "#2563eb" :
      "#0f766e";
    accent.style.cssText = `width:48px;height:4px;border-radius:999px;background:${accentColor};margin-bottom:14px;`;
    panel.appendChild(accent);

    if (spec.title) {
      const heading = document.createElement("h1");
      heading.textContent = spec.title;
      heading.style.cssText = "margin:0 0 8px;font-size:20px;line-height:1.25;font-weight:700;";
      panel.appendChild(heading);
    }

    if (spec.message) {
      const body = document.createElement("p");
      body.textContent = spec.message;
      body.style.cssText = "margin:0;font-size:14px;line-height:1.55;white-space:pre-wrap;";
      panel.appendChild(body);
    }

    if (spec.detail) {
      const detail = document.createElement("p");
      detail.textContent = spec.detail;
      detail.style.cssText = "margin:10px 0 0;font-size:12px;line-height:1.55;color:#475569;white-space:pre-wrap;";
      panel.appendChild(detail);
    }

    const buttonRow = document.createElement("div");
    buttonRow.style.cssText = "display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:18px;";
    spec.buttons.forEach((label, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.dataset.buniteMessageBoxButtonIndex = String(index);
      button.style.cssText =
        index === spec.defaultId
          ? "appearance:none;border:0;border-radius:999px;background:#111827;color:#ffffff;padding:10px 16px;font:600 13px Segoe UI, Arial, sans-serif;cursor:pointer;"
          : "appearance:none;border:1px solid rgba(15,23,42,0.14);border-radius:999px;background:#f8fafc;color:#0f172a;padding:10px 16px;font:600 13px Segoe UI, Arial, sans-serif;cursor:pointer;";
      button.addEventListener("click", () => {
        overlay.remove();
        submit(index);
      });
      buttonRow.appendChild(button);
    });
    panel.appendChild(buttonRow);
    overlay.appendChild(panel);
    host.appendChild(overlay);

    overlay.addEventListener("click", (event) => {
      if (event.target !== overlay) {
        return;
      }
      overlay.remove();
      submit(spec.cancelId >= 0 ? spec.cancelId : spec.defaultId);
    });

    overlay.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      overlay.remove();
      submit(spec.cancelId >= 0 ? spec.cancelId : spec.defaultId);
    });

    requestAnimationFrame(() => {
      overlay.focus();
      const defaultButton = overlay.querySelector(`[data-bunite-message-box-button-index="${spec.defaultId}"]`);
      if (defaultButton instanceof HTMLButtonElement) {
        defaultButton.focus();
      }
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();)JS";
}

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

std::map<std::string, std::string> parseChromiumFlagsJson(const std::string& json) {
  std::map<std::string, std::string> flags;
  if (json.empty()) {
    return flags;
  }

  CefRefPtr<CefValue> parsed = CefParseJSON(json, JSON_PARSER_RFC);
  if (!parsed || parsed->GetType() != VTYPE_DICTIONARY) {
    return flags;
  }

  CefRefPtr<CefDictionaryValue> dict = parsed->GetDictionary();
  if (!dict) {
    return flags;
  }

  CefDictionaryValue::KeyList keys;
  dict->GetKeys(keys);
  for (const auto& key : keys) {
    const std::string k = key.ToString();
    switch (dict->GetType(key)) {
      case VTYPE_BOOL:
        flags[k] = dict->GetBool(key) ? "true" : "false";
        break;
      case VTYPE_STRING:
        flags[k] = dict->GetString(key).ToString();
        break;
      default:
        break;
    }
  }

  return flags;
}

bool shouldAlwaysAllowNavigationUrl(const std::string& url) {
  return url == "about:blank" || url.rfind("views://internal/", 0) == 0;
}

bool shouldAllowNavigation(const ViewHost* view, const std::string& url) {
  if (!view || shouldAlwaysAllowNavigationUrl(url) || view->navigation_rules.empty()) {
    return true;
  }

  bool allowed = true; // Match electrobun's last-match-wins, default-allow semantics.
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

class DeferredCefTask : public CefTask {
public:
  explicit DeferredCefTask(std::function<void()> task)
    : task_(std::move(task)) {}

  void Execute() override {
    task_();
  }

private:
  std::function<void()> task_;

  IMPLEMENT_REFCOUNTING(DeferredCefTask);
};

void postTask(std::function<void()> task) {
  CefPostTask(TID_UI, new DeferredCefTask(std::move(task)));
}

template <typename Result>
Result runOnUiThreadSync(std::function<Result()> task) {
  if (CefCurrentlyOn(TID_UI)) {
    return task();
  }

  auto packaged = std::make_shared<std::packaged_task<Result()>>(std::move(task));
  auto future = packaged->get_future();
  postTask([packaged]() { (*packaged)(); });
  return future.get();
}

template <>
void runOnUiThreadSync<void>(std::function<void()> task) {
  if (CefCurrentlyOn(TID_UI)) {
    task();
    return;
  }

  auto packaged = std::make_shared<std::packaged_task<void()>>(std::move(task));
  auto future = packaged->get_future();
  postTask([packaged]() { (*packaged)(); });
  future.get();
}

std::string normalizeViewsPath(const std::string& url) {
  std::string path = url;
  if (path.rfind("views://", 0) == 0) {
    path = path.substr(8);
  }

  const auto query_pos = path.find_first_of("?#");
  if (query_pos != std::string::npos) {
    path = path.substr(0, query_pos);
  }

  while (!path.empty() && (path.front() == '/' || path.front() == '\\')) {
    path.erase(path.begin());
  }

  while (!path.empty() && (path.back() == '/' || path.back() == '\\')) {
    path.pop_back();
  }

  return path.empty() ? "index.html" : path;
}

std::string getMimeType(const std::filesystem::path& file_path) {
  const auto extension = file_path.extension().string();
  if (extension == ".html" || extension == ".htm") return "text/html";
  if (extension == ".js" || extension == ".mjs") return "text/javascript";
  if (extension == ".css") return "text/css";
  if (extension == ".json") return "application/json";
  if (extension == ".svg") return "image/svg+xml";
  if (extension == ".png") return "image/png";
  if (extension == ".jpg" || extension == ".jpeg") return "image/jpeg";
  if (extension == ".woff2") return "font/woff2";
  if (extension == ".woff") return "font/woff";
  if (extension == ".ttf") return "font/ttf";
  return "application/octet-stream";
}

std::string getViewsRootForView(uint32_t view_id) {
  std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
  const auto it = g_runtime.views_by_id.find(view_id);
  if (it == g_runtime.views_by_id.end() || !it->second) {
    return {};
  }
  return it->second->views_root;
}

std::optional<std::string> loadViewsResource(uint32_t view_id, const std::string& url, std::string& mime_type) {
  const std::string views_root = getViewsRootForView(view_id);

  const std::string path = normalizeViewsPath(url);
  if (path == "internal/index.html") {
    mime_type = "text/html";
    return bunite::WebviewContentStorage::instance().get(view_id);
  }

  if (views_root.empty()) {
    return std::nullopt;
  }

  if (!std::filesystem::exists(views_root)) {
    return std::nullopt;
  }

  const std::filesystem::path root = std::filesystem::weakly_canonical(std::filesystem::path(views_root));
  std::filesystem::path candidate = std::filesystem::weakly_canonical(root / std::filesystem::path(path));
  if (std::filesystem::exists(candidate) && std::filesystem::is_directory(candidate)) {
    candidate = std::filesystem::weakly_canonical(candidate / "index.html");
  }
  const auto root_string = root.native();
  const auto candidate_string = candidate.native();
  const bool in_root = candidate_string == root_string ||
    (candidate_string.size() > root_string.size() &&
      candidate_string.rfind(root_string, 0) == 0 &&
      (candidate_string[root_string.size()] == L'\\' || candidate_string[root_string.size()] == L'/'));

  if (!in_root || !std::filesystem::exists(candidate) || std::filesystem::is_directory(candidate)) {
    return std::nullopt;
  }

  std::ifstream stream(candidate, std::ios::binary);
  if (!stream) {
    return std::nullopt;
  }

  std::ostringstream contents;
  contents << stream.rdbuf();
  mime_type = getMimeType(candidate);
  return contents.str();
}

void removeBrowserMapping(int browser_id) {
  std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
  g_runtime.browser_to_view_id.erase(browser_id);
}

void syncWindowFrame(WindowHost* window) {
  if (!window || !window->hwnd) {
    return;
  }

  RECT rect{};
  GetWindowRect(window->hwnd, &rect);
  window->frame = rect;
  window->minimized = IsIconic(window->hwnd) != 0;
  window->maximized = IsZoomed(window->hwnd) != 0;
  if (!window->minimized) {
    window->restore_maximized_after_minimize = false;
  }
}

void resizeViewToFit(ViewHost* view) {
  if (!view || !view->browser || !view->window || !view->window->hwnd) {
    return;
  }

  HWND browser_hwnd = view->browser->GetHost()->GetWindowHandle();
  if (!browser_hwnd) {
    return;
  }

  RECT bounds = view->bounds;
  if (view->auto_resize) {
    GetClientRect(view->window->hwnd, &bounds);
    view->bounds = bounds;
  }

  SetWindowPos(
    browser_hwnd,
    nullptr,
    bounds.left,
    bounds.top,
    bounds.right - bounds.left,
    bounds.bottom - bounds.top,
    SWP_NOZORDER | SWP_NOACTIVATE
  );
}

void openDevToolsForView(ViewHost* view);
void closeDevToolsForView(ViewHost* view);
void toggleDevToolsForView(ViewHost* view);

void finalizeViewHost(ViewHost* view) {
  if (!view) {
    return;
  }

  cancelPendingMessageBoxesForView(view->id);
  bunite::WebviewContentStorage::instance().remove(view->id);

  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    g_runtime.views_by_id.erase(view->id);
    if (view->window) {
      auto& views = view->window->views;
      views.erase(std::remove(views.begin(), views.end(), view), views.end());
    }
  }

  delete view;
}

void closeViewHost(ViewHost* view) {
  if (!view || view->closing.exchange(true)) {
    return;
  }

  if (view->browser) {
    closeDevToolsForView(view);
    view->browser->GetHost()->CloseBrowser(true);
    return;
  }

  finalizeViewHost(view);
}

void openDevToolsForView(ViewHost* view);
void closeDevToolsForView(ViewHost* view);
void toggleDevToolsForView(ViewHost* view);

void finalizeWindowHost(WindowHost* window) {
  if (!window) {
    return;
  }

  for (auto* view : window->views) {
    if (view) {
      view->window = nullptr;
    }
  }
  window->views.clear();

  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    g_runtime.windows_by_id.erase(window->id);
  }

  delete window;
}

class BuniteSchemeHandler : public CefResourceHandler {
public:
  explicit BuniteSchemeHandler(uint32_t view_id)
    : view_id_(view_id) {}

  bool Open(CefRefPtr<CefRequest> request, bool& handle_request, CefRefPtr<CefCallback>) override {
    CEF_REQUIRE_IO_THREAD();
    handle_request = true;

    if (request) {
      const auto message_box_response = parseMessageBoxResponseUrl(request->GetURL().ToString());
      if (message_box_response) {
        tryResolvePendingMessageBoxRequest(
          view_id_,
          message_box_response->first,
          message_box_response->second
        );
        status_code_ = 204;
        status_text_ = "No Content";
        mime_type_ = "text/plain";
        data_.clear();
        return true;
      }
    }

    std::string mime_type;
    const std::string url = request ? request->GetURL().ToString() : "";
    const auto content = loadViewsResource(view_id_, url, mime_type);
    if (!content) {
      const std::string views_root = getViewsRootForView(view_id_);
      const std::string normalized_path = normalizeViewsPath(url);
      std::fprintf(
        stderr,
        "[bunite/native] views:// resource not found (view=%u, url=%s, normalized=%s, root=%s)\n",
        view_id_,
        url.c_str(),
        normalized_path.c_str(),
        views_root.c_str()
      );
      status_code_ = 404;
      status_text_ = "Not Found";
      mime_type_ = "text/plain";
      data_ =
        "bunite could not resolve the requested views:// resource.\n"
        "url: " + url + "\n" +
        "normalized: " + normalized_path;
      return true;
    }

    status_code_ = 200;
    status_text_ = "OK";
    mime_type_ = mime_type;
    data_ = *content;
    return true;
  }

  void GetResponseHeaders(CefRefPtr<CefResponse> response, int64_t& response_length, CefString&) override {
    response->SetStatus(status_code_);
    response->SetStatusText(status_text_);
    response->SetMimeType(mime_type_);
    response_length = static_cast<int64_t>(data_.size());
  }

  bool Read(void* data_out, int bytes_to_read, int& bytes_read, CefRefPtr<CefResourceReadCallback>) override {
    CEF_REQUIRE_IO_THREAD();
    bytes_read = 0;
    if (offset_ >= data_.size()) {
      return false;
    }

    const size_t remaining = data_.size() - offset_;
    const size_t count = std::min<size_t>(remaining, static_cast<size_t>(bytes_to_read));
    std::memcpy(data_out, data_.data() + offset_, count);
    offset_ += count;
    bytes_read = static_cast<int>(count);
    return true;
  }

  void Cancel() override {
    CEF_REQUIRE_IO_THREAD();
  }

private:
  uint32_t view_id_;
  std::string data_;
  std::string mime_type_ = "text/plain";
  std::string status_text_ = "OK";
  size_t offset_ = 0;
  int status_code_ = 200;

  IMPLEMENT_REFCOUNTING(BuniteSchemeHandler);
};

class BuniteSchemeHandlerFactory : public CefSchemeHandlerFactory {
public:
  CefRefPtr<CefResourceHandler> Create(
    CefRefPtr<CefBrowser> browser,
    CefRefPtr<CefFrame>,
    const CefString&,
    CefRefPtr<CefRequest>
  ) override {
    uint32_t view_id = 0;
    if (browser) {
      std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
      const auto it = g_runtime.browser_to_view_id.find(browser->GetIdentifier());
      if (it != g_runtime.browser_to_view_id.end()) {
        view_id = it->second;
      }
    }
    return new BuniteSchemeHandler(view_id);
  }

private:
  IMPLEMENT_REFCOUNTING(BuniteSchemeHandlerFactory);
};

class BuniteCefApp : public CefApp, public CefBrowserProcessHandler {
public:
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override {
    return this;
  }

  void OnBeforeCommandLineProcessing(const CefString&, CefRefPtr<CefCommandLine> command_line) override {
    if (!g_runtime.popup_blocking) {
      // Bunite handles popup attempts in OnBeforePopup and surfaces them to Bun.
      // Keep Chromium's popup blocker off by default so scripted window.open()
      // still reaches the runtime-level handler.
      command_line->AppendSwitch("disable-popup-blocking");
    }

    // Run GPU code inside the browser process instead of a separate
    // subprocess.  The GPU subprocess crashes on some Windows setups with
    // "Failed to create shared context for virtualization" regardless of
    // the ANGLE backend, because the subprocess cannot initialise EGL/D3D11
    // shared contexts.  In-process GPU avoids this entirely.
    // Apps can override this by passing { "in-process-gpu": false } in
    // chromiumFlags to restore the default multi-process GPU model.
    if (g_runtime.chromium_flags.find("in-process-gpu") == g_runtime.chromium_flags.end()) {
      command_line->AppendSwitch("in-process-gpu");
    }

    for (const auto& [key, value] : g_runtime.chromium_flags) {
      if (value == "false") {
        // Explicit false: skip the flag entirely (allows overriding defaults).
        continue;
      }
      if (value.empty() || value == "true") {
        command_line->AppendSwitch(key);
      } else {
        command_line->AppendSwitchWithValue(key, value);
      }
    }
  }

  void OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) override {
    registrar->AddCustomScheme(
      "views",
      CEF_SCHEME_OPTION_STANDARD |
        CEF_SCHEME_OPTION_CORS_ENABLED |
        CEF_SCHEME_OPTION_SECURE |
        CEF_SCHEME_OPTION_CSP_BYPASSING |
        CEF_SCHEME_OPTION_FETCH_ENABLED
    );
  }

private:
  IMPLEMENT_REFCOUNTING(BuniteCefApp);
};

class BuniteCefClient
  : public CefClient,
    public CefLifeSpanHandler,
    public CefLoadHandler,
    public CefRequestHandler,
    public CefResourceRequestHandler,
    public CefPermissionHandler {
public:
  explicit BuniteCefClient(ViewHost* view)
    : view_(view),
      preload_script_(view ? view->preload_script : "") {}

  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefRequestHandler> GetRequestHandler() override { return this; }
  CefRefPtr<CefPermissionHandler> GetPermissionHandler() override { return this; }

  CefRefPtr<CefResourceRequestHandler> GetResourceRequestHandler(
    CefRefPtr<CefBrowser>,
    CefRefPtr<CefFrame>,
    CefRefPtr<CefRequest>,
    bool,
    bool,
    const CefString&,
    bool&
  ) override {
    return this;
  }

  CefRefPtr<CefResponseFilter> GetResourceResponseFilter(
    CefRefPtr<CefBrowser>,
    CefRefPtr<CefFrame> frame,
    CefRefPtr<CefRequest> request,
    CefRefPtr<CefResponse> response
  ) override {
    if (!frame->IsMain() || !response) {
      return nullptr;
    }

    const std::string mime_type = response->GetMimeType().ToString();
    const std::string url = request ? request->GetURL().ToString() : "";
    if (
      mime_type.find("html") == std::string::npos ||
      preload_script_.empty() ||
      url.rfind("views://", 0) != 0
    ) {
      return nullptr;
    }

    return new BuniteResponseFilter(preload_script_);
  }

  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    view_->browser = browser;
    {
      std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
      g_runtime.browser_to_view_id[browser->GetIdentifier()] = view_->id;
    }
    resizeViewToFit(view_);
  }

  bool DoClose(CefRefPtr<CefBrowser>) override {
    CEF_REQUIRE_UI_THREAD();
    return false;
  }

  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    removeBrowserMapping(browser->GetIdentifier());
    view_->browser = nullptr;
    if (view_->closing.load()) {
      finalizeViewHost(view_);
    }
  }

  bool OnBeforeBrowse(
    CefRefPtr<CefBrowser>,
    CefRefPtr<CefFrame> frame,
    CefRefPtr<CefRequest> request,
    bool,
    bool
  ) override {
    CEF_REQUIRE_UI_THREAD();
    const bool is_main_frame = frame && frame->IsMain();
    const std::string url = request ? request->GetURL().ToString() : "";
    const bool should_allow = !is_main_frame || shouldAllowNavigation(view_, url);

    if (is_main_frame) {
      cancelPendingMessageBoxesForView(view_->id);
      emitWebviewEvent(view_->id, "will-navigate", url);
    }

    return !should_allow;
  }

  bool OnOpenURLFromTab(
    CefRefPtr<CefBrowser>,
    CefRefPtr<CefFrame>,
    const CefString& target_url,
    CefRequestHandler::WindowOpenDisposition target_disposition,
    bool
  ) override {
    CEF_REQUIRE_UI_THREAD();
    if (target_disposition != CEF_WOD_CURRENT_TAB) {
      emitWebviewEvent(
        view_->id,
        "new-window-open",
        "{\"url\":\"" + escapeJsonString(target_url.ToString()) + "\"}"
      );
      return true;
    }
    return false;
  }

  bool OnBeforePopup(
    CefRefPtr<CefBrowser>,
    CefRefPtr<CefFrame>,
    int,
    const CefString& target_url,
    const CefString&,
    CefLifeSpanHandler::WindowOpenDisposition,
    bool,
    const CefPopupFeatures&,
    CefWindowInfo&,
    CefRefPtr<CefClient>&,
    CefBrowserSettings&,
    CefRefPtr<CefDictionaryValue>&,
    bool*
  ) override {
    CEF_REQUIRE_UI_THREAD();
    emitWebviewEvent(
      view_->id,
      "new-window-open",
      "{\"url\":\"" + escapeJsonString(target_url.ToString()) + "\"}"
    );
    return true;
  }

  void OnLoadEnd(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, int) override {
    CEF_REQUIRE_UI_THREAD();
    if (!frame->IsMain()) {
      return;
    }

    const std::string url = frame->GetURL().ToString();
    emitWebviewEvent(view_->id, "did-navigate", url);
    emitWebviewEvent(view_->id, "dom-ready", url);
  }

  bool OnShowPermissionPrompt(
    CefRefPtr<CefBrowser>,
    uint64_t,
    const CefString& requesting_origin,
    uint32_t requested_permissions,
    CefRefPtr<CefPermissionPromptCallback> callback
  ) override;

  bool OnRequestMediaAccessPermission(
    CefRefPtr<CefBrowser>,
    CefRefPtr<CefFrame>,
    const CefString& requesting_origin,
    uint32_t requested_permissions,
    CefRefPtr<CefMediaAccessCallback> callback
  ) override;

private:
  ViewHost* view_;
  std::string preload_script_;

  IMPLEMENT_REFCOUNTING(BuniteCefClient);
};

bool BuniteCefClient::OnShowPermissionPrompt(
  CefRefPtr<CefBrowser>,
  uint64_t,
  const CefString& requesting_origin,
  uint32_t requested_permissions,
  CefRefPtr<CefPermissionPromptCallback> callback
) {
  CEF_REQUIRE_UI_THREAD();

  uint32_t request_id = 0;
  {
    std::lock_guard<std::mutex> lock(g_runtime.permission_mutex);
    request_id = g_runtime.next_permission_request_id++;
    g_runtime.pending_permissions.emplace(
      request_id,
      PendingPermissionRequest{ PermissionRequestKind::Prompt, requested_permissions, callback, nullptr }
    );
  }

  emitWebviewEvent(
    view_->id,
    "permission-requested",
    "{\"requestId\":" + std::to_string(request_id) +
      ",\"kind\":" + std::to_string(requested_permissions) +
      ",\"url\":\"" + escapeJsonString(requesting_origin.ToString()) + "\"}"
  );
  return true;
}

bool BuniteCefClient::OnRequestMediaAccessPermission(
  CefRefPtr<CefBrowser>,
  CefRefPtr<CefFrame>,
  const CefString& requesting_origin,
  uint32_t requested_permissions,
  CefRefPtr<CefMediaAccessCallback> callback
) {
  CEF_REQUIRE_UI_THREAD();

  uint32_t request_id = 0;
  {
    std::lock_guard<std::mutex> lock(g_runtime.permission_mutex);
    request_id = g_runtime.next_permission_request_id++;
    g_runtime.pending_permissions.emplace(
      request_id,
      PendingPermissionRequest{ PermissionRequestKind::MediaAccess, requested_permissions, nullptr, callback }
    );
  }

  emitWebviewEvent(
    view_->id,
    "permission-requested",
    "{\"requestId\":" + std::to_string(request_id) +
      ",\"kind\":" + std::to_string(requested_permissions) +
      ",\"url\":\"" + escapeJsonString(requesting_origin.ToString()) + "\"}"
  );
  return true;
}

void openDevToolsForView(ViewHost* view) {
  if (!view || view->closing.load() || !view->browser) {
    return;
  }

  CefWindowInfo window_info;
  window_info.SetAsPopup(nullptr, "Bunite DevTools");

  CefBrowserSettings settings;
  view->browser->GetHost()->ShowDevTools(window_info, nullptr, settings, CefPoint());
}

void closeDevToolsForView(ViewHost* view) {
  if (!view || view->closing.load() || !view->browser) {
    return;
  }

  view->browser->GetHost()->CloseDevTools();
}

void toggleDevToolsForView(ViewHost* view) {
  if (!view || view->closing.load() || !view->browser) {
    return;
  }

  if (view->browser->GetHost()->HasDevTools()) {
    closeDevToolsForView(view);
    return;
  }

  openDevToolsForView(view);
}

LRESULT CALLBACK messageWindowProc(HWND hwnd, UINT message, WPARAM, LPARAM) {
  return DefWindowProcW(hwnd, message, 0, 0);
}

LRESULT CALLBACK buniteWindowProc(HWND hwnd, UINT message, WPARAM w_param, LPARAM l_param) {
  WindowHost* window = reinterpret_cast<WindowHost*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));

  if (message == WM_NCCREATE) {
    auto* create_struct = reinterpret_cast<CREATESTRUCTW*>(l_param);
    window = static_cast<WindowHost*>(create_struct->lpCreateParams);
    SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(window));
    return DefWindowProcW(hwnd, message, w_param, l_param);
  }

  switch (message) {
    case WM_SETFOCUS:
      if (window) {
        emitWindowEvent(window->id, "focus");
      }
      break;

    case WM_KILLFOCUS:
      if (window) {
        emitWindowEvent(window->id, "blur");
      }
      break;

    case WM_MOVE:
      if (window) {
        syncWindowFrame(window);
        emitWindowEvent(
          window->id,
          "move",
          "{\"x\":" + std::to_string(window->frame.left) +
            ",\"y\":" + std::to_string(window->frame.top) +
            ",\"maximized\":" + (window->maximized ? "true" : "false") +
            ",\"minimized\":" + (window->minimized ? "true" : "false") + "}"
        );
      }
      break;

    case WM_SIZE:
      if (window) {
        syncWindowFrame(window);

        for (auto* view : window->views) {
          resizeViewToFit(view);
        }

        emitWindowEvent(
          window->id,
          "resize",
          "{\"x\":" + std::to_string(window->frame.left) +
            ",\"y\":" + std::to_string(window->frame.top) +
            ",\"width\":" + std::to_string(window->frame.right - window->frame.left) +
            ",\"height\":" + std::to_string(window->frame.bottom - window->frame.top) +
            ",\"maximized\":" + (window->maximized ? "true" : "false") +
            ",\"minimized\":" + (window->minimized ? "true" : "false") + "}"
        );
      }
      break;

    case WM_CLOSE:
      if (window && !window->closing.exchange(true)) {
        emitWindowEvent(window->id, "close");
        const auto views = window->views;
        for (auto* view : views) {
          closeViewHost(view);
        }
      }
      DestroyWindow(hwnd);
      return 0;

    case WM_NCDESTROY:
      if (window) {
        window->hwnd = nullptr;
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        finalizeWindowHost(window);
      }
      return 0;
  }

  return DefWindowProcW(hwnd, message, w_param, l_param);
}

bool registerWindowClasses() {
  static std::once_flag once;
  static bool registered = false;

  std::call_once(once, []() {
    WNDCLASSW window_class{};
    window_class.lpfnWndProc = buniteWindowProc;
    window_class.hInstance = GetModuleHandleW(nullptr);
    window_class.lpszClassName = kWindowClass;
    window_class.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    window_class.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);

    registered = RegisterClassW(&window_class) != 0;
  });

  return registered;
}

bool initializeCefOnUiThread() {
  if (g_runtime.process_helper_path.empty() || g_runtime.cef_dir.empty()) {
    std::fprintf(stderr, "[bunite/native] Missing process helper or CEF directory.\n");
    return false;
  }
  if (!registerWindowClasses()) {
    std::fprintf(stderr, "[bunite/native] Failed to register window classes.\n");
    return false;
  }

  const std::filesystem::path cef_root(g_runtime.cef_dir);
  const std::filesystem::path dll_dir = std::filesystem::exists(cef_root / "Release" / "libcef.dll")
    ? cef_root / "Release"
    : cef_root;
  const std::filesystem::path resource_dir = std::filesystem::exists(cef_root / "Resources" / "resources.pak")
    ? cef_root / "Resources"
    : cef_root;
  const std::filesystem::path locales_dir = std::filesystem::exists(resource_dir / "locales")
    ? resource_dir / "locales"
    : (std::filesystem::exists(cef_root / "Resources" / "locales")
        ? cef_root / "Resources" / "locales"
        : (std::filesystem::exists(cef_root / "locales") ? cef_root / "locales" : resource_dir / "locales"));

  SetDllDirectoryW(dll_dir.native().c_str());

  CefMainArgs main_args(GetModuleHandleW(nullptr));
  CefRefPtr<BuniteCefApp> app = new BuniteCefApp();
  const int execute_result = CefExecuteProcess(main_args, app, nullptr);
  if (execute_result >= 0) {
    std::fprintf(stderr, "[bunite/native] CefExecuteProcess exited early with code %d.\n", execute_result);
    return false;
  }

  CefSettings settings{};
  settings.no_sandbox = true;
  settings.multi_threaded_message_loop = true;
  settings.external_message_pump = false;

  CefString(&settings.browser_subprocess_path) = g_runtime.process_helper_path;
  CefString(&settings.resources_dir_path) = resource_dir.wstring();
  CefString(&settings.locales_dir_path) = locales_dir.wstring();
  if (const char* user_data_dir = std::getenv("BUNITE_USER_DATA_DIR")) {
    CefString(&settings.cache_path) = user_data_dir;
  }

  settings.log_severity = LOGSEVERITY_ERROR;
  CefString(&settings.log_file) = "";

  if (!CefInitialize(main_args, settings, app, nullptr)) {
    std::fprintf(stderr, "[bunite/native] CefInitialize returned false.\n");
    return false;
  }

  g_runtime.cef_initialized = true;
  CefRegisterSchemeHandlerFactory("views", "", new BuniteSchemeHandlerFactory());
  return true;
}

void shutdownCefOnUiThread() {
  if (g_runtime.cef_initialized) {
    CefClearSchemeHandlerFactories();
    CefShutdown();
    g_runtime.cef_initialized = false;
  }
}

void closeAllWindowsForShutdown() {
  std::vector<WindowHost*> windows;
  std::vector<ViewHost*> orphan_views;
  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    for (const auto& [_, window] : g_runtime.windows_by_id) {
      windows.push_back(window);
    }
    for (const auto& [_, view] : g_runtime.views_by_id) {
      if (!view->window) {
        orphan_views.push_back(view);
      }
    }
  }

  for (auto* window : windows) {
    if (window && window->hwnd) {
      SendMessageW(window->hwnd, WM_CLOSE, 0, 0);
    }
  }

  for (auto* view : orphan_views) {
    closeViewHost(view);
  }
}

bool waitForAllViewsToClose(int timeout_ms) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  while (std::chrono::steady_clock::now() < deadline) {
    {
      std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
      if (g_runtime.views_by_id.empty()) {
        return true;
      }
    }
    Sleep(10);
  }

  return false;
}

WindowHost* getWindowHost(void* window_ptr) {
  return static_cast<WindowHost*>(window_ptr);
}

ViewHost* getViewHost(void* view_ptr) {
  return static_cast<ViewHost*>(view_ptr);
}

DWORD makeWindowStyle(const std::wstring& title_bar_style) {
  DWORD style = WS_OVERLAPPEDWINDOW;
  if (title_bar_style == L"hidden" || title_bar_style == L"hiddenInset") {
    style &= ~WS_CAPTION;
  }
  return style;
}

bool createBrowserForView(ViewHost* view) {
  auto* window = view->window;
  if (!window || !window->hwnd) {
    return false;
  }

  view->client = new BuniteCefClient(view);
  if (!view->html.empty()) {
    bunite::WebviewContentStorage::instance().set(view->id, view->html);
  }

  const std::string initial_url = !view->html.empty()
    ? "views://internal/index.html"
    : (!view->url.empty() ? view->url : "about:blank");

  CefWindowInfo window_info;
  CefRect child_bounds(
    view->bounds.left,
    view->bounds.top,
    view->bounds.right - view->bounds.left,
    view->bounds.bottom - view->bounds.top
  );
  window_info.SetAsChild(window->hwnd, child_bounds);

  CefBrowserSettings browser_settings;
  CefRefPtr<CefBrowser> browser = CefBrowserHost::CreateBrowserSync(
    window_info,
    view->client,
    initial_url,
    browser_settings,
    nullptr,
    nullptr
  );

  view->browser = browser;
  return browser != nullptr;
}

} // namespace

extern "C" BUNITE_EXPORT bool bunite_init(
  const char* process_helper_path,
  const char* cef_dir,
  bool hide_console,
  bool popup_blocking,
  const char* chromium_flags_json
) {
  std::lock_guard<std::mutex> lock(g_runtime.lifecycle_mutex);
  if (g_runtime.initialized) {
    return true;
  }
  g_runtime.shutting_down = false;
  g_runtime.process_helper_path = process_helper_path ? process_helper_path : "";
  g_runtime.cef_dir = cef_dir ? cef_dir : "";
  g_runtime.popup_blocking = popup_blocking;
  g_runtime.chromium_flags = parseChromiumFlagsJson(
    chromium_flags_json ? chromium_flags_json : "");
  g_runtime.cef_owner_thread = std::this_thread::get_id();

  if (hide_console) {
    if (HWND console = GetConsoleWindow()) {
      ShowWindow(console, SW_HIDE);
    }
  }

  g_runtime.init_success = initializeCefOnUiThread();
  g_runtime.init_finished = true;
  g_runtime.initialized = g_runtime.init_success;
  return g_runtime.init_success;
}

extern "C" BUNITE_EXPORT void bunite_run_loop(void) {
  // The native UI thread owns the Win32 + CEF loop as soon as bunite_init succeeds.
}

extern "C" BUNITE_EXPORT void bunite_free_cstring(const char* value) {
  std::free(const_cast<char*>(value));
}

extern "C" BUNITE_EXPORT void bunite_quit(void) {
  bool should_shutdown = false;
  {
    std::lock_guard<std::mutex> lock(g_runtime.lifecycle_mutex);
    if (!g_runtime.initialized) {
      return;
    }
    if (g_runtime.cef_owner_thread != std::this_thread::get_id()) {
      std::fprintf(stderr, "[bunite/native] bunite_quit must run on the same thread as bunite_init.\n");
      return;
    }
    g_runtime.shutting_down = true;
    g_runtime.initialized = false;
    g_runtime.init_finished = false;
    g_runtime.init_success = false;
    should_shutdown = g_runtime.cef_initialized;
  }

  if (!should_shutdown) {
    return;
  }

  runOnUiThreadSync<void>([]() { closeAllWindowsForShutdown(); });
  if (!waitForAllViewsToClose(2000)) {
    std::fprintf(stderr, "[bunite/native] Skipping CefShutdown because browsers are still closing.\n");
    return;
  }
  shutdownCefOnUiThread();
}

extern "C" BUNITE_EXPORT void bunite_set_webview_event_handler(BuniteWebviewEventHandler handler) {
  std::lock_guard<std::mutex> lock(g_runtime.lifecycle_mutex);
  g_runtime.webview_event_handler = handler;
}

extern "C" BUNITE_EXPORT void bunite_set_window_event_handler(BuniteWindowEventHandler handler) {
  std::lock_guard<std::mutex> lock(g_runtime.lifecycle_mutex);
  g_runtime.window_event_handler = handler;
}

extern "C" BUNITE_EXPORT void* bunite_window_create(
  uint32_t window_id,
  double x,
  double y,
  double width,
  double height,
  const char* title,
  const char* title_bar_style,
  bool transparent,
  bool hidden,
  bool minimized,
  bool maximized
) {
  return runOnUiThreadSync<void*>([=]() -> void* {
    auto* window = new WindowHost{
      window_id,
      nullptr,
      utf8ToWide(title ? title : ""),
      utf8ToWide(title_bar_style ? title_bar_style : ""),
      RECT{
        static_cast<LONG>(x),
        static_cast<LONG>(y),
        static_cast<LONG>(x + width),
        static_cast<LONG>(y + height)
      },
      transparent,
      hidden,
      minimized,
      maximized,
      false
    };

    window->hwnd = CreateWindowExW(
      0,
      kWindowClass,
      window->title.c_str(),
      makeWindowStyle(window->title_bar_style),
      static_cast<int>(x),
      static_cast<int>(y),
      static_cast<int>(std::max(width, 100.0)),
      static_cast<int>(std::max(height, 100.0)),
      nullptr,
      nullptr,
      GetModuleHandleW(nullptr),
      window
    );

    if (!window->hwnd) {
      delete window;
      return nullptr;
    }

    {
      std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
      g_runtime.windows_by_id[window_id] = window;
    }

    if (!hidden) {
      ShowWindow(window->hwnd, minimized ? SW_SHOWMINIMIZED : (maximized ? SW_SHOWMAXIMIZED : SW_SHOW));
      UpdateWindow(window->hwnd);
    }

    return window;
  });
}

extern "C" BUNITE_EXPORT void bunite_window_show(void* window_ptr) {
  runOnUiThreadSync<void>([window = getWindowHost(window_ptr)]() {
    if (!window || !window->hwnd) {
      return;
    }
    window->hidden = false;
    ShowWindow(
      window->hwnd,
      window->minimized ? SW_SHOWMINIMIZED : (window->maximized ? SW_SHOWMAXIMIZED : SW_SHOW)
    );
    SetForegroundWindow(window->hwnd);
  });
}

extern "C" BUNITE_EXPORT void bunite_window_close(void* window_ptr) {
  runOnUiThreadSync<void>([window = getWindowHost(window_ptr)]() {
    if (!window || !window->hwnd) {
      return;
    }
    SendMessageW(window->hwnd, WM_CLOSE, 0, 0);
  });
}

extern "C" BUNITE_EXPORT void bunite_window_set_title(void* window_ptr, const char* title) {
  runOnUiThreadSync<void>([window = getWindowHost(window_ptr), value = std::string(title ? title : "")]() {
    if (!window || !window->hwnd) {
      return;
    }
    window->title = utf8ToWide(value);
    SetWindowTextW(window->hwnd, window->title.c_str());
  });
}

extern "C" BUNITE_EXPORT void bunite_window_minimize(void* window_ptr) {
  runOnUiThreadSync<void>([window = getWindowHost(window_ptr)]() {
    if (!window || !window->hwnd) {
      return;
    }

    window->restore_maximized_after_minimize = window->maximized;
    window->minimized = true;
    window->maximized = false;
    if (window->hidden) {
      return;
    }

    ShowWindow(window->hwnd, SW_MINIMIZE);
  });
}

extern "C" BUNITE_EXPORT void bunite_window_unminimize(void* window_ptr) {
  runOnUiThreadSync<void>([window = getWindowHost(window_ptr)]() {
    if (!window || !window->hwnd) {
      return;
    }

    window->minimized = false;
    if (window->hidden) {
      window->maximized = window->restore_maximized_after_minimize;
      window->restore_maximized_after_minimize = false;
      return;
    }

    ShowWindow(window->hwnd, SW_RESTORE);
  });
}

extern "C" BUNITE_EXPORT bool bunite_window_is_minimized(void* window_ptr) {
  return runOnUiThreadSync<bool>([window = getWindowHost(window_ptr)]() -> bool {
    if (!window || !window->hwnd) {
      return false;
    }
    if (window->hidden) {
      return window->minimized;
    }

    window->minimized = IsIconic(window->hwnd) != 0;
    return window->minimized;
  });
}

extern "C" BUNITE_EXPORT void bunite_window_maximize(void* window_ptr) {
  runOnUiThreadSync<void>([window = getWindowHost(window_ptr)]() {
    if (!window || !window->hwnd) {
      return;
    }

    window->minimized = false;
    window->restore_maximized_after_minimize = false;
    window->maximized = true;
    if (window->hidden) {
      return;
    }

    ShowWindow(window->hwnd, SW_MAXIMIZE);
  });
}

extern "C" BUNITE_EXPORT void bunite_window_unmaximize(void* window_ptr) {
  runOnUiThreadSync<void>([window = getWindowHost(window_ptr)]() {
    if (!window || !window->hwnd) {
      return;
    }

    window->minimized = false;
    window->restore_maximized_after_minimize = false;
    window->maximized = false;
    if (window->hidden) {
      return;
    }

    ShowWindow(window->hwnd, SW_RESTORE);
  });
}

extern "C" BUNITE_EXPORT bool bunite_window_is_maximized(void* window_ptr) {
  return runOnUiThreadSync<bool>([window = getWindowHost(window_ptr)]() -> bool {
    if (!window || !window->hwnd) {
      return false;
    }
    if (window->hidden) {
      return window->maximized;
    }

    window->maximized = IsZoomed(window->hwnd) != 0;
    return window->maximized;
  });
}

extern "C" BUNITE_EXPORT void bunite_window_set_frame(
  void* window_ptr,
  double x,
  double y,
  double width,
  double height
) {
  runOnUiThreadSync<void>([window = getWindowHost(window_ptr), x, y, width, height]() {
    if (!window || !window->hwnd) {
      return;
    }

    SetWindowPos(
      window->hwnd,
      nullptr,
      static_cast<int>(x),
      static_cast<int>(y),
      static_cast<int>(std::max(width, 100.0)),
      static_cast<int>(std::max(height, 100.0)),
      SWP_NOZORDER | SWP_NOACTIVATE
    );
  });
}

extern "C" BUNITE_EXPORT void* bunite_view_create(
  uint32_t view_id,
  void* window_ptr,
  const char* url,
  const char* html,
  const char* preload,
  const char* views_root,
  const char* navigation_rules_json,
  double x,
  double y,
  double width,
  double height,
  bool auto_resize,
  bool sandbox
) {
  return runOnUiThreadSync<void*>([=]() -> void* {
    auto* window = getWindowHost(window_ptr);
    if (!window || !window->hwnd) {
      return nullptr;
    }

    auto* view = new ViewHost{
      view_id,
      window,
      RECT{
        static_cast<LONG>(x),
        static_cast<LONG>(y),
        static_cast<LONG>(x + width),
        static_cast<LONG>(y + height)
      },
      url ? url : "",
      html ? html : "",
      preload ? preload : "",
      views_root ? views_root : "",
      parseNavigationRulesJson(navigation_rules_json ? navigation_rules_json : ""),
      auto_resize,
      sandbox
    };

    {
      std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
      g_runtime.views_by_id[view_id] = view;
      window->views.push_back(view);
    }

    if (!createBrowserForView(view)) {
      {
        std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
        g_runtime.views_by_id.erase(view_id);
        window->views.erase(std::remove(window->views.begin(), window->views.end(), view), window->views.end());
      }
      delete view;
      return nullptr;
    }

    return view;
  });
}

extern "C" BUNITE_EXPORT void bunite_view_load_url(void* view_ptr, const char* url) {
  runOnUiThreadSync<void>([view = getViewHost(view_ptr), next_url = std::string(url ? url : "")]() {
    if (!view) {
      return;
    }

    view->url = next_url;
    view->html.clear();
    bunite::WebviewContentStorage::instance().remove(view->id);
    if (view->browser && view->browser->GetMainFrame()) {
      view->browser->GetMainFrame()->LoadURL(next_url);
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_load_html(void* view_ptr, const char* html) {
  runOnUiThreadSync<void>([view = getViewHost(view_ptr), content = std::string(html ? html : "")]() {
    if (!view) {
      return;
    }

    view->html = content;
    bunite::WebviewContentStorage::instance().set(view->id, content);
    if (view->browser && view->browser->GetMainFrame()) {
      view->browser->GetMainFrame()->LoadURL("views://internal/index.html");
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_remove(void* view_ptr) {
  runOnUiThreadSync<void>([view = getViewHost(view_ptr)]() { closeViewHost(view); });
}

extern "C" BUNITE_EXPORT void bunite_view_open_devtools(void* view_ptr) {
  runOnUiThreadSync<void>([view = getViewHost(view_ptr)]() { openDevToolsForView(view); });
}

extern "C" BUNITE_EXPORT void bunite_view_close_devtools(void* view_ptr) {
  runOnUiThreadSync<void>([view = getViewHost(view_ptr)]() { closeDevToolsForView(view); });
}

extern "C" BUNITE_EXPORT void bunite_view_toggle_devtools(void* view_ptr) {
  runOnUiThreadSync<void>([view = getViewHost(view_ptr)]() { toggleDevToolsForView(view); });
}

extern "C" BUNITE_EXPORT void bunite_complete_permission_request(uint32_t request_id, uint32_t state) {
  runOnUiThreadSync<void>([=]() {
    std::optional<PendingPermissionRequest> request;
    {
      std::lock_guard<std::mutex> lock(g_runtime.permission_mutex);
      const auto it = g_runtime.pending_permissions.find(request_id);
      if (it == g_runtime.pending_permissions.end()) {
        return;
      }
      request = it->second;
      g_runtime.pending_permissions.erase(it);
    }

    if (!request) {
      return;
    }

    const bool allow = state != 0;
    if (request->kind == PermissionRequestKind::Prompt && request->prompt_callback) {
      request->prompt_callback->Continue(
        allow ? CEF_PERMISSION_RESULT_ACCEPT : CEF_PERMISSION_RESULT_DENY
      );
      return;
    }

    if (request->kind == PermissionRequestKind::MediaAccess && request->media_callback) {
      if (allow) {
        request->media_callback->Continue(request->permissions);
      } else {
        request->media_callback->Cancel();
      }
    }
  });
}

extern "C" BUNITE_EXPORT int32_t bunite_show_message_box(
  const char* type,
  const char* title,
  const char* message,
  const char* detail,
  const char* buttons,
  int32_t default_id,
  int32_t cancel_id
) {
  return runOnUiThreadSync<int32_t>([=]() -> int32_t {
    std::string composed_message = message ? message : "";
    if (detail && std::strlen(detail) > 0) {
      if (!composed_message.empty()) {
        composed_message += "\n\n";
      }
      composed_message += detail;
    }

    UINT flags = MB_OK;
    const std::string type_name = type ? type : "info";
    if (type_name == "none") {
      // Intentionally no icon flag.
    } else if (type_name == "warning") {
      flags |= MB_ICONWARNING;
    } else if (type_name == "error") {
      flags |= MB_ICONERROR;
    } else if (type_name == "question") {
      flags |= MB_ICONQUESTION;
    } else {
      flags |= MB_ICONINFORMATION;
    }

    const std::vector<std::string> labels = splitButtonLabels(buttons ? buttons : "");
    std::vector<std::string> normalized_labels;
    normalized_labels.reserve(labels.size());
    for (const std::string& label : labels) {
      normalized_labels.push_back(toLowerAscii(trimAsciiWhitespace(label)));
    }

    if (normalized_labels.size() == 2) {
      if (normalized_labels[0] == "yes" && normalized_labels[1] == "no") {
        flags = (flags & ~MB_OK) | MB_YESNO;
      } else {
        flags = (flags & ~MB_OK) | MB_OKCANCEL;
      }
    } else if (
      normalized_labels.size() >= 3 &&
      normalized_labels[0] == "yes" &&
      normalized_labels[1] == "no" &&
      normalized_labels[2] == "cancel"
    ) {
      flags = (flags & ~MB_OK) | MB_YESNOCANCEL;
    }

    if (default_id == 1) {
      flags |= MB_DEFBUTTON2;
    } else if (default_id >= 2) {
      flags |= MB_DEFBUTTON3;
    }

    const std::wstring window_title = utf8ToWide(title ? title : "");
    const std::wstring window_message = utf8ToWide(composed_message);
    const int result = MessageBoxW(GetActiveWindow(), window_message.c_str(), window_title.c_str(), flags);

    switch (result) {
      case IDOK:
      case IDYES:
        return 0;
      case IDNO:
        return 1;
      case IDCANCEL:
        // `-1` means the JS side did not provide an explicit cancel target.
        return cancel_id >= 0 ? cancel_id : (labels.size() > 2 ? 2 : 1);
      default:
        return cancel_id >= 0 ? cancel_id : -1;
    }
  });
}

extern "C" BUNITE_EXPORT uint32_t bunite_show_browser_message_box(
  const char* type,
  const char* title,
  const char* message,
  const char* detail,
  const char* buttons,
  int32_t default_id,
  int32_t cancel_id
) {
  return runOnUiThreadSync<uint32_t>([=]() -> uint32_t {
    ViewHost* view = getPreferredMessageBoxView();
    if (!view || !view->browser || !view->browser->GetMainFrame()) {
      return 0;
    }

    const uint32_t request_id = [&]() {
      std::lock_guard<std::mutex> lock(g_runtime.message_box_mutex);
      uint32_t id = g_runtime.next_message_box_request_id++;
      if (id == 0) {
        id = g_runtime.next_message_box_request_id++;
      }
      g_runtime.pending_message_boxes.emplace(
        id,
        PendingMessageBoxRequest{
          view->id,
          cancel_id
        }
      );
      return id;
    }();

    const std::vector<std::string> labels = splitButtonLabels(buttons ? buttons : "");
    const std::vector<std::string> browser_labels = labels.empty()
      ? std::vector<std::string>{ "OK" }
      : labels;

    view->browser->GetMainFrame()->ExecuteJavaScript(
      buildBrowserMessageBoxScript(
        request_id,
        type ? type : "info",
        title ? title : "",
        message ? message : "",
        detail ? detail : "",
        browser_labels,
        default_id,
        cancel_id
      ),
      view->browser->GetMainFrame()->GetURL(),
      0
    );

    return request_id;
  });
}

extern "C" BUNITE_EXPORT void bunite_cancel_browser_message_box(uint32_t request_id) {
  runOnUiThreadSync<void>([=]() { cancelPendingMessageBoxRequest(request_id); });
}
