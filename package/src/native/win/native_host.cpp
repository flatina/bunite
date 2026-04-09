#include "../shared/ffi_exports.h"
#include "../shared/log.h"

#include <windows.h>
#include <ole2.h>

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

constexpr wchar_t kWindowClass[] = L"BuniteWindowClass";
constexpr UINT kRunQueuedTaskMessage = WM_APP + 1;
constexpr UINT kFinalizeShutdownMessage = WM_APP + 4;

struct WindowHost;
struct ViewHost;
class BuniteCefClient;
class BuniteDevToolsClient;

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

// View anchor modes for automatic layout during window resize.
// 0 = none (manual bounds), 1 = fill client area,
// 2 = top strip (fixed height), 3 = below top strip.
enum ViewAnchorMode { ANCHOR_NONE = 0, ANCHOR_FILL = 1, ANCHOR_TOP = 2, ANCHOR_BELOW_TOP = 3 };

struct ViewHost {
  uint32_t id = 0;
  WindowHost* window = nullptr;
  RECT bounds{0, 0, 0, 0};
  std::string url;
  std::string html;
  std::string preload_script;
  std::string appres_root;
  std::vector<std::string> navigation_rules;
  int anchor_mode = ANCHOR_FILL;
  double anchor_inset = 0;
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
  std::atomic<bool> close_pending = false;
  std::atomic<bool> closing = false;
  std::vector<ViewHost*> views;
};

struct RuntimeState {
  std::mutex lifecycle_mutex;
  std::condition_variable lifecycle_cv;
  bool init_finished = false;
  bool init_success = false;
  bool initialized = false;
  std::atomic<bool> shutting_down{false};
  bool shutdown_complete = false;
  std::atomic<bool> shutdown_finalize_posted{false};

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

  std::mutex route_mutex;
  struct PendingRouteRequest {
    std::string path;
    CefRefPtr<CefCallback> callback;
    CefRefPtr<CefRequest> cef_request;
  };
  std::map<uint32_t, PendingRouteRequest> pending_routes;
  uint32_t next_route_request_id = 1;

  BuniteWebviewEventHandler webview_event_handler = nullptr;
  BuniteWindowEventHandler window_event_handler = nullptr;

  bool cef_initialized = false;
  std::string process_helper_path;
  std::string cef_dir;
  bool popup_blocking = false;
  std::map<std::string, std::string> chromium_flags;
  std::atomic<int> devtools_browser_count = 0;
};

RuntimeState g_runtime;

void emitWindowEvent(uint32_t window_id, const char* event_name, const std::string& payload = {});
void emitWebviewEvent(uint32_t view_id, const char* event_name, const std::string& payload = {});

HINSTANCE getCurrentModuleHandle() {
  HMODULE module = nullptr;
  GetModuleHandleExW(
    GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
    reinterpret_cast<LPCWSTR>(&getCurrentModuleHandle),
    &module
  );
  return module;
}

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
  constexpr std::string_view prefix = "appres://internal/__bunite/message-box-response";
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
    fetch(`appres://internal/__bunite/message-box-response?${params.toString()}`, {
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

// Simple flat JSON object parser for chromiumFlags.
// Input is always a JSON-serialized Record<string, string | boolean> from TS.
// Does not depend on CEF, so it can run before CefInitialize.
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
      // skip unknown value
      while (pos < json.size() && json[pos] != ',' && json[pos] != '}') {
        ++pos;
      }
    }
  }

  return flags;
}

