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

// ---------------------------------------------------------------------------
// Message box utilities
// ---------------------------------------------------------------------------

std::optional<std::pair<uint32_t, int32_t>> parseMessageBoxResponseUrl(const std::string& url) {
  constexpr std::string_view prefix = "appres://app.internal/internal/__bunite/message-box-response";
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
    fetch(`appres://app.internal/internal/__bunite/message-box-response?${params.toString()}`, {
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

// ---------------------------------------------------------------------------
// Chromium flags parsing
// ---------------------------------------------------------------------------

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