bool shouldAlwaysAllowNavigationUrl(const std::string& url) {
  return url == "about:blank" || url.rfind("appres://internal/", 0) == 0;
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

bool isOnUiThread() {
  return g_runtime.ui_thread_id != 0 && GetCurrentThreadId() == g_runtime.ui_thread_id;
}

void postUiTask(std::function<void()> task) {
  {
    std::lock_guard<std::mutex> lock(g_runtime.task_mutex);
    g_runtime.queued_tasks.push(std::move(task));
  }

  if (g_runtime.message_window) {
    PostMessageW(g_runtime.message_window, kRunQueuedTaskMessage, 0, 0);
  }
}

template <typename Result>
Result runOnUiThreadSync(std::function<Result()> task) {
  if (isOnUiThread()) {
    return task();
  }

  auto packaged = std::make_shared<std::packaged_task<Result()>>(std::move(task));
  auto future = packaged->get_future();
  postUiTask([packaged]() { (*packaged)(); });
  return future.get();
}

template <>
void runOnUiThreadSync<void>(std::function<void()> task) {
  if (isOnUiThread()) {
    task();
    return;
  }

  auto packaged = std::make_shared<std::packaged_task<void()>>(std::move(task));
  auto future = packaged->get_future();
  postUiTask([packaged]() { (*packaged)(); });
  future.get();
}

class CefClosureTask : public CefTask {
public:
  explicit CefClosureTask(std::function<void()> fn) : fn_(std::move(fn)) {}
  void Execute() override { fn_(); }
private:
  std::function<void()> fn_;
  IMPLEMENT_REFCOUNTING(CefClosureTask);
};

void postCefUiTask(std::function<void()> task) {
  CefPostTask(TID_UI, new CefClosureTask(std::move(task)));
}

template <typename Result>
Result runOnCefUiThreadSync(std::function<Result()> task) {
  if (CefCurrentlyOn(TID_UI)) {
    return task();
  }

  auto packaged = std::make_shared<std::packaged_task<Result()>>(std::move(task));
  auto future = packaged->get_future();
  postCefUiTask([packaged]() { (*packaged)(); });
  return future.get();
}

template <>
void runOnCefUiThreadSync<void>(std::function<void()> task) {
  if (CefCurrentlyOn(TID_UI)) {
    task();
    return;
  }

  auto packaged = std::make_shared<std::packaged_task<void()>>(std::move(task));
  auto future = packaged->get_future();
  postCefUiTask([packaged]() { (*packaged)(); });
  future.get();
}

void executeQueuedUiTasks() {
  for (;;) {
    std::queue<std::function<void()>> tasks;
    {
      std::lock_guard<std::mutex> lock(g_runtime.task_mutex);
      if (g_runtime.queued_tasks.empty()) {
        break;
      }
      tasks.swap(g_runtime.queued_tasks);
    }

    while (!tasks.empty()) {
      auto task = std::move(tasks.front());
      tasks.pop();
      task();
    }
  }
}

std::string normalizeAppResPath(const std::string& url) {
  std::string path = url;
  if (path.rfind("appres://", 0) == 0) {
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

std::string getAppResRootForView(uint32_t view_id) {
  std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
  const auto it = g_runtime.views_by_id.find(view_id);
  if (it == g_runtime.views_by_id.end() || !it->second) {
    return {};
  }
  return it->second->appres_root;
}

std::optional<std::string> loadAppResResource(uint32_t view_id, const std::string& url, std::string& mime_type) {
  const std::string appres_root = getAppResRootForView(view_id);

  const std::string path = normalizeAppResPath(url);
  if (path == "internal/index.html") {
    mime_type = "text/html";
    return bunite::WebviewContentStorage::instance().get(view_id);
  }

  if (appres_root.empty()) {
    return std::nullopt;
  }

  if (!std::filesystem::exists(appres_root)) {
    return std::nullopt;
  }

  const std::filesystem::path root = std::filesystem::weakly_canonical(std::filesystem::path(appres_root));
  std::filesystem::path candidate = std::filesystem::weakly_canonical(root / std::filesystem::path(path));
  if (std::filesystem::exists(candidate) && std::filesystem::is_directory(candidate)) {
    candidate = std::filesystem::weakly_canonical(candidate / "index.html");
  } else if (!std::filesystem::exists(candidate) && !candidate.has_extension()) {
    candidate = std::filesystem::weakly_canonical(std::filesystem::path(candidate.native() + L".html"));
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
  if (!view || !view->window || !view->window->hwnd) {
    return;
  }
  if (view->closing.load()) {
    return;
  }

  auto browser = view->browser;  // CefRefPtr copy — atomic refcount
  if (!browser) {
    return;
  }

  HWND browser_hwnd = browser->GetHost()->GetWindowHandle();
  if (!browser_hwnd) {
    return;
  }

  RECT bounds = view->bounds;
  switch (view->anchor_mode) {
    case ANCHOR_FILL: {
      GetClientRect(view->window->hwnd, &bounds);
      break;
    }
    case ANCHOR_TOP: {
      RECT client;
      GetClientRect(view->window->hwnd, &client);
      bounds = { 0, 0, client.right, static_cast<LONG>(view->anchor_inset) };
      break;
    }
    case ANCHOR_BELOW_TOP: {
      RECT client;
      GetClientRect(view->window->hwnd, &client);
      LONG inset = static_cast<LONG>(view->anchor_inset);
      LONG h = client.bottom - inset;
      if (h < 0) h = 0;
      bounds = { 0, inset, client.right, inset + h };
      break;
    }
    default: // ANCHOR_NONE - use stored bounds
      break;
  }
  view->bounds = bounds;

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
void maybeCompleteShutdownOnUiThread();
void cancelPendingPermissionRequestsOnUiThread();
void cancelPendingRouteRequestsOnUiThread();
void shutdownCefOnUiThread();

void finalizeViewHost(ViewHost* view) {
  if (!view) {
    return;
  }

  cancelPendingMessageBoxesForView(view->id);
  bunite::WebviewContentStorage::instance().remove(view->id);

  WindowHost* window = nullptr;
  bool window_views_empty = false;
  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    g_runtime.views_by_id.erase(view->id);
    if (view->window) {
      window = view->window;
      auto& views = window->views;
      views.erase(std::remove(views.begin(), views.end(), view), views.end());
      window_views_empty = views.empty();
    }
  }

  delete view;

  // All views finalized — destroy parent HWND on Win32 thread
  if (window && window->closing.load() && window_views_empty) {
    postUiTask([window]() {
      if (window->hwnd) {
        DestroyWindow(window->hwnd);
      }
    });
  }

  maybeCompleteShutdownOnUiThread();
}

void closeViewHost(ViewHost* view) {
  if (!view || view->closing.exchange(true)) {
    return;
  }

  if (view->browser) {
    postCefUiTask([view]() {
      closeDevToolsForView(view);
      view->browser->GetHost()->CloseBrowser(true);
    });
    return;
  }

  // Browser not yet created — OnAfterCreated will check closing flag.
  // Safety net: if CreateBrowser failed entirely, clean up on CEF thread.
  postCefUiTask([view]() {
    if (view->browser) {
      view->browser->GetHost()->CloseBrowser(true);
    } else {
      finalizeViewHost(view);
    }
  });
}

void openDevToolsForView(ViewHost* view);
void closeDevToolsForView(ViewHost* view);
void toggleDevToolsForView(ViewHost* view);

void destroyWindowHost(WindowHost* window) {
  if (!window || !window->hwnd) {
    return;
  }
  if (!window->closing.exchange(true)) {
    emitWindowEvent(window->id, "close");
    std::vector<ViewHost*> views_copy;
    {
      std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
      views_copy = window->views;
    }
    if (views_copy.empty()) {
      // No views — destroy HWND immediately
      DestroyWindow(window->hwnd);
    } else {
      for (auto* view : views_copy) {
        closeViewHost(view);
      }
      // DestroyWindow deferred — finalizeViewHost posts it when last view is gone
    }
  }
}

void finalizeWindowHost(WindowHost* window) {
  if (!window) {
    return;
  }

  bool all_closed = false;
  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    for (auto* view : window->views) {
      if (view) {
        view->window = nullptr;
      }
    }
    window->views.clear();
    g_runtime.windows_by_id.erase(window->id);
    all_closed = g_runtime.windows_by_id.empty();
  }

  delete window;

  if (all_closed && !g_runtime.shutting_down.load()) {
    emitWindowEvent(0, "all-windows-closed");
  }
}

class BuniteSchemeHandler : public CefResourceHandler {
public:
  explicit BuniteSchemeHandler(uint32_t view_id)
    : view_id_(view_id) {}

  bool Open(CefRefPtr<CefRequest> request, bool& handle_request, CefRefPtr<CefCallback> callback) override {
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

    const std::string url = request ? request->GetURL().ToString() : "";
    const std::string normalized_path = normalizeAppResPath(url);

    // Dynamic route: handler lives on the Bun side, request is async
    if (bunite::AppResRouteStorage::instance().hasRoute(normalized_path)) {
      handle_request = false; // async - we'll call callback->Continue() later
      uint32_t request_id;
      {
        std::lock_guard<std::mutex> lock(g_runtime.route_mutex);
        request_id = g_runtime.next_route_request_id++;
        g_runtime.pending_routes[request_id] = { normalized_path, callback, request };
      }
      pending_route_request_id_ = request_id;
      if (g_runtime.webview_event_handler) {
        auto* name = strdup("route-request");
        auto* payload = strdup(
          ("{\"requestId\":" + std::to_string(request_id) + ",\"path\":\"" + normalized_path + "\"}").c_str()
        );
        g_runtime.webview_event_handler(view_id_, name, payload);
      }
      return true;
    }

    std::string mime_type;
    const auto content = loadAppResResource(view_id_, url, mime_type);
    if (!content) {
      const std::string appres_root = getAppResRootForView(view_id_);
      BUNITE_WARN("appres:// resource not found (view=%u, url=%s, normalized=%s, root=%s)",
        view_id_, url.c_str(), normalized_path.c_str(), appres_root.c_str());
      status_code_ = 404;
      status_text_ = "Not Found";
      mime_type_ = "text/plain";
      data_ =
        "bunite could not resolve the requested appres:// resource.\n"
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
    if (pending_route_request_id_ != 0) {
      auto content = bunite::AppResRouteStorage::instance().takeResponse(pending_route_request_id_);
      pending_route_request_id_ = 0;
      if (content) {
        status_code_ = 200;
        status_text_ = "OK";
        mime_type_ = "text/html";
        data_ = std::move(*content);
      } else {
        status_code_ = 500;
        status_text_ = "Handler Error";
        mime_type_ = "text/plain";
        data_ = "Route handler did not produce a response.";
      }
    }
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
  uint32_t pending_route_request_id_ = 0;
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

    // --- Bunite defaults (injected into the flags map so the loop handles them uniformly) ---
    // Run GPU in-process to avoid EGL/D3D11 shared context failures.
    // Override with { "in-process-gpu": false }.
    if (g_runtime.chromium_flags.find("in-process-gpu") == g_runtime.chromium_flags.end()) {
      g_runtime.chromium_flags["in-process-gpu"] = "true";
    }

    // Run network service in-process to avoid subprocess crashes when
    // multiple BrowserViews issue concurrent requests.
    // Override with { "enable-features": false } to suppress, or pass a
    // custom value to replace the default entirely.
    if (g_runtime.chromium_flags.find("enable-features") == g_runtime.chromium_flags.end()) {
      g_runtime.chromium_flags["enable-features"] = "NetworkServiceInProcess";
    } else {
      std::string& existing = g_runtime.chromium_flags["enable-features"];
      if (existing.find("NetworkServiceInProcess") == std::string::npos && existing != "false") {
        if (existing.empty()) {
          existing = "NetworkServiceInProcess";
        } else {
          existing += ",NetworkServiceInProcess";
        }
      }
    }

    // --- Apply all flags ---
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
      "appres",
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
      url.rfind("appres://", 0) != 0
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

    // View was marked for closing while browser was being created async
    if (view_->closing.load()) {
      browser->GetHost()->CloseBrowser(true);
      return;
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

class BuniteDevToolsClient : public CefClient, public CefLifeSpanHandler {
public:
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }

  void OnAfterCreated(CefRefPtr<CefBrowser>) override {
    CEF_REQUIRE_UI_THREAD();
    g_runtime.devtools_browser_count.fetch_add(1);
  }

  void OnBeforeClose(CefRefPtr<CefBrowser>) override {
    CEF_REQUIRE_UI_THREAD();
    g_runtime.devtools_browser_count.fetch_sub(1);
    maybeCompleteShutdownOnUiThread();
  }

private:
  IMPLEMENT_REFCOUNTING(BuniteDevToolsClient);
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
  view->browser->GetHost()->ShowDevTools(window_info, new BuniteDevToolsClient(), settings, CefPoint());
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

LRESULT CALLBACK messageWindowProc(HWND hwnd, UINT message, WPARAM w_param, LPARAM l_param) {
  switch (message) {
    case kRunQueuedTaskMessage:
      executeQueuedUiTasks();
      return 0;

    case kFinalizeShutdownMessage:
      shutdownCefOnUiThread();
      PostQuitMessage(0);
      return 0;
  }

  return DefWindowProcW(hwnd, message, w_param, l_param);
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

    case WM_ERASEBKGND:
      return 1;

    case WM_SIZE:
      if (window) {
        syncWindowFrame(window);

        {
          std::vector<ViewHost*> views_copy;
          {
            std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
            views_copy = window->views;
          }
          for (auto* view : views_copy) {
            resizeViewToFit(view);
          }
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
      if (window && !window->close_pending.exchange(true)) {
        emitWindowEvent(window->id, "close-requested");
      }
      return 0;

    case WM_ENDSESSION:
      if (w_param && window) {
        g_runtime.shutting_down.store(true);
        destroyWindowHost(window);
      }
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
    HINSTANCE module = getCurrentModuleHandle();

    WNDCLASSW window_class{};
    window_class.lpfnWndProc = buniteWindowProc;
    window_class.hInstance = module;
    window_class.lpszClassName = kWindowClass;
    window_class.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    window_class.hbrBackground = nullptr;

    registered = RegisterClassW(&window_class) != 0;
  });

  return registered;
}

bool initializeCefOnUiThread() {
  if (g_runtime.process_helper_path.empty() || g_runtime.cef_dir.empty()) {
    BUNITE_ERROR("Missing process helper or CEF directory.");
    return false;
  }
  if (!registerWindowClasses()) {
    BUNITE_ERROR("Failed to register window classes.");
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

  // Pre-flight: verify critical CEF files exist
  const std::filesystem::path libcef_path = dll_dir / "libcef.dll";
  const std::filesystem::path icudtl_path = resource_dir / "icudtl.dat";
  const std::filesystem::path resources_pak_path = resource_dir / "resources.pak";
  if (!std::filesystem::exists(libcef_path)) {
    BUNITE_ERROR("libcef.dll not found at: %s", libcef_path.string().c_str());
    return false;
  }
  if (!std::filesystem::exists(icudtl_path)) {
    BUNITE_ERROR("icudtl.dat not found at: %s", icudtl_path.string().c_str());
    return false;
  }
  if (!std::filesystem::exists(resources_pak_path)) {
    BUNITE_ERROR("resources.pak not found at: %s", resources_pak_path.string().c_str());
    return false;
  }

  // Pre-flight: check for cache lock from another instance
  const char* user_data_dir = std::getenv("BUNITE_USER_DATA_DIR");
  if (user_data_dir) {
    const std::filesystem::path lock_path = std::filesystem::path(user_data_dir) / "lockfile";
    if (std::filesystem::exists(lock_path)) {
      BUNITE_WARN("Cache directory may be locked by another process: %s", user_data_dir);
    }
  }

  SetDllDirectoryW(dll_dir.native().c_str());

  CefMainArgs main_args(GetModuleHandleW(nullptr));
  CefRefPtr<BuniteCefApp> app = new BuniteCefApp();
  const int execute_result = CefExecuteProcess(main_args, app, nullptr);
  if (execute_result >= 0) {
    BUNITE_ERROR("CefExecuteProcess exited early with code %d.", execute_result);
    return false;
  }

  CefSettings settings{};
  settings.no_sandbox = true;
  settings.multi_threaded_message_loop = true;
  settings.external_message_pump = false;

  CefString(&settings.browser_subprocess_path) = g_runtime.process_helper_path;
  CefString(&settings.resources_dir_path) = resource_dir.wstring();
  CefString(&settings.locales_dir_path) = locales_dir.wstring();
  if (user_data_dir) {
    CefString(&settings.cache_path) = user_data_dir;
  }
  if (const char* remote_debug_port = std::getenv("BUNITE_REMOTE_DEBUGGING_PORT")) {
    const int parsed_port = std::atoi(remote_debug_port);
    if (parsed_port > 0 && parsed_port <= 65535) {
      settings.remote_debugging_port = parsed_port;
    }
  }

  settings.log_severity = LOGSEVERITY_ERROR;
  CefString(&settings.log_file) = "";

  if (!CefInitialize(main_args, settings, app, nullptr)) {
    const int exit_code = CefGetExitCode();
    switch (exit_code) {
      case CEF_RESULT_CODE_NORMAL_EXIT_PROCESS_NOTIFIED:
        BUNITE_ERROR("CefInitialize failed: another instance is using the cache directory (%s).",
                     user_data_dir ? user_data_dir : "<default>");
        break;
      case CEF_RESULT_CODE_PROFILE_IN_USE:
        BUNITE_ERROR("CefInitialize failed: cache profile is in use (%s).",
                     user_data_dir ? user_data_dir : "<default>");
        break;
      case CEF_RESULT_CODE_MISSING_DATA:
        BUNITE_ERROR("CefInitialize failed: critical data files missing (resources_dir=%s).",
                     resource_dir.string().c_str());
        break;
      default:
        BUNITE_ERROR("CefInitialize failed with exit code %d.", exit_code);
        break;
    }
    return false;
  }

  g_runtime.cef_initialized = true;
  CefRegisterSchemeHandlerFactory("appres", "", new BuniteSchemeHandlerFactory());
  return true;
}

void shutdownCefOnUiThread() {
  if (g_runtime.cef_initialized) {
    CefClearSchemeHandlerFactories();
    CefShutdown();
    g_runtime.cef_initialized = false;
  }
}

void cancelPendingPermissionRequestsOnUiThread() {
  std::vector<PendingPermissionRequest> pending;
  {
    std::lock_guard<std::mutex> lock(g_runtime.permission_mutex);
    for (auto& [_, request] : g_runtime.pending_permissions) {
      pending.push_back(request);
    }
    g_runtime.pending_permissions.clear();
  }

  for (const auto& request : pending) {
    if (request.kind == PermissionRequestKind::Prompt && request.prompt_callback) {
      request.prompt_callback->Continue(CEF_PERMISSION_RESULT_DENY);
      continue;
    }
    if (request.kind == PermissionRequestKind::MediaAccess && request.media_callback) {
      request.media_callback->Cancel();
    }
  }
}

void cancelPendingRouteRequestsOnUiThread() {
  std::vector<RuntimeState::PendingRouteRequest> pending;
  {
    std::lock_guard<std::mutex> lock(g_runtime.route_mutex);
    for (auto& [_, request] : g_runtime.pending_routes) {
      pending.push_back(std::move(request));
    }
    g_runtime.pending_routes.clear();
  }

  for (auto& request : pending) {
    if (request.callback) {
      request.callback->Cancel();
    }
  }
}

void maybeCompleteShutdownOnUiThread() {
  if (!g_runtime.shutting_down.load()) {
    return;
  }

  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    if (!g_runtime.views_by_id.empty()) {
      return;
    }
  }

  if (g_runtime.devtools_browser_count.load() > 0) {
    return;
  }

  if (g_runtime.shutdown_finalize_posted.exchange(true)) {
    return;
  }
  if (g_runtime.message_window) {
    PostMessageW(g_runtime.message_window, kFinalizeShutdownMessage, 0, 0);
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
    destroyWindowHost(window);
  }

  for (auto* view : orphan_views) {
    closeViewHost(view);
  }
}

WindowHost* getWindowHostById(uint32_t window_id) {
  std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
  auto it = g_runtime.windows_by_id.find(window_id);
  return it != g_runtime.windows_by_id.end() ? it->second : nullptr;
}

ViewHost* getViewHostById(uint32_t view_id) {
  std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
  auto it = g_runtime.views_by_id.find(view_id);
  return it != g_runtime.views_by_id.end() ? it->second : nullptr;
}

DWORD makeWindowStyle(const std::wstring& title_bar_style) {
  DWORD style = WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN;
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
    ? "appres://internal/index.html"
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
  // CreateBrowser (async) — can be called from any browser process thread.
  // Browser instance will be available in OnAfterCreated callback.
  return CefBrowserHost::CreateBrowser(
    window_info,
    view->client,
    initial_url,
    browser_settings,
    nullptr,
    nullptr
  );
}

void uiThreadMain() {
  g_runtime.ui_thread_id = GetCurrentThreadId();
  OleInitialize(nullptr);

  bool init_success = false;
  if (registerWindowClasses()) {
    g_runtime.message_window = CreateWindowExW(
      0,
      L"STATIC",
      L"",
      0,
      0,
      0,
      0,
      0,
      nullptr,
      nullptr,
      getCurrentModuleHandle(),
      nullptr
    );

    if (g_runtime.message_window) {
      SetWindowLongPtrW(
        g_runtime.message_window,
        GWLP_WNDPROC,
        reinterpret_cast<LONG_PTR>(messageWindowProc)
      );
      init_success = initializeCefOnUiThread();
    } else {
      BUNITE_ERROR("Failed to create message window (err=%lu).", GetLastError());
    }
  } else {
    BUNITE_ERROR("Failed to register window classes.");
  }

  {
    std::lock_guard<std::mutex> lock(g_runtime.lifecycle_mutex);
    g_runtime.init_success = init_success;
    g_runtime.init_finished = true;
    g_runtime.initialized = init_success;
  }
  g_runtime.lifecycle_cv.notify_all();

  if (!init_success) {
    if (g_runtime.message_window) {
      DestroyWindow(g_runtime.message_window);
      g_runtime.message_window = nullptr;
    }
    g_runtime.ui_thread_id = 0;
    {
      std::lock_guard<std::mutex> lock(g_runtime.lifecycle_mutex);
      g_runtime.shutdown_complete = true;
    }
    g_runtime.lifecycle_cv.notify_all();
    return;
  }

  MSG msg{};
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }

  if (g_runtime.message_window) {
    DestroyWindow(g_runtime.message_window);
    g_runtime.message_window = nullptr;
  }

  OleUninitialize();

  g_runtime.ui_thread_id = 0;
  {
    std::lock_guard<std::mutex> lock(g_runtime.lifecycle_mutex);
    g_runtime.initialized = false;
    g_runtime.shutdown_complete = true;
  }
  g_runtime.lifecycle_cv.notify_all();
}

} // namespace

extern "C" BUNITE_EXPORT void bunite_set_log_level(int32_t level) {
  buniteSetLogLevel(static_cast<BuniteLogLevel>(level));
}

extern "C" BUNITE_EXPORT bool bunite_init(
  const char* process_helper_path,
  const char* cef_dir,
  bool hide_console,
  bool popup_blocking,
  const char* chromium_flags_json
) {
  {
    std::lock_guard<std::mutex> lock(g_runtime.lifecycle_mutex);
    if (g_runtime.initialized) {
      return true;
    }
    g_runtime.init_finished = false;
    g_runtime.init_success = false;
    g_runtime.shutdown_complete = false;
    g_runtime.shutdown_finalize_posted.store(false);
    g_runtime.shutting_down.store(false);
    g_runtime.process_helper_path = process_helper_path ? process_helper_path : "";
    g_runtime.cef_dir = cef_dir ? cef_dir : "";
    g_runtime.popup_blocking = popup_blocking;
    g_runtime.chromium_flags = parseChromiumFlagsJson(
      chromium_flags_json ? chromium_flags_json : "");
  }

  if (hide_console) {
    if (HWND console = GetConsoleWindow()) {
      ShowWindow(console, SW_HIDE);
    }
  }

  g_runtime.ui_thread = std::thread(uiThreadMain);

  std::unique_lock<std::mutex> lock(g_runtime.lifecycle_mutex);
  g_runtime.lifecycle_cv.wait(lock, []() { return g_runtime.init_finished; });
  const bool init_success = g_runtime.init_success;
  lock.unlock();

  if (!init_success && g_runtime.ui_thread.joinable()) {
    g_runtime.ui_thread.join();
  }

  return init_success;
}

extern "C" BUNITE_EXPORT void bunite_run_loop(void) {
  // The native UI thread owns the Win32 + CEF loop after bunite_init succeeds.
}

extern "C" BUNITE_EXPORT void bunite_free_cstring(const char* value) {
  std::free(const_cast<char*>(value));
}

extern "C" BUNITE_EXPORT void bunite_quit(void) {
  {
    std::lock_guard<std::mutex> lock(g_runtime.lifecycle_mutex);
    if (!g_runtime.initialized) {
      return;
    }
    if (g_runtime.shutting_down.load()) {
      return;
    }
    g_runtime.shutting_down.store(true);
  }

  // Cancel pending CEF callbacks on CEF thread
  postCefUiTask([]() {
    cancelPendingPermissionRequestsOnUiThread();
    cancelPendingRouteRequestsOnUiThread();
  });

  // Close all windows on Win32 thread (browser closes posted to CEF thread)
  runOnUiThreadSync<void>([]() {
    closeAllWindowsForShutdown();
  });

  // If no views remain, kick shutdown completion
  postCefUiTask([]() {
    maybeCompleteShutdownOnUiThread();
  });

  bool shutdown_completed = false;
  {
    std::unique_lock<std::mutex> lock(g_runtime.lifecycle_mutex);
    shutdown_completed = g_runtime.lifecycle_cv.wait_for(
      lock,
      std::chrono::seconds(5),
      []() { return g_runtime.shutdown_complete; }
    );

    if (!shutdown_completed) {
      BUNITE_WARN("Shutdown timed out, posting finalize.");
      if (g_runtime.message_window) {
        PostMessageW(g_runtime.message_window, kFinalizeShutdownMessage, 0, 0);
      }

      shutdown_completed = g_runtime.lifecycle_cv.wait_for(
        lock,
        std::chrono::milliseconds(500),
        []() { return g_runtime.shutdown_complete; }
      );
    }

    if (!shutdown_completed) {
      BUNITE_WARN("Finalize timed out, forcing message loop exit.");
      if (g_runtime.ui_thread_id != 0) {
        PostThreadMessageW(g_runtime.ui_thread_id, WM_QUIT, 0, 0);
      }

      shutdown_completed = g_runtime.lifecycle_cv.wait_for(
        lock,
        std::chrono::milliseconds(1000),
        []() { return g_runtime.shutdown_complete; }
      );
    }
  }

  if (g_runtime.ui_thread.joinable()) {
    if (shutdown_completed) {
      g_runtime.ui_thread.join();
    } else {
      BUNITE_WARN("UI thread did not exit, detaching.");
      g_runtime.ui_thread.detach();
    }
  }
}

extern "C" BUNITE_EXPORT void bunite_set_webview_event_handler(BuniteWebviewEventHandler handler) {
  std::lock_guard<std::mutex> lock(g_runtime.lifecycle_mutex);
  g_runtime.webview_event_handler = handler;
}

extern "C" BUNITE_EXPORT void bunite_set_window_event_handler(BuniteWindowEventHandler handler) {
  std::lock_guard<std::mutex> lock(g_runtime.lifecycle_mutex);
  g_runtime.window_event_handler = handler;
}

extern "C" BUNITE_EXPORT bool bunite_window_create(
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
  return runOnUiThreadSync<bool>([=]() -> bool {
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
      getCurrentModuleHandle(),
      window
    );

    if (!window->hwnd) {
      delete window;
      return false;
    }

    {
      std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
      g_runtime.windows_by_id[window_id] = window;
    }

    if (!hidden) {
      ShowWindow(window->hwnd, minimized ? SW_SHOWMINIMIZED : (maximized ? SW_SHOWMAXIMIZED : SW_SHOW));
      UpdateWindow(window->hwnd);
    }

    return true;
  });
}

extern "C" BUNITE_EXPORT void bunite_window_destroy(uint32_t window_id) {
  runOnUiThreadSync<void>([window_id]() {
    auto* window = getWindowHostById(window_id);
    destroyWindowHost(window);
  });
}

extern "C" BUNITE_EXPORT void bunite_window_reset_close_pending(uint32_t window_id) {
  runOnUiThreadSync<void>([window_id]() {
    auto* window = getWindowHostById(window_id);
    if (window) {
      window->close_pending.store(false);
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_window_show(uint32_t window_id) {
  runOnUiThreadSync<void>([window_id]() {
    auto* window = getWindowHostById(window_id);
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

extern "C" BUNITE_EXPORT void bunite_window_close(uint32_t window_id) {
  runOnUiThreadSync<void>([window_id]() {
    auto* window = getWindowHostById(window_id);
    if (!window || !window->hwnd) {
      return;
    }
    SendMessageW(window->hwnd, WM_CLOSE, 0, 0);
  });
}

extern "C" BUNITE_EXPORT void bunite_window_set_title(uint32_t window_id, const char* title) {
  runOnUiThreadSync<void>([window_id, value = std::string(title ? title : "")]() {
    auto* window = getWindowHostById(window_id);
    if (!window || !window->hwnd) {
      return;
    }
    window->title = utf8ToWide(value);
    SetWindowTextW(window->hwnd, window->title.c_str());
  });
}

extern "C" BUNITE_EXPORT void bunite_window_minimize(uint32_t window_id) {
  runOnUiThreadSync<void>([window_id]() {
    auto* window = getWindowHostById(window_id);
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

extern "C" BUNITE_EXPORT void bunite_window_unminimize(uint32_t window_id) {
  runOnUiThreadSync<void>([window_id]() {
    auto* window = getWindowHostById(window_id);
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

extern "C" BUNITE_EXPORT bool bunite_window_is_minimized(uint32_t window_id) {
  return runOnUiThreadSync<bool>([window_id]() -> bool {
    auto* window = getWindowHostById(window_id);
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

extern "C" BUNITE_EXPORT void bunite_window_maximize(uint32_t window_id) {
  runOnUiThreadSync<void>([window_id]() {
    auto* window = getWindowHostById(window_id);
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

extern "C" BUNITE_EXPORT void bunite_window_unmaximize(uint32_t window_id) {
  runOnUiThreadSync<void>([window_id]() {
    auto* window = getWindowHostById(window_id);
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

extern "C" BUNITE_EXPORT bool bunite_window_is_maximized(uint32_t window_id) {
  return runOnUiThreadSync<bool>([window_id]() -> bool {
    auto* window = getWindowHostById(window_id);
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
  uint32_t window_id,
  double x,
  double y,
  double width,
  double height
) {
  runOnUiThreadSync<void>([window_id, x, y, width, height]() {
    auto* window = getWindowHostById(window_id);
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

extern "C" BUNITE_EXPORT bool bunite_view_create(
  uint32_t view_id,
  uint32_t window_id,
  const char* url,
  const char* html,
  const char* preload,
  const char* appres_root,
  const char* navigation_rules_json,
  double x,
  double y,
  double width,
  double height,
  bool auto_resize,
  bool sandbox
) {
  return runOnUiThreadSync<bool>([=]() -> bool {
    auto* window = getWindowHostById(window_id);
    if (!window || !window->hwnd) {
      return false;
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
      appres_root ? appres_root : "",
      parseNavigationRulesJson(navigation_rules_json ? navigation_rules_json : ""),
      auto_resize ? ANCHOR_FILL : ANCHOR_NONE,
      0.0,
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
      return false;
    }

    return true;
  });
}

extern "C" BUNITE_EXPORT void bunite_view_load_url(uint32_t view_id, const char* url) {
  postCefUiTask([view_id, next_url = std::string(url ? url : "")]() {
    auto* view = getViewHostById(view_id);
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

extern "C" BUNITE_EXPORT void bunite_view_load_html(uint32_t view_id, const char* html) {
  postCefUiTask([view_id, content = std::string(html ? html : "")]() {
    auto* view = getViewHostById(view_id);
    if (!view) {
      return;
    }

    view->html = content;
    bunite::WebviewContentStorage::instance().set(view->id, content);
    if (view->browser && view->browser->GetMainFrame()) {
      view->browser->GetMainFrame()->LoadURL("appres://internal/index.html");
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_set_visible(uint32_t view_id, bool visible) {
  runOnUiThreadSync<void>([view_id, visible]() {
    auto* view = getViewHostById(view_id);
    if (!view) {
      return;
    }
    auto browser = view->browser;
    if (!browser) {
      return;
    }
    HWND browser_hwnd = browser->GetHost()->GetWindowHandle();
    if (browser_hwnd) {
      ShowWindow(browser_hwnd, visible ? SW_SHOW : SW_HIDE);
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_bring_to_front(uint32_t view_id) {
  runOnUiThreadSync<void>([view_id]() {
    auto* view = getViewHostById(view_id);
    if (!view) {
      return;
    }
    auto browser = view->browser;
    if (!browser) {
      return;
    }
    HWND browser_hwnd = browser->GetHost()->GetWindowHandle();
    if (browser_hwnd) {
      SetWindowPos(browser_hwnd, HWND_TOP, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_set_bounds(
  uint32_t view_id,
  double x,
  double y,
  double width,
  double height
) {
  runOnUiThreadSync<void>([view_id, x, y, width, height]() {
    auto* view = getViewHostById(view_id);
    if (!view) {
      return;
    }
    auto browser = view->browser;
    if (!browser) {
      return;
    }
    view->anchor_mode = ANCHOR_NONE;
    view->bounds = RECT{
      static_cast<LONG>(x),
      static_cast<LONG>(y),
      static_cast<LONG>(x + width),
      static_cast<LONG>(y + height)
    };
    HWND browser_hwnd = browser->GetHost()->GetWindowHandle();
    if (browser_hwnd) {
      SetWindowPos(
        browser_hwnd,
        nullptr,
        view->bounds.left,
        view->bounds.top,
        view->bounds.right - view->bounds.left,
        view->bounds.bottom - view->bounds.top,
        SWP_NOZORDER | SWP_NOACTIVATE
      );
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_register_appres_route(const char* path) {
  bunite::AppResRouteStorage::instance().registerRoute(path ? path : "");
}

extern "C" BUNITE_EXPORT void bunite_unregister_appres_route(const char* path) {
  bunite::AppResRouteStorage::instance().unregisterRoute(path ? path : "");
}

extern "C" BUNITE_EXPORT void bunite_complete_route_request(uint32_t request_id, const char* html) {
  std::lock_guard<std::mutex> lock(g_runtime.route_mutex);
  const auto it = g_runtime.pending_routes.find(request_id);
  if (it == g_runtime.pending_routes.end()) {
    return;
  }

  auto pending = std::move(it->second);
  g_runtime.pending_routes.erase(it);

  bunite::AppResRouteStorage::instance().setResponse(request_id, html ? html : "");

  // Store response data on the scheme handler via the request_id.
  // The scheme handler's GetResponseHeaders/ReadResponse will use it.
  // We signal the callback on the IO thread.
  if (pending.callback) {
    pending.callback->Continue();
  }
}

extern "C" BUNITE_EXPORT void bunite_view_set_anchor(uint32_t view_id, int mode, double inset) {
  runOnUiThreadSync<void>([view_id, mode, inset]() {
    auto* view = getViewHostById(view_id);
    if (!view) {
      return;
    }
    view->anchor_mode = mode;
    view->anchor_inset = inset;
    resizeViewToFit(view);
  });
}

extern "C" BUNITE_EXPORT void bunite_view_go_back(uint32_t view_id) {
  postCefUiTask([view_id]() {
    auto* view = getViewHostById(view_id);
    if (view && view->browser) {
      view->browser->GoBack();
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_reload(uint32_t view_id) {
  postCefUiTask([view_id]() {
    auto* view = getViewHostById(view_id);
    if (view && view->browser) {
      view->browser->Reload();
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_remove(uint32_t view_id) {
  postCefUiTask([view_id]() { closeViewHost(getViewHostById(view_id)); });
}

extern "C" BUNITE_EXPORT void bunite_view_open_devtools(uint32_t view_id) {
  postCefUiTask([view_id]() { openDevToolsForView(getViewHostById(view_id)); });
}

extern "C" BUNITE_EXPORT void bunite_view_close_devtools(uint32_t view_id) {
  postCefUiTask([view_id]() { closeDevToolsForView(getViewHostById(view_id)); });
}

extern "C" BUNITE_EXPORT void bunite_view_toggle_devtools(uint32_t view_id) {
  postCefUiTask([view_id]() { toggleDevToolsForView(getViewHostById(view_id)); });
}

extern "C" BUNITE_EXPORT void bunite_complete_permission_request(uint32_t request_id, uint32_t state) {
  postCefUiTask([=]() {
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
  return runOnCefUiThreadSync<uint32_t>([=]() -> uint32_t {
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
