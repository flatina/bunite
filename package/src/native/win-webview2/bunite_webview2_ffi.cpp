#include "webview2_internal.h"

#include <algorithm>
#include <array>
#include <cstring>
#include <memory>
#include <vector>
#include <wincrypt.h>  // CryptBinaryToStringA — base64 encoding for screenshot payload.

using namespace bunite_webview2;

// Forward declaration of helper defined in webview2_runtime.cpp.
namespace bunite_webview2 {
void setViewInputPassthrough(ViewHost* v, bool passthrough);
}

extern "C" {

BUNITE_EXPORT int32_t bunite_abi_version(void) { return 12; }

BUNITE_EXPORT void bunite_set_log_level(int32_t level) {
  if (level < 0) level = 0;
  if (level > 4) level = 4;
  buniteSetLogLevel(static_cast<BuniteLogLevel>(level));
}

BUNITE_EXPORT bool bunite_init(const char* engine_dir, bool hide_console,
                                bool popup_blocking, const char* engine_config_json) {
  return initRuntime(engine_dir, hide_console, popup_blocking, engine_config_json);
}

BUNITE_EXPORT const char* bunite_engine_name(void) { return "webview2"; }

BUNITE_EXPORT const char* bunite_engine_version(void) {
  // Cache only on success — env is created lazily on first view, so early
  // callers (e.g. window-title formatting) would otherwise pin "unknown".
  static std::string cached;
  if (!cached.empty()) return cached.c_str();
  if (!g_runtime.env) return "unknown";
  LPWSTR ver = nullptr;
  if (FAILED(g_runtime.env->get_BrowserVersionString(&ver)) || !ver) {
    if (ver) CoTaskMemFree(ver);
    return "unknown";
  }
  cached = wideToUtf8(ver);
  CoTaskMemFree(ver);
  return cached.c_str();
}

BUNITE_EXPORT void bunite_run_loop(void) {
  // Cooperative engine — TS drives via bunite_pump_once.
}

BUNITE_EXPORT void bunite_pump_once(void) { pumpOnce(); }

BUNITE_EXPORT void bunite_quit(void) { shutdownRuntime(); }

BUNITE_EXPORT void bunite_free_cstring(const char* value) {
  if (value) free(const_cast<char*>(value));
}

BUNITE_EXPORT void bunite_set_webview_event_handler(BuniteWebviewEventHandler h) {
  g_runtime.webview_event_handler = h;
}

BUNITE_EXPORT void bunite_set_window_event_handler(BuniteWindowEventHandler h) {
  g_runtime.window_event_handler = h;
}

// ---- windows ----------------------------------------------------------

BUNITE_EXPORT bool bunite_window_create(
    uint32_t window_id, double x, double y, double w, double h,
    const char* title, const char* title_bar_style,
    bool transparent, bool hidden, bool minimized, bool maximized) {
  return createWindow(window_id, x, y, w, h, title, title_bar_style,
                      transparent, hidden, minimized, maximized);
}

BUNITE_EXPORT void bunite_window_destroy(uint32_t window_id) { destroyWindow(window_id); }

BUNITE_EXPORT void bunite_window_reset_close_pending(uint32_t window_id) {
  WindowHost* w = getWindow(window_id);
  if (w) w->close_pending.store(false);
}

BUNITE_EXPORT void bunite_window_show(uint32_t window_id) {
  WindowHost* w = getWindow(window_id);
  if (w && w->hwnd) ShowWindow(w->hwnd, SW_SHOW);
}

BUNITE_EXPORT void bunite_window_close(uint32_t window_id) {
  // WM_CLOSE (not DestroyWindow) so it routes through the vetoable
  // close-requested path + destroyWindow cleanup (windows_by_id erase +
  // all-windows-closed), matching the CEF backend.
  WindowHost* w = getWindow(window_id);
  if (w && w->hwnd) SendMessageW(w->hwnd, WM_CLOSE, 0, 0);
}

BUNITE_EXPORT void bunite_window_set_title(uint32_t window_id, const char* title) {
  WindowHost* w = getWindow(window_id);
  if (w && w->hwnd && title) SetWindowTextW(w->hwnd, utf8ToWide(title).c_str());
}

BUNITE_EXPORT void bunite_window_minimize(uint32_t window_id) {
  WindowHost* w = getWindow(window_id);
  if (w && w->hwnd) ShowWindow(w->hwnd, SW_MINIMIZE);
}

BUNITE_EXPORT void bunite_window_unminimize(uint32_t window_id) {
  WindowHost* w = getWindow(window_id);
  if (w && w->hwnd) ShowWindow(w->hwnd, SW_RESTORE);
}

BUNITE_EXPORT bool bunite_window_is_minimized(uint32_t window_id) {
  WindowHost* w = getWindow(window_id);
  return w && w->hwnd && IsIconic(w->hwnd);
}

BUNITE_EXPORT void bunite_window_maximize(uint32_t window_id) {
  WindowHost* w = getWindow(window_id);
  if (w && w->hwnd) ShowWindow(w->hwnd, SW_MAXIMIZE);
}

BUNITE_EXPORT void bunite_window_unmaximize(uint32_t window_id) {
  WindowHost* w = getWindow(window_id);
  if (w && w->hwnd) ShowWindow(w->hwnd, SW_RESTORE);
}

BUNITE_EXPORT bool bunite_window_is_maximized(uint32_t window_id) {
  WindowHost* w = getWindow(window_id);
  return w && w->hwnd && IsZoomed(w->hwnd);
}

BUNITE_EXPORT void bunite_window_set_frame(uint32_t window_id,
                                            double x, double y, double w, double h) {
  WindowHost* win = getWindow(window_id);
  if (win && win->hwnd) {
    SetWindowPos(win->hwnd, nullptr,
                 static_cast<int>(x), static_cast<int>(y),
                 static_cast<int>(w), static_cast<int>(h),
                 SWP_NOZORDER | SWP_NOACTIVATE);
  }
}

// Capture-based move-drag — windowProc follows WM_MOUSEMOVE, ends on
// WM_LBUTTONUP/CAPTURECHANGED/CANCELMODE/DESTROY (webview2_runtime.cpp). No
// WM_NCLBUTTONDOWN modal loop: it would freeze the shared Bun/UI thread for
// the whole drag. Trade-off: no Win11 snap/aero-shake.
BUNITE_EXPORT void bunite_window_begin_move_drag(uint32_t window_id) {
  WindowHost* win = getWindow(window_id);
  if (!win || !win->hwnd || win->drag_active) return;
  if (!(GetAsyncKeyState(VK_LBUTTON) & 0x8000)) return;  // button already released
  POINT cur;
  if (!GetCursorPos(&cur)) return;

  if (IsZoomed(win->hwnd)) {  // restore under the cursor before dragging
    RECT maxRect{};
    WINDOWPLACEMENT wp{ sizeof(wp) };
    GetWindowRect(win->hwnd, &maxRect);
    GetWindowPlacement(win->hwnd, &wp);
    const int maxW = maxRect.right - maxRect.left;
    const int restoredW = wp.rcNormalPosition.right - wp.rcNormalPosition.left;
    const double fx = maxW > 0 ? double(cur.x - maxRect.left) / maxW : 0.5;
    ShowWindow(win->hwnd, SW_RESTORE);
    win->maximized = false;
    SetWindowPos(win->hwnd, nullptr, cur.x - static_cast<int>(restoredW * fx),
                 maxRect.top, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    win = getWindow(window_id);  // re-validate: SW_RESTORE dispatched messages
    if (!win || !win->hwnd) return;
  }

  RECT r;
  if (!GetWindowRect(win->hwnd, &r)) return;
  win->drag_anchor_cursor = cur;
  win->drag_anchor_origin = { r.left, r.top };
  win->drag_active = true;
  SetCapture(win->hwnd);
}

// ---- views ------------------------------------------------------------

BUNITE_EXPORT bool bunite_view_create(
    uint32_t view_id, uint32_t window_id,
    const char* url, const char* html,
    const char* preload, const char* appres_root,
    const char* navigation_rules_json,
    double x, double y, double w, double h,
    bool auto_resize, bool sandbox, const char* preload_origins_json) {
  return createView(view_id, window_id, url, html, preload, appres_root,
                    navigation_rules_json, x, y, w, h,
                    auto_resize, sandbox, preload_origins_json);
}

BUNITE_EXPORT void bunite_view_execute_javascript(uint32_t view_id, const char* script) {
  ViewHost* v = getView(view_id);
  if (!v || !v->webview || !script) return;
  v->webview->ExecuteScript(utf8ToWide(script).c_str(), nullptr);
}

BUNITE_EXPORT void bunite_view_evaluate(uint32_t view_id, uint32_t request_id, const char* script) {
  ViewHost* v = getView(view_id);
  if (!v || !v->webview || !script) {
    std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                          ",\"ok\":false,\"code\":\"not_supported\","
                          "\"message\":\"view not ready\"}";
    emitWebviewEvent(view_id, "evaluate-result", payload);
    return;
  }
  // Wrap user script in a JS try/catch envelope: WebView2 ExecuteScript
  // returns "null" when the script throws (HRESULT success), so without this
  // wrapper a thrown error is indistinguishable from a literal `null`. The
  // wrapper surfaces throws as `{__bunite_err: <message>}` for CEF-parity.
  std::string wrapped =
      "(function(){try{return JSON.stringify({__bunite_ok:true,value:("
      + std::string(script) +
      ")})}catch(e){var c=(e&&e.name===\"SecurityError\")?\"cross_origin\":\"runtime_error\";"
      "return JSON.stringify({__bunite_ok:false,code:c,"
      "message:(e&&e.message)?e.message:String(e),"
      "name:(e&&e.name)||\"\"})}})()";

  auto lifetime = g_runtime.lifetime;
  v->webview->ExecuteScript(
      utf8ToWide(wrapped).c_str(),
      Microsoft::WRL::Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
          [lifetime, view_id, request_id](HRESULT hr, LPCWSTR raw) -> HRESULT {
            if (!lifetime || !lifetime->alive.load()) return S_OK;
            std::string payload;
            if (FAILED(hr) || !raw) {
              payload = "{\"requestId\":" + std::to_string(request_id) +
                        ",\"ok\":false,\"code\":\"runtime_error\","
                        "\"message\":\"ExecuteScript failed hr=0x" +
                        [hr]() { char b[16]; snprintf(b, sizeof(b), "%08x", static_cast<unsigned>(hr)); return std::string(b); }() +
                        "\"}";
            } else {
              // `raw` is a JSON-encoded string. After WebView2's outer
              // JSON.stringify, the wrapper's return value (itself a JSON
              // string) arrives as a JSON-quoted JSON string — parse the outer
              // quotes via simple unescape into the inner JSON envelope.
              std::string outer = wideToUtf8(raw);
              // outer looks like: "\"{\\\"__bunite_ok\\\":true,...}\""
              // We need the inner JSON. Walk-and-decode minimally.
              std::string inner;
              if (outer.size() >= 2 && outer.front() == '"' && outer.back() == '"') {
                inner.reserve(outer.size());
                for (size_t i = 1; i + 1 < outer.size(); ++i) {
                  if (outer[i] == '\\' && i + 2 < outer.size()) {
                    char nxt = outer[i + 1];
                    switch (nxt) {
                      case '"': inner += '"'; ++i; break;
                      case '\\': inner += '\\'; ++i; break;
                      case 'n': inner += '\n'; ++i; break;
                      case 'r': inner += '\r'; ++i; break;
                      case 't': inner += '\t'; ++i; break;
                      case '/': inner += '/'; ++i; break;
                      default: inner += outer[i]; break;
                    }
                  } else {
                    inner += outer[i];
                  }
                }
              }
              if (inner.empty()) {
                // Wrapper didn't produce a string — script failure before catch
                // (e.g. parse error). Surface as runtime_error.
                payload = "{\"requestId\":" + std::to_string(request_id) +
                          ",\"ok\":false,\"code\":\"runtime_error\","
                          "\"message\":\"script returned non-string from wrapper\"}";
              } else if (inner.find("\"__bunite_ok\":true") != std::string::npos) {
                // Re-parse to find `value:`. Strip the prefix/suffix manually —
                // the wrapper always emits {"__bunite_ok":true,"value":<JSON>}.
                static const std::string prefix = "{\"__bunite_ok\":true,\"value\":";
                static const std::string suffix = "}";
                std::string value_json = "null";
                if (inner.compare(0, prefix.size(), prefix) == 0 &&
                    inner.size() > prefix.size() + suffix.size()) {
                  value_json = inner.substr(prefix.size(), inner.size() - prefix.size() - 1);
                }
                payload = "{\"requestId\":" + std::to_string(request_id) +
                          ",\"ok\":true,\"value\":\"" + escapeJsonString(value_json) + "\"}";
              } else {
                // __bunite_ok:false branch. Anchor extraction at fixed prefix —
                // user-controlled e.message could otherwise inject a fake "code".
                static const std::string codePrefix = "{\"__bunite_ok\":false,\"code\":\"";
                std::string code = "runtime_error";
                std::string msg = "script threw";
                if (inner.compare(0, codePrefix.size(), codePrefix) == 0) {
                  size_t start = codePrefix.size();
                  size_t end = start;
                  while (end < inner.size() && inner[end] != '"') ++end;
                  if (end > start) code = inner.substr(start, end - start);
                  // message key follows immediately after `","` separator.
                  static const std::string msgKey = "\",\"message\":\"";
                  if (end + msgKey.size() <= inner.size() &&
                      inner.compare(end, msgKey.size(), msgKey) == 0) {
                    size_t mstart = end + msgKey.size();
                    size_t mend = mstart;
                    while (mend < inner.size()) {
                      if (inner[mend] == '"' && (mend == mstart || inner[mend - 1] != '\\')) break;
                      ++mend;
                    }
                    if (mend > mstart) msg = inner.substr(mstart, mend - mstart);
                  }
                }
                payload = "{\"requestId\":" + std::to_string(request_id) +
                          ",\"ok\":false,\"code\":\"" + escapeJsonString(code) + "\","
                          "\"message\":\"" + msg + "\"}";
              }
            }
            emitWebviewEvent(view_id, "evaluate-result", payload);
            return S_OK;
          }).Get());
}

BUNITE_EXPORT void bunite_view_load_url(uint32_t view_id, const char* url) {
  ViewHost* v = getView(view_id);
  if (!v || !url) return;
  if (v->webview) v->webview->Navigate(utf8ToWide(url).c_str());
  else v->url = url;
}

BUNITE_EXPORT void bunite_view_load_html(uint32_t view_id, const char* html) {
  ViewHost* v = getView(view_id);
  if (!v || !html) return;
  if (v->webview) v->webview->NavigateToString(utf8ToWide(html).c_str());
  else v->html = html;
}

BUNITE_EXPORT void bunite_register_appres_route(const char* path) {
  registerAppResRoute(path);
}

BUNITE_EXPORT void bunite_unregister_appres_route(const char* path) {
  unregisterAppResRoute(path);
}

BUNITE_EXPORT void bunite_complete_route_request(uint32_t request_id, const char* html) {
  completeRouteRequest(request_id, html);
}

BUNITE_EXPORT void bunite_view_set_visible(uint32_t view_id, bool visible) {
  ViewHost* v = getView(view_id);
  if (!v) return;
  v->pending_visible = visible;
  if (v->container_hwnd) ShowWindow(v->container_hwnd, visible ? SW_SHOW : SW_HIDE);
  if (v->controller) v->controller->put_IsVisible(visible);
}

BUNITE_EXPORT void bunite_view_set_input_passthrough(uint32_t view_id, bool passthrough) {
  ViewHost* v = getView(view_id);
  if (v) setViewInputPassthrough(v, passthrough);
}

BUNITE_EXPORT void bunite_view_set_mask_region(uint32_t /*view_id*/,
                                                const double* /*rects*/, uint32_t /*count*/) {
  static bool warned = false;
  if (!warned) {
    BUNITE_WARN("webview2: set_mask_region ignored — WebView2 D3D surface cannot be masked. "
                "Use engine \"cef\" + bunite-cef-win-x64 if mask region is required.");
    warned = true;
  }
}

BUNITE_EXPORT void bunite_view_bring_to_front(uint32_t view_id) {
  ViewHost* v = getView(view_id);
  if (!v || !v->container_hwnd) return;
  // Raise our own container HWND. WebView2's internal HWND tree under the
  // container moves with it; we never touch the Edge-owned HWNDs directly.
  SetWindowPos(v->container_hwnd, HWND_TOP, 0, 0, 0, 0,
               SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

static void applyBounds(ViewHost* v, double x, double y, double w, double h) {
  v->bounds = { static_cast<LONG>(x), static_cast<LONG>(y),
                static_cast<LONG>(x + w), static_cast<LONG>(y + h) };
  if (v->container_hwnd) {
    SetWindowPos(v->container_hwnd, nullptr,
                 v->bounds.left, v->bounds.top,
                 v->bounds.right - v->bounds.left,
                 v->bounds.bottom - v->bounds.top,
                 SWP_NOZORDER | SWP_NOACTIVATE);
  }
  if (v->controller) {
    RECT inner{ 0, 0,
                v->bounds.right - v->bounds.left,
                v->bounds.bottom - v->bounds.top };
    v->controller->put_Bounds(inner);
  }
}

BUNITE_EXPORT void bunite_view_set_bounds(uint32_t view_id,
                                           double x, double y, double w, double h) {
  ViewHost* v = getView(view_id);
  if (v) applyBounds(v, x, y, w, h);
}

BUNITE_EXPORT void bunite_view_set_bounds_async(uint32_t view_id,
                                                 double x, double y, double w, double h) {
  postUiTask([view_id, x, y, w, h]() {
    ViewHost* v = getView(view_id);
    if (v) applyBounds(v, x, y, w, h);
  });
}

BUNITE_EXPORT void bunite_view_set_anchor(uint32_t view_id, int mode, double /*inset*/) {
  ViewHost* v = getView(view_id);
  if (!v) return;
  v->auto_resize = (mode == 1);   // ViewAnchorMode::Fill
}

BUNITE_EXPORT void bunite_view_go_back(uint32_t view_id) {
  ViewHost* v = getView(view_id);
  if (v && v->webview) v->webview->GoBack();
}

BUNITE_EXPORT void bunite_view_reload(uint32_t view_id) {
  ViewHost* v = getView(view_id);
  if (v && v->webview) v->webview->Reload();
}

BUNITE_EXPORT void bunite_view_remove(uint32_t view_id) { destroyView(view_id); }

// Input dispatch — CDP via CallDevToolsProtocolMethod (Playwright pattern).
// Edge runtime injects below DevTools surface — DOM `isTrusted=true`
// (see `bunite_view_capabilities` note).
namespace {

const char* cdpMouseButton(int32_t b) {
  switch (b) { case 1: return "middle"; case 2: return "right"; default: return "left"; }
}

void cdpCall(ViewHost* v, const wchar_t* method, const std::string& json) {
  if (!v || !v->webview) return;
  v->webview->CallDevToolsProtocolMethod(
      method, utf8ToWide(json).c_str(), nullptr);
}

// Result-aware CDP call. `cb(ok, json)` runs on the UI thread once the result
// arrives; on failure `ok=false` and json is an error description.
void cdpCallWithResult(ViewHost* v, const wchar_t* method, const std::string& json,
                       std::function<void(bool, std::string)> cb) {
  if (!v || !v->webview) { if (cb) cb(false, "view not ready"); return; }
  auto lifetime = g_runtime.lifetime;
  v->webview->CallDevToolsProtocolMethod(
      method, utf8ToWide(json).c_str(),
      Microsoft::WRL::Callback<ICoreWebView2CallDevToolsProtocolMethodCompletedHandler>(
          [lifetime, cb](HRESULT hr, LPCWSTR result) -> HRESULT {
            if (!lifetime || !lifetime->alive.load()) return S_OK;
            if (FAILED(hr) || !result) { cb(false, "CDP call failed"); return S_OK; }
            cb(true, wideToUtf8(result));
            return S_OK;
          }).Get());
}

}  // namespace

BUNITE_EXPORT void bunite_view_click(uint32_t view_id, double x, double y,
                                      int32_t button, int32_t click_count, uint32_t modifiers) {
  ViewHost* v = getView(view_id);
  if (!v) return;
  if (click_count < 1) click_count = 1;
  // Multi-click → repeated pairs with increasing clickCount so the page sees
  // a dblclick (Playwright convention).
  for (int i = 1; i <= click_count; ++i) {
    std::string base = "\"x\":" + std::to_string(x) + ",\"y\":" + std::to_string(y) +
                       ",\"button\":\"" + cdpMouseButton(button) + "\","
                       "\"clickCount\":" + std::to_string(i) +
                       ",\"modifiers\":" + std::to_string(modifiers);
    cdpCall(v, L"Input.dispatchMouseEvent", "{\"type\":\"mousePressed\"," + base + "}");
    cdpCall(v, L"Input.dispatchMouseEvent", "{\"type\":\"mouseReleased\"," + base + "}");
  }
}

BUNITE_EXPORT void bunite_view_type(uint32_t view_id, const char* text) {
  ViewHost* v = getView(view_id);
  if (!v || !text) return;
  std::string json = "{\"text\":\"" + escapeJsonString(text) + "\"}";
  cdpCall(v, L"Input.insertText", json);
}

BUNITE_EXPORT void bunite_view_press(uint32_t view_id, int32_t windows_vk_code,
                                      int32_t /*mac_key_code*/, const char* key, const char* code,
                                      const char* character, uint32_t modifiers,
                                      int32_t action, bool /*extended*/, int32_t location) {
  ViewHost* v = getView(view_id);
  if (!v) return;
  std::string char_str = character ? character : "";
  std::string key_str = key ? key : "";
  std::string code_str = code ? code : "";

  // CDP modifier mask: 1=alt, 2=ctrl, 4=meta, 8=shift. Suppress text when any
  // non-shift modifier is set so shortcuts like Ctrl+A don't insert "a".
  const bool has_non_shift_modifier = (modifiers & ~static_cast<uint32_t>(8)) != 0;

  auto buildPart = [&](const char* type, bool include_text) {
    std::string out = "{\"type\":\"";
    out += type;
    out += "\",\"modifiers\":" + std::to_string(modifiers);
    if (windows_vk_code != 0) out += ",\"windowsVirtualKeyCode\":" + std::to_string(windows_vk_code);
    if (!key_str.empty())  out += ",\"key\":\""  + escapeJsonString(key_str)  + "\"";
    if (!code_str.empty()) out += ",\"code\":\"" + escapeJsonString(code_str) + "\"";
    // CDP `location`: 0 standard, 1 left mod, 2 right mod, 3 numpad.
    if (location > 0) out += ",\"location\":" + std::to_string(location);
    if (include_text && !char_str.empty() && !has_non_shift_modifier)
      out += ",\"text\":\"" + escapeJsonString(char_str) + "\"";
    out += "}";
    return out;
  };

  // Playwright convention: CHAR `text` rides with keyDown for printable keys.
  if (action != 1) cdpCall(v, L"Input.dispatchKeyEvent", buildPart("keyDown", /*include_text=*/true));
  if (action != 0) cdpCall(v, L"Input.dispatchKeyEvent", buildPart("keyUp",   /*include_text=*/false));
}

}  // extern "C" — temporarily exit so C++ helpers below can return std::string.

namespace {

// Win CryptoAPI base64 — `bytes` → printable string (no line breaks).
std::string base64Encode(const BYTE* bytes, DWORD len) {
  DWORD out_len = 0;
  if (!CryptBinaryToStringA(bytes, len, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &out_len)) return {};
  std::string out(out_len, '\0');
  if (!CryptBinaryToStringA(bytes, len, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, out.data(), &out_len)) return {};
  out.resize(out_len);  // CryptBinaryToString writes including trailing null on some configs; trim.
  while (!out.empty() && out.back() == '\0') out.pop_back();
  return out;
}

void emitScreenshotError(uint32_t view_id, uint32_t request_id, const char* code, const std::string& message) {
  std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                        ",\"ok\":false,\"code\":\"" + code + "\","
                        "\"message\":\"" + escapeJsonString(message) + "\"}";
  emitWebviewEvent(view_id, "screenshot-result", payload);
}

}  // namespace

extern "C" {

BUNITE_EXPORT uint32_t bunite_view_capabilities(uint32_t view_id) {
  // WebView2 — CDP input path. Empirically dispatchMouseEvent /
  // dispatchKeyEvent / insertText produce events with `isTrusted=true` on
  // the page (Edge runtime injects below DevTools surface; differs from
  // browser-process CDP where isTrusted=false).
  ViewHost* v = getView(view_id);
  if (!v) return 0;
  return BUNITE_CAP_EVALUATE | BUNITE_CAP_SURFACE_EVENTS |
         BUNITE_CAP_NATIVE_INPUT_TRUSTED |
         BUNITE_CAP_CLICK | BUNITE_CAP_TYPE | BUNITE_CAP_PRESS | BUNITE_CAP_SCROLL |
         BUNITE_CAP_MOUSE | BUNITE_CAP_DIALOGS | BUNITE_CAP_CONSOLE |
         BUNITE_CAP_SCREENSHOT | BUNITE_CAP_FORMAT_PNG | BUNITE_CAP_FORMAT_JPEG |
         BUNITE_CAP_AX | BUNITE_CAP_BOUNDING_RECT | BUNITE_CAP_FRAMES |
         BUNITE_CAP_DOWNLOADS | BUNITE_CAP_POPUPS |
         BUNITE_CAP_RESOLVE_AND_CLICK;
}

BUNITE_EXPORT void bunite_view_set_download_policy(uint32_t view_id, int32_t policy, const char* download_dir) {
  ViewHost* v = getView(view_id);
  if (!v) return;
  if (policy < 0 || policy > 2) policy = 2;
  v->download_policy.store(policy);
  v->download_dir = download_dir ? download_dir : "";
}

BUNITE_EXPORT void bunite_view_popup_accept(uint32_t new_view_id, uint32_t host_window_id,
                                              double x, double y, double w, double h) {
  ViewHost* v = getView(new_view_id);
  if (!v || !v->controller || !v->container_hwnd) return;
  WindowHost* host_window = nullptr;
  {
    std::lock_guard<std::mutex> g(g_runtime.object_mutex);
    auto wit = g_runtime.windows_by_id.find(host_window_id);
    if (wit == g_runtime.windows_by_id.end()) return;
    host_window = wit->second;
  }
  if (!host_window || !host_window->hwnd) return;
  v->window = host_window;
  host_window->views.push_back(v);
  SetParent(v->container_hwnd, host_window->hwnd);
  MoveWindow(v->container_hwnd, static_cast<int>(x), static_cast<int>(y),
             static_cast<int>(w), static_cast<int>(h), TRUE);
  ShowWindow(v->container_hwnd, SW_SHOW);
  RECT bounds{0, 0, static_cast<LONG>(w), static_cast<LONG>(h)};
  v->controller->put_Bounds(bounds);
  v->controller->put_IsVisible(TRUE);
  emitWebviewEvent(new_view_id, "view-ready", "");
}

BUNITE_EXPORT void bunite_view_popup_dismiss(uint32_t new_view_id) {
  ViewHost* v = nullptr;
  {
    std::lock_guard<std::mutex> g(g_runtime.object_mutex);
    auto it = g_runtime.views_by_id.find(new_view_id);
    if (it == g_runtime.views_by_id.end()) return;
    v = it->second;
    g_runtime.views_by_id.erase(it);
  }
  if (!v) return;
  if (v->controller) v->controller->Close();
  if (v->container_hwnd) DestroyWindow(v->container_hwnd);
  delete v;
}

namespace {
void emitAxError(uint32_t view_id, uint32_t request_id, const char* code, const std::string& message) {
  std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                        ",\"ok\":false,\"code\":\"" + code +
                        "\",\"message\":\"" + escapeJsonString(message) + "\"}";
  emitWebviewEvent(view_id, "accessibility-result", payload);
}
}  // namespace

namespace {
// Extract integer field from a CDP JSON response — used to pluck
// `executionContextId` without pulling in a JSON parser.
bool extractJsonInt(const std::string& json, const std::string& key, int& out) {
  std::string needle = "\"" + key + "\":";
  auto p = json.find(needle);
  if (p == std::string::npos) return false;
  p += needle.size();
  while (p < json.size() && (json[p] == ' ' || json[p] == '\t')) ++p;
  auto end = p;
  while (end < json.size() && (json[end] == '-' || (json[end] >= '0' && json[end] <= '9'))) ++end;
  if (end == p) return false;
  out = std::stoi(json.substr(p, end - p));
  return true;
}
void emitListFramesErrorWv2(uint32_t view_id, uint32_t request_id, const char* code, const std::string& message) {
  std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                        ",\"ok\":false,\"code\":\"" + code +
                        "\",\"message\":\"" + escapeJsonString(message) + "\"}";
  emitWebviewEvent(view_id, "list-frames-result", payload);
}
}  // namespace

BUNITE_EXPORT void bunite_view_list_frames(uint32_t view_id, uint32_t request_id) {
  ViewHost* v = getView(view_id);
  if (!v || !v->webview) { emitListFramesErrorWv2(view_id, request_id, "not_supported", "view not ready"); return; }
  cdpCallWithResult(v, L"Page.getFrameTree", "{}",
      [view_id, request_id](bool ok, std::string result) {
        if (!ok) { emitListFramesErrorWv2(view_id, request_id, "runtime_error", "getFrameTree failed: " + result); return; }
        std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                              ",\"ok\":true,\"raw\":" + result + "}";
        emitWebviewEvent(view_id, "list-frames-result", payload);
      });
}

BUNITE_EXPORT void bunite_view_evaluate_in_frame(uint32_t view_id, uint32_t request_id,
                                                  const char* script_c, const char* frame_id_c) {
  std::string script = script_c ? script_c : "";
  std::string frameId = frame_id_c ? frame_id_c : "";
  if (frameId.empty()) {
    bunite_view_evaluate(view_id, request_id, script_c);
    return;
  }
  ViewHost* v = getView(view_id);
  if (!v || !v->webview) {
    std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                          ",\"ok\":false,\"code\":\"not_supported\",\"message\":\"view not ready\"}";
    emitWebviewEvent(view_id, "evaluate-result", payload);
    return;
  }
  std::string isoParams = "{\"frameId\":\"" + escapeJsonString(frameId) + "\",\"worldName\":\"bunite-eval\"}";
  cdpCallWithResult(v, L"Page.createIsolatedWorld", isoParams,
      [view_id, request_id, script](bool ok, std::string isoResult) {
        if (!ok) {
          std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                                ",\"ok\":false,\"code\":\"runtime_error\","
                                "\"message\":\"createIsolatedWorld failed\"}";
          emitWebviewEvent(view_id, "evaluate-result", payload);
          return;
        }
        int contextId = 0;
        if (!extractJsonInt(isoResult, "executionContextId", contextId)) {
          std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                                ",\"ok\":false,\"code\":\"runtime_error\","
                                "\"message\":\"missing executionContextId\"}";
          emitWebviewEvent(view_id, "evaluate-result", payload);
          return;
        }
        // Re-lookup — the async gap could have torn down the view.
        ViewHost* v2 = getView(view_id);
        if (!v2 || !v2->webview) {
          std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                                ",\"ok\":false,\"code\":\"not_supported\","
                                "\"message\":\"view destroyed\"}";
          emitWebviewEvent(view_id, "evaluate-result", payload);
          return;
        }
        std::string evalParams = "{\"expression\":\"" + escapeJsonString(script) +
                                 "\",\"contextId\":" + std::to_string(contextId) +
                                 ",\"returnByValue\":true,\"awaitPromise\":true}";
        cdpCallWithResult(v2, L"Runtime.evaluate", evalParams,
            [view_id, request_id](bool ok2, std::string evalResult) {
              if (!ok2) {
                std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                                      ",\"ok\":false,\"code\":\"runtime_error\","
                                      "\"message\":\"Runtime.evaluate failed\"}";
                emitWebviewEvent(view_id, "evaluate-result", payload);
                return;
              }
              // Normalize CDP shape to the flat `{requestId, ok, value/code/message}`
              // that the host's evaluate-result handler expects. exceptionDetails
              // at the top level is preceded by `},` — distinguishes from a value
              // that happens to contain the literal token inside a string.
              auto excPos = evalResult.find("},\"exceptionDetails\"");
              if (excPos == std::string::npos) excPos = evalResult.find("}, \"exceptionDetails\"");
              if (excPos != std::string::npos) {
                std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                                      ",\"ok\":false,\"code\":\"runtime_error\","
                                      "\"message\":\"evaluate threw\"}";
                emitWebviewEvent(view_id, "evaluate-result", payload);
                return;
              }
              // Extract result.value as a JSON substring. CDP returns
              // `{"result":{"type":"...","value":<json>}}`. We find the `"value":`
              // token inside the inner object and slice until the matching close.
              auto resPos = evalResult.find("\"result\":");
              if (resPos == std::string::npos) {
                std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                                      ",\"ok\":true,\"value\":\"null\"}";
                emitWebviewEvent(view_id, "evaluate-result", payload);
                return;
              }
              auto valKey = evalResult.find("\"value\":", resPos);
              if (valKey == std::string::npos) {
                // type === "undefined" — no value field.
                std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                                      ",\"ok\":true,\"value\":\"null\"}";
                emitWebviewEvent(view_id, "evaluate-result", payload);
                return;
              }
              size_t start = valKey + 8;  // past `"value":`
              // Skip whitespace.
              while (start < evalResult.size() && (evalResult[start] == ' ' || evalResult[start] == '\t')) ++start;
              // Find balanced end of the JSON value.
              size_t end = start;
              if (start < evalResult.size()) {
                char c = evalResult[start];
                if (c == '"') {
                  ++end;
                  while (end < evalResult.size() && evalResult[end] != '"') {
                    if (evalResult[end] == '\\' && end + 1 < evalResult.size()) ++end;
                    ++end;
                  }
                  if (end < evalResult.size()) ++end;
                } else if (c == '{' || c == '[') {
                  int depth = 0;
                  bool inStr = false;
                  while (end < evalResult.size()) {
                    char ch = evalResult[end];
                    if (inStr) {
                      if (ch == '\\' && end + 1 < evalResult.size()) ++end;
                      else if (ch == '"') inStr = false;
                    } else if (ch == '"') inStr = true;
                    else if (ch == '{' || ch == '[') ++depth;
                    else if (ch == '}' || ch == ']') { --depth; if (depth == 0) { ++end; break; } }
                    ++end;
                  }
                } else {
                  // Number / true / false / null — read until non-token char.
                  while (end < evalResult.size()) {
                    char ch = evalResult[end];
                    if (ch == ',' || ch == '}' || ch == ' ' || ch == '\t' || ch == '\n') break;
                    ++end;
                  }
                }
              }
              std::string valueJson = evalResult.substr(start, end - start);
              std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                                    ",\"ok\":true,\"value\":\"" + escapeJsonString(valueJson) + "\"}";
              emitWebviewEvent(view_id, "evaluate-result", payload);
            });
      });
}

}  // extern "C" — exit so the helpers below can return std::string.

namespace {

void emitResolveAndClickErrorWv2(uint32_t view_id, uint32_t request_id, const char* code, const std::string& message) {
  std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                        ",\"ok\":false,\"code\":\"" + code +
                        "\",\"message\":\"" + escapeJsonString(message) + "\"}";
  emitWebviewEvent(view_id, "resolve-and-click-result", payload);
}

const char* cdpButtonNameWv2(int32_t b) {
  switch (b) { case 1: return "middle"; case 2: return "right"; default: return "left"; }
}

std::string extractJsonValueRaw(const std::string& s, const std::string& key) {
  std::string needle = "\"" + key + "\":";
  size_t p = s.find(needle);
  if (p == std::string::npos) return {};
  p += needle.size();
  while (p < s.size() && (s[p] == ' ' || s[p] == '\t')) ++p;
  if (p >= s.size()) return {};
  size_t end = p;
  char c = s[p];
  if (c == '"') {
    ++end;
    while (end < s.size() && s[end] != '"') { if (s[end] == '\\' && end + 1 < s.size()) ++end; ++end; }
    if (end < s.size()) ++end;
  } else if (c == '{' || c == '[') {
    int depth = 0; bool inStr = false;
    while (end < s.size()) {
      char ch = s[end];
      if (inStr) { if (ch == '\\' && end + 1 < s.size()) ++end; else if (ch == '"') inStr = false; }
      else if (ch == '"') inStr = true;
      else if (ch == '{' || ch == '[') ++depth;
      else if (ch == '}' || ch == ']') { --depth; if (depth == 0) { ++end; break; } }
      ++end;
    }
  } else {
    while (end < s.size()) {
      char ch = s[end];
      if (ch == ',' || ch == '}' || ch == ' ' || ch == '\t' || ch == '\n') break;
      ++end;
    }
  }
  return s.substr(p, end - p);
}

double extractJsonDouble(const std::string& s, const std::string& key, double dflt = 0.0) {
  std::string raw = extractJsonValueRaw(s, key);
  if (raw.empty()) return dflt;
  try { return std::stod(raw); } catch (...) { return dflt; }
}

std::string extractJsonStringDecoded(const std::string& s, const std::string& key) {
  std::string raw = extractJsonValueRaw(s, key);
  if (raw.size() < 2 || raw.front() != '"' || raw.back() != '"') return {};
  std::string out; out.reserve(raw.size());
  for (size_t i = 1; i + 1 < raw.size(); ++i) {
    if (raw[i] == '\\' && i + 1 < raw.size() - 1) {
      char nxt = raw[++i];
      switch (nxt) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case '/': out += '/'; break;
        default: out += nxt; break;
      }
    } else out += raw[i];
  }
  return out;
}

std::string escapeForJsStringWv2(const std::string& s) {
  std::string out; out.reserve(s.size() + 2);
  for (char c : s) {
    if (c == '"' || c == '\\') { out.push_back('\\'); out.push_back(c); }
    else if (c == '\n') out += "\\n";
    else if (c == '\r') out += "\\r";
    else if (c == '\t') out += "\\t";
    else out.push_back(c);
  }
  return out;
}

std::string buildResolveScriptWv2(const std::string& selector) {
  // Frame-local rect + innerWidth/innerHeight for bilinear mapping when the
  // frame is transformed (rotate/scale). Main frame uses iw/ih harmlessly.
  std::string sel_lit = "\"" + escapeForJsStringWv2(selector) + "\"";
  return
    "(function(){"
      "var el=document.querySelector(" + sel_lit + ");"
      "if(!el)return{ok:false,code:\"not_found\"};"
      "el.scrollIntoView({block:\"nearest\",inline:\"nearest\",behavior:\"instant\"});"
      "var r=el.getBoundingClientRect();"
      "var vis=r.width>0&&r.height>0&&r.bottom>0&&r.right>0"
      "&&r.top<innerHeight&&r.left<innerWidth;"
      "if(!vis)return{ok:false,code:\"not_visible\"};"
      "return{ok:true,x:r.x,y:r.y,w:r.width,h:r.height,"
      "cx:r.x+r.width/2,cy:r.y+r.height/2,"
      "iw:innerWidth,ih:innerHeight};"
    "})()";
}

void dispatchCdpClickWv2(ViewHost* v, double cx, double cy,
                          int32_t button, int32_t click_count, uint32_t modifiers) {
  if (click_count < 1) click_count = 1;
  const char* btn = cdpButtonNameWv2(button);
  for (int i = 1; i <= click_count; ++i) {
    std::string base = "\"x\":" + std::to_string(cx) + ",\"y\":" + std::to_string(cy) +
                       ",\"button\":\"" + btn + "\",\"clickCount\":" + std::to_string(i) +
                       ",\"modifiers\":" + std::to_string(modifiers);
    cdpCall(v, L"Input.dispatchMouseEvent", "{\"type\":\"mousePressed\"," + base + "}");
    cdpCall(v, L"Input.dispatchMouseEvent", "{\"type\":\"mouseReleased\"," + base + "}");
  }
}

// CDP call routed to a child target session (flatten:true). Requires
// ICoreWebView2_11.
void cdpCallForSession(ViewHost* v, const std::string& session_id, const wchar_t* method,
                        const std::string& params_json,
                        std::function<void(bool, std::string)> cb) {
  if (!v || !v->webview) { if (cb) cb(false, "view not ready"); return; }
  ComPtr<ICoreWebView2_11> wv11;
  if (FAILED(v->webview.As(&wv11)) || !wv11) { if (cb) cb(false, "ICoreWebView2_11 unavailable"); return; }
  auto lifetime = g_runtime.lifetime;
  wv11->CallDevToolsProtocolMethodForSession(
      utf8ToWide(session_id).c_str(), method, utf8ToWide(params_json).c_str(),
      Microsoft::WRL::Callback<ICoreWebView2CallDevToolsProtocolMethodCompletedHandler>(
          [lifetime, cb](HRESULT hr, LPCWSTR result) -> HRESULT {
            if (!lifetime || !lifetime->alive.load()) return S_OK;
            if (FAILED(hr) || !result) { cb(false, "CDP-for-session call failed"); return S_OK; }
            cb(true, wideToUtf8(result));
            return S_OK;
          }).Get());
}

// Register one-time listeners for Target.attachedToTarget / detachedFromTarget.
// Populates view->oopif_sessions as OOPIF child sessions attach.
void armOopifEvents(ViewHost* v) {
  if (v->oopif_event_tokens_registered) return;
  using namespace Microsoft::WRL;
  ComPtr<ICoreWebView2DevToolsProtocolEventReceiver> attached_r, detached_r;
  if (FAILED(v->webview->GetDevToolsProtocolEventReceiver(L"Target.attachedToTarget", &attached_r))
   || FAILED(v->webview->GetDevToolsProtocolEventReceiver(L"Target.detachedFromTarget", &detached_r))) {
    return;
  }
  uint32_t view_id = v->id;
  attached_r->add_DevToolsProtocolEventReceived(
      Callback<ICoreWebView2DevToolsProtocolEventReceivedEventHandler>(
          [view_id](ICoreWebView2*, ICoreWebView2DevToolsProtocolEventReceivedEventArgs* args) -> HRESULT {
            LPWSTR raw = nullptr;
            if (FAILED(args->get_ParameterObjectAsJson(&raw)) || !raw) return S_OK;
            std::string p = wideToUtf8(raw); CoTaskMemFree(raw);
            std::string session_id = extractJsonStringDecoded(p, "sessionId");
            std::string info = extractJsonValueRaw(p, "targetInfo");
            std::string type = extractJsonStringDecoded(info, "type");
            std::string target_id = extractJsonStringDecoded(info, "targetId");
            if (session_id.empty() || target_id.empty() || type != "iframe") return S_OK;
            auto* v = getView(view_id);
            if (!v) return S_OK;
            std::lock_guard<std::mutex> lk(v->oopif_sessions_mutex);
            v->oopif_sessions[target_id] = session_id;
            return S_OK;
          }).Get(),
      &v->target_attached_token);
  detached_r->add_DevToolsProtocolEventReceived(
      Callback<ICoreWebView2DevToolsProtocolEventReceivedEventHandler>(
          [view_id](ICoreWebView2*, ICoreWebView2DevToolsProtocolEventReceivedEventArgs* args) -> HRESULT {
            LPWSTR raw = nullptr;
            if (FAILED(args->get_ParameterObjectAsJson(&raw)) || !raw) return S_OK;
            std::string p = wideToUtf8(raw); CoTaskMemFree(raw);
            std::string session_id = extractJsonStringDecoded(p, "sessionId");
            if (session_id.empty()) return S_OK;
            auto* v = getView(view_id);
            if (!v) return S_OK;
            std::lock_guard<std::mutex> lk(v->oopif_sessions_mutex);
            for (auto it = v->oopif_sessions.begin(); it != v->oopif_sessions.end(); ) {
              if (it->second == session_id) it = v->oopif_sessions.erase(it);
              else ++it;
            }
            return S_OK;
          }).Get(),
      &v->target_detached_token);
  v->oopif_event_tokens_registered = true;
}

void finishResolveAndClickWv2(uint32_t view_id, uint32_t request_id, double x, double y,
                               double w, double h, double cx, double cy,
                               int32_t button, int32_t click_count, uint32_t modifiers) {
  ViewHost* v = getView(view_id);
  if (!v || !v->webview) { emitResolveAndClickErrorWv2(view_id, request_id, "runtime_error", "view destroyed"); return; }
  dispatchCdpClickWv2(v, cx, cy, button, click_count, modifiers);
  // Edge runtime CDP → DOM trust=true (empirical; matches existing click cap).
  std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                        ",\"ok\":true,\"rect\":{\"x\":" + std::to_string(x) +
                        ",\"y\":" + std::to_string(y) +
                        ",\"width\":" + std::to_string(w) +
                        ",\"height\":" + std::to_string(h) + "},"
                        "\"isTrustedEvent\":true}";
  emitWebviewEvent(view_id, "resolve-and-click-result", payload);
}

struct FrameResolveOkWv2 { double x, y, w, h, cx, cy, iw, ih; };

// Parse a Runtime.evaluate response (regardless of session); on success forwards
// frame-local fields to `onOk`. Script's failure branch routes through error emit.
void parseEvalAndContinueWv2(uint32_t view_id, uint32_t request_id, bool ok, const std::string& evalResult,
                              std::function<void(const FrameResolveOkWv2&)> onOk) {
  if (!ok) {
    BUNITE_INFO("webview2/eval: Runtime.evaluate failed view=%u request=%u body=%.300s%s",
                view_id, request_id, evalResult.c_str(),
                evalResult.size() > 300 ? "..." : "");
    emitResolveAndClickErrorWv2(view_id, request_id, "runtime_error", "Runtime.evaluate failed"); return;
  }
  if (evalResult.find("\"exceptionDetails\"") != std::string::npos) {
    emitResolveAndClickErrorWv2(view_id, request_id, "runtime_error", "evaluate threw"); return;
  }
  std::string value = extractJsonValueRaw(evalResult, "value");
  if (value.empty()) { emitResolveAndClickErrorWv2(view_id, request_id, "runtime_error", "evaluate returned no value"); return; }
  std::string okRaw = extractJsonValueRaw(value, "ok");
  if (okRaw != "true") {
    std::string code = extractJsonStringDecoded(value, "code");
    if (code.empty()) code = "runtime_error";
    emitResolveAndClickErrorWv2(view_id, request_id, code.c_str(), "");
    return;
  }
  onOk(FrameResolveOkWv2{
      extractJsonDouble(value, "x"), extractJsonDouble(value, "y"),
      extractJsonDouble(value, "w"), extractJsonDouble(value, "h"),
      extractJsonDouble(value, "cx"), extractJsonDouble(value, "cy"),
      extractJsonDouble(value, "iw"), extractJsonDouble(value, "ih"),
  });
}

void evalInFrameWv2(uint32_t view_id, uint32_t request_id, const std::string& frameId,
                     const std::string& script,
                     std::function<void(const FrameResolveOkWv2&)> onOk) {
  ViewHost* v = getView(view_id);
  if (!v || !v->webview) { emitResolveAndClickErrorWv2(view_id, request_id, "runtime_error", "view destroyed"); return; }
  std::string session_id;
  {
    std::lock_guard<std::mutex> lk(v->oopif_sessions_mutex);
    auto it = v->oopif_sessions.find(frameId);
    if (it != v->oopif_sessions.end()) session_id = it->second;
  }
  if (!session_id.empty()) {
    std::string evalParams = "{\"expression\":\"" + escapeJsonString(script) +
                             "\",\"returnByValue\":true,\"awaitPromise\":true}";
    cdpCallForSession(v, session_id, L"Runtime.evaluate", evalParams,
        [view_id, request_id, onOk](bool ok, std::string r) {
          parseEvalAndContinueWv2(view_id, request_id, ok, r, onOk);
        });
    return;
  }
  // In-process: createIsolatedWorld + Runtime.evaluate via main session.
  std::string isoParams = "{\"frameId\":\"" + escapeJsonString(frameId) + "\",\"worldName\":\"bunite-rac\"}";
  cdpCallWithResult(v, L"Page.createIsolatedWorld", isoParams,
      [view_id, request_id, script, onOk](bool ok, std::string isoResult) {
        if (!ok) { emitResolveAndClickErrorWv2(view_id, request_id, "runtime_error", "createIsolatedWorld failed"); return; }
        int contextId = 0;
        if (!extractJsonInt(isoResult, "executionContextId", contextId)) {
          emitResolveAndClickErrorWv2(view_id, request_id, "runtime_error", "missing executionContextId"); return;
        }
        ViewHost* v2 = getView(view_id);
        if (!v2 || !v2->webview) { emitResolveAndClickErrorWv2(view_id, request_id, "runtime_error", "view destroyed"); return; }
        std::string evalParams = "{\"expression\":\"" + escapeJsonString(script) +
                                 "\",\"contextId\":" + std::to_string(contextId) +
                                 ",\"returnByValue\":true,\"awaitPromise\":true}";
        cdpCallWithResult(v2, L"Runtime.evaluate", evalParams,
            [view_id, request_id, onOk](bool ok2, std::string r) {
              parseEvalAndContinueWv2(view_id, request_id, ok2, r, onOk);
            });
      });
}

inline void bilinearMapWv2(const std::array<double, 8>& q, double iw, double ih,
                            double fx, double fy, double& px, double& py) {
  const double u = (iw > 0) ? (fx / iw) : 0.0;
  const double v = (ih > 0) ? (fy / ih) : 0.0;
  px = (1-u)*(1-v)*q[0] + u*(1-v)*q[2] + u*v*q[4] + (1-u)*v*q[6];
  py = (1-u)*(1-v)*q[1] + u*(1-v)*q[3] + u*v*q[5] + (1-u)*v*q[7];
}

// Recursive frame path lookup in Page.getFrameTree response (text-based parser).
// Returns [main_frame_id, ..., target_frame_id]; empty if target not found.
std::vector<std::string> findFramePathWv2(const std::string& node, const std::string& target) {
  std::string frame = extractJsonValueRaw(node, "frame");
  std::string this_id = extractJsonStringDecoded(frame, "id");
  if (this_id.empty()) return {};
  if (this_id == target) return {this_id};
  std::string children = extractJsonValueRaw(node, "childFrames");
  if (children.size() < 2 || children.front() != '[') return {};
  // Walk child array — each element is a JSON object {frame, childFrames?}.
  size_t pos = 1;
  while (pos < children.size() && children[pos] != ']') {
    while (pos < children.size() && (children[pos] == ' ' || children[pos] == ',')) ++pos;
    if (pos >= children.size() || children[pos] != '{') break;
    int depth = 0;
    size_t end = pos;
    bool inStr = false;
    while (end < children.size()) {
      char ch = children[end];
      if (inStr) { if (ch == '\\' && end + 1 < children.size()) ++end; else if (ch == '"') inStr = false; }
      else if (ch == '"') inStr = true;
      else if (ch == '{') ++depth;
      else if (ch == '}') { --depth; if (depth == 0) { ++end; break; } }
      ++end;
    }
    auto sub = findFramePathWv2(children.substr(pos, end - pos), target);
    if (!sub.empty()) { sub.insert(sub.begin(), this_id); return sub; }
    pos = end;
  }
  return {};
}

bool parseQuad8(const std::string& content, std::array<double, 8>& out) {
  if (content.size() < 2 || content.front() != '[' || content.back() != ']') return false;
  size_t pos = 1;
  for (int i = 0; i < 8; ++i) {
    while (pos < content.size() && (content[pos] == ' ' || content[pos] == ',')) ++pos;
    size_t end = pos;
    while (end < content.size() && content[end] != ',' && content[end] != ']') ++end;
    if (end == pos) return false;
    try { out[i] = std::stod(content.substr(pos, end - pos)); } catch (...) { return false; }
    pos = end;
  }
  return true;
}

// Issue CDP on a specific OOPIF session, or main session if `session_id` empty.
void cdpForChain(ViewHost* v, const std::string& session_id, const wchar_t* method,
                  const std::string& params_json,
                  std::function<void(bool, std::string)> cb) {
  if (session_id.empty()) cdpCallWithResult(v, method, params_json, std::move(cb));
  else cdpCallForSession(v, session_id, method, params_json, std::move(cb));
}

struct ChainStateWv2 {
  uint32_t view_id;
  uint32_t request_id;
  std::string targetFrameId;
  std::string script;
  int32_t button, click_count;
  uint32_t modifiers;
  std::vector<std::string> chain;             // [main, ..., target]
  std::vector<std::array<double, 8>> link_quads;
  std::vector<std::pair<double, double>> ancestor_inner;  // chain[1..N-2]'s iw/ih
};

void composeAndDispatchWv2(std::shared_ptr<ChainStateWv2> s, const FrameResolveOkWv2& fr);
void fetchTargetEvalWv2(std::shared_ptr<ChainStateWv2> s);
void fetchAncestorInnerWv2(std::shared_ptr<ChainStateWv2> s, size_t i);
void fetchLinkWv2(std::shared_ptr<ChainStateWv2> s, size_t link_idx);

std::string sessionForChainIdxWv2(uint32_t view_id, const std::vector<std::string>& chain, size_t idx) {
  if (idx == 0) return {};
  ViewHost* v = getView(view_id);
  if (!v) return {};
  std::lock_guard<std::mutex> lk(v->oopif_sessions_mutex);
  auto it = v->oopif_sessions.find(chain[idx]);
  return (it != v->oopif_sessions.end()) ? it->second : std::string{};
}

void fetchLinkWv2(std::shared_ptr<ChainStateWv2> s, size_t link_idx) {
  if (link_idx + 1 >= s->chain.size()) { fetchAncestorInnerWv2(s, 1); return; }
  const std::string parent_session = sessionForChainIdxWv2(s->view_id, s->chain, link_idx);
  const std::string& child_frameId = s->chain[link_idx + 1];
  ViewHost* v = getView(s->view_id);
  if (!v) { emitResolveAndClickErrorWv2(s->view_id, s->request_id, "runtime_error", "view destroyed"); return; }
  std::string ownerParams = "{\"frameId\":\"" + escapeJsonString(child_frameId) + "\"}";
  cdpForChain(v, parent_session, L"DOM.getFrameOwner", ownerParams,
      [s, link_idx, parent_session](bool ok, std::string r) {
        if (!ok) { emitResolveAndClickErrorWv2(s->view_id, s->request_id, "not_found", "getFrameOwner failed"); return; }
        int backendNodeId = 0;
        if (!extractJsonInt(r, "backendNodeId", backendNodeId) || !backendNodeId) {
          emitResolveAndClickErrorWv2(s->view_id, s->request_id, "not_found", "no backendNodeId"); return;
        }
        ViewHost* v2 = getView(s->view_id);
        if (!v2) { emitResolveAndClickErrorWv2(s->view_id, s->request_id, "runtime_error", "view destroyed"); return; }
        std::string boxParams = "{\"backendNodeId\":" + std::to_string(backendNodeId) + "}";
        cdpForChain(v2, parent_session, L"DOM.getBoxModel", boxParams,
            [s, link_idx](bool ok2, std::string rb) {
              if (!ok2) { emitResolveAndClickErrorWv2(s->view_id, s->request_id, "not_visible", "iframe has no box"); return; }
              std::string model = extractJsonValueRaw(rb, "model");
              std::string content = extractJsonValueRaw(model, "content");
              std::array<double, 8> quad{};
              if (!parseQuad8(content, quad)) { emitResolveAndClickErrorWv2(s->view_id, s->request_id, "runtime_error", "bad quad"); return; }
              s->link_quads.push_back(quad);
              fetchLinkWv2(s, link_idx + 1);
            });
      });
}

void fetchAncestorInnerWv2(std::shared_ptr<ChainStateWv2> s, size_t i) {
  if (i + 1 >= s->chain.size()) { fetchTargetEvalWv2(s); return; }
  const std::string sid = sessionForChainIdxWv2(s->view_id, s->chain, i);
  ViewHost* v = getView(s->view_id);
  if (!v) { emitResolveAndClickErrorWv2(s->view_id, s->request_id, "runtime_error", "view destroyed"); return; }
  std::string params = "{\"expression\":\"JSON.stringify({iw:innerWidth,ih:innerHeight})\",\"returnByValue\":true,\"awaitPromise\":true}";
  cdpForChain(v, sid, L"Runtime.evaluate", params,
      [s, i](bool ok, std::string r) {
        if (!ok) { emitResolveAndClickErrorWv2(s->view_id, s->request_id, "runtime_error", "ancestor eval failed"); return; }
        // Result: {"result":{"type":"string","value":"<json>"}}
        std::string value = extractJsonValueRaw(r, "value");
        if (value.size() < 2) { emitResolveAndClickErrorWv2(s->view_id, s->request_id, "runtime_error", "ancestor eval no value"); return; }
        // value is a JSON string literal — extractJsonValueRaw returns it with quotes; decode.
        std::string inner;
        for (size_t p = 1; p + 1 < value.size(); ++p) {
          if (value[p] == '\\' && p + 2 < value.size()) {
            char nxt = value[++p];
            switch (nxt) { case '"': inner += '"'; break; case '\\': inner += '\\'; break;
                            case 'n': inner += '\n'; break; default: inner += nxt; }
          } else inner += value[p];
        }
        double iw = extractJsonDouble(inner, "iw"), ih = extractJsonDouble(inner, "ih");
        s->ancestor_inner.push_back({iw, ih});
        fetchAncestorInnerWv2(s, i + 1);
      });
}

void fetchTargetEvalWv2(std::shared_ptr<ChainStateWv2> s) {
  evalInFrameWv2(s->view_id, s->request_id, s->targetFrameId, s->script,
      [s](const FrameResolveOkWv2& fr) { composeAndDispatchWv2(s, fr); });
}

void composeAndDispatchWv2(std::shared_ptr<ChainStateWv2> s, const FrameResolveOkWv2& fr) {
  auto mapCorner = [&](double fx, double fy, double& px, double& py) {
    double cur_x = fx, cur_y = fy;
    double cur_iw = fr.iw, cur_ih = fr.ih;
    for (size_t i = s->link_quads.size(); i-- > 0; ) {
      double mx, my;
      bilinearMapWv2(s->link_quads[i], cur_iw, cur_ih, cur_x, cur_y, mx, my);
      cur_x = mx; cur_y = my;
      if (i == 0) break;
      cur_iw = s->ancestor_inner[i - 1].first;
      cur_ih = s->ancestor_inner[i - 1].second;
    }
    px = cur_x; py = cur_y;
  };
  double pcx, pcy; mapCorner(fr.cx, fr.cy, pcx, pcy);
  double cx0, cy0, cx1, cy1, cx2, cy2, cx3, cy3;
  mapCorner(fr.x,             fr.y,             cx0, cy0);
  mapCorner(fr.x + fr.w,      fr.y,             cx1, cy1);
  mapCorner(fr.x + fr.w,      fr.y + fr.h,      cx2, cy2);
  mapCorner(fr.x,             fr.y + fr.h,      cx3, cy3);
  const double min_x = std::min(std::min(cx0, cx1), std::min(cx2, cx3));
  const double max_x = std::max(std::max(cx0, cx1), std::max(cx2, cx3));
  const double min_y = std::min(std::min(cy0, cy1), std::min(cy2, cy3));
  const double max_y = std::max(std::max(cy0, cy1), std::max(cy2, cy3));
  finishResolveAndClickWv2(s->view_id, s->request_id,
      min_x, min_y, max_x - min_x, max_y - min_y, pcx, pcy,
      s->button, s->click_count, s->modifiers);
}

// Walk ancestor chain via Page.getFrameTree, compose bilinear transforms across
// nested OOPIF/same-origin frames, dispatch click in main-page coords.
void runFrameTargetedWv2(uint32_t view_id, uint32_t request_id, const std::string& frameId,
                          const std::string& script,
                          int32_t button, int32_t click_count, uint32_t modifiers) {
  ViewHost* v = getView(view_id);
  if (!v || !v->webview) { emitResolveAndClickErrorWv2(view_id, request_id, "runtime_error", "view destroyed"); return; }
  cdpCallWithResult(v, L"Page.getFrameTree", "{}",
      [view_id, request_id, frameId, script, button, click_count, modifiers](bool ok, std::string r) {
        if (!ok) { emitResolveAndClickErrorWv2(view_id, request_id, "runtime_error", "getFrameTree failed"); return; }
        std::string root = extractJsonValueRaw(r, "frameTree");
        std::vector<std::string> chain = findFramePathWv2(root, frameId);
        if (chain.size() < 2) { emitResolveAndClickErrorWv2(view_id, request_id, "not_found", "frame not in tree"); return; }
        auto s = std::make_shared<ChainStateWv2>();
        s->view_id = view_id; s->request_id = request_id;
        s->targetFrameId = frameId; s->script = script;
        s->button = button; s->click_count = click_count; s->modifiers = modifiers;
        s->chain = std::move(chain);
        fetchLinkWv2(s, 0);
      });
}
}  // namespace

extern "C" {

BUNITE_EXPORT void bunite_view_resolve_and_click(
    uint32_t view_id, uint32_t request_id,
    const char* selector_c, const char* frame_id_c,
    int32_t button, int32_t click_count, uint32_t modifiers) {
  ViewHost* v = getView(view_id);
  if (!v || !v->webview) { emitResolveAndClickErrorWv2(view_id, request_id, "runtime_error", "view not ready"); return; }
  std::string selector = selector_c ? selector_c : "";
  std::string frameId = frame_id_c ? frame_id_c : "";
  std::string script = buildResolveScriptWv2(selector);

  if (frameId.empty()) {
    std::string evalParams = "{\"expression\":\"" + escapeJsonString(script) + "\",\"returnByValue\":true,\"awaitPromise\":true}";
    cdpCallWithResult(v, L"Runtime.evaluate", evalParams,
        [view_id, request_id, button, click_count, modifiers](bool ok, std::string r) {
          parseEvalAndContinueWv2(view_id, request_id, ok, r,
              [view_id, request_id, button, click_count, modifiers](const FrameResolveOkWv2& fr) {
                finishResolveAndClickWv2(view_id, request_id,
                                          fr.x, fr.y, fr.w, fr.h, fr.cx, fr.cy,
                                          button, click_count, modifiers);
              });
        });
    return;
  }

  // Frame-targeted: lazy event subscription + setAutoAttach so OOPIF child
  // sessions populate v->oopif_sessions before frame eval routes.
  armOopifEvents(v);
  if (!v->oopif_autoattach_armed.exchange(true)) {
    cdpCallWithResult(v, L"Target.setAutoAttach",
        "{\"autoAttach\":true,\"flatten\":true,\"waitForDebuggerOnStart\":false}",
        [view_id, request_id, frameId, script, button, click_count, modifiers](bool ok, std::string) {
          if (!ok) { emitResolveAndClickErrorWv2(view_id, request_id, "runtime_error", "setAutoAttach failed"); return; }
          runFrameTargetedWv2(view_id, request_id, frameId, script, button, click_count, modifiers);
        });
    return;
  }
  runFrameTargetedWv2(view_id, request_id, frameId, script, button, click_count, modifiers);
}

BUNITE_EXPORT void bunite_view_accessibility_snapshot(uint32_t view_id, uint32_t request_id,
                                                       int32_t /*interesting_only*/) {
  // CDP getFullAXTree accepts only depth/frameId — interesting-only filter is TS-side.
  ViewHost* v = getView(view_id);
  if (!v || !v->webview) { emitAxError(view_id, request_id, "not_supported", "view not ready"); return; }
  cdpCallWithResult(v, L"Accessibility.getFullAXTree", "{}",
      [view_id, request_id](bool ok, std::string result) {
        if (!ok) { emitAxError(view_id, request_id, "runtime_error", "getFullAXTree failed: " + result); return; }
        std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                              ",\"ok\":true,\"tree\":" + result + "}";
        emitWebviewEvent(view_id, "accessibility-result", payload);
      });
}

BUNITE_EXPORT void bunite_view_screenshot(uint32_t view_id, uint32_t request_id,
                                            const char* format, int32_t /*quality*/) {
  ViewHost* v = getView(view_id);
  if (!v || !v->webview) {
    emitScreenshotError(view_id, request_id, "not_supported", "view not ready");
    return;
  }
  std::string fmt = format ? format : "png";
  COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT cwv_fmt;
  std::string mime;
  if (fmt == "jpeg" || fmt == "jpg") {
    cwv_fmt = COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG;
    fmt = "jpeg"; mime = "image/jpeg";
  } else {
    cwv_fmt = COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    fmt = "png"; mime = "image/png";
  }
  ComPtr<IStream> stream;
  HRESULT hr = CreateStreamOnHGlobal(nullptr, TRUE, &stream);
  if (FAILED(hr) || !stream) {
    emitScreenshotError(view_id, request_id, "runtime_error", "CreateStreamOnHGlobal failed");
    return;
  }
  auto lifetime = g_runtime.lifetime;
  v->webview->CapturePreview(
      cwv_fmt, stream.Get(),
      Microsoft::WRL::Callback<ICoreWebView2CapturePreviewCompletedHandler>(
          [lifetime, view_id, request_id, fmt, mime, stream](HRESULT hr2) -> HRESULT {
            if (!lifetime || !lifetime->alive.load()) return S_OK;
            if (FAILED(hr2)) {
              emitScreenshotError(view_id, request_id, "runtime_error", "CapturePreview failed");
              return S_OK;
            }
            HGLOBAL hg = nullptr;
            if (FAILED(GetHGlobalFromStream(stream.Get(), &hg)) || !hg) {
              emitScreenshotError(view_id, request_id, "runtime_error", "GetHGlobalFromStream failed");
              return S_OK;
            }
            const SIZE_T size = GlobalSize(hg);
            void* ptr = GlobalLock(hg);
            std::string b64 = ptr ? base64Encode(static_cast<const BYTE*>(ptr), static_cast<DWORD>(size)) : std::string{};
            if (ptr) GlobalUnlock(hg);
            if (b64.empty()) {
              emitScreenshotError(view_id, request_id, "runtime_error", "base64 encode failed");
              return S_OK;
            }
            std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                                  ",\"ok\":true,\"format\":\"" + fmt +
                                  "\",\"mime\":\"" + mime +
                                  "\",\"dataBase64\":\"" + b64 + "\"}";
            emitWebviewEvent(view_id, "screenshot-result", payload);
            return S_OK;
          }).Get());
}

BUNITE_EXPORT void bunite_view_scroll(uint32_t view_id, double dx, double dy,
                                       double x, double y, uint32_t modifiers) {
  ViewHost* v = getView(view_id);
  if (!v) return;
  std::string json = "{\"type\":\"mouseWheel\",\"x\":" + std::to_string(x) +
                     ",\"y\":" + std::to_string(y) +
                     ",\"deltaX\":" + std::to_string(dx) +
                     ",\"deltaY\":" + std::to_string(dy) +
                     ",\"modifiers\":" + std::to_string(modifiers) + "}";
  cdpCall(v, L"Input.dispatchMouseEvent", json);
}

BUNITE_EXPORT void bunite_view_mouse(uint32_t view_id, int32_t action,
                                      double x, double y, int32_t button,
                                      uint32_t modifiers) {
  ViewHost* v = getView(view_id);
  if (!v) return;
  // CDP mouseMoved / mousePressed / mouseReleased. WV2 produces isTrusted=true
  // on the page for these (Edge runtime injects below DevTools surface).
  const char* type = (action == 0) ? "mouseMoved"
                   : (action == 1) ? "mousePressed" : "mouseReleased";
  std::string json = "{\"type\":\"" + std::string(type) +
                     "\",\"x\":" + std::to_string(x) +
                     ",\"y\":" + std::to_string(y) +
                     ",\"modifiers\":" + std::to_string(modifiers);
  if (action != 0) {
    const char* btn = (button == 2) ? "right" : (button == 1) ? "middle" : "left";
    json += ",\"button\":\"" + std::string(btn) + "\",\"clickCount\":1";
  }
  json += "}";
  cdpCall(v, L"Input.dispatchMouseEvent", json);
}

BUNITE_EXPORT void bunite_view_respond_dialog(uint32_t view_id, uint32_t request_id,
                                               bool accept, const char* text) {
  ViewHost* v = getView(view_id);
  if (!v) return;
  auto it = v->pending_dialogs.find(request_id);
  if (it == v->pending_dialogs.end()) return;
  ViewHost::PendingDialog entry = std::move(it->second);
  v->pending_dialogs.erase(it);
  if (entry.args && accept) {
    // prompt: feed user text. WV2 ignores put_ResultText for non-prompt kinds.
    if (text && *text) entry.args->put_ResultText(utf8ToWide(text).c_str());
    entry.args->Accept();
  }
  // accept=false → no Accept() call → WV2 treats as dismiss (default behavior).
  if (entry.deferral) entry.deferral->Complete();
}

BUNITE_EXPORT void bunite_view_open_devtools(uint32_t view_id) {
  ViewHost* v = getView(view_id);
  if (v && v->webview) v->webview->OpenDevToolsWindow();
}

BUNITE_EXPORT void bunite_view_close_devtools(uint32_t /*view_id*/) {
  // WebView2 doesn't expose a "close devtools" API; the user closes the panel.
}

BUNITE_EXPORT void bunite_view_toggle_devtools(uint32_t view_id) {
  bunite_view_open_devtools(view_id);
}

// ---- permissions ------------------------------------------------------

BUNITE_EXPORT void bunite_complete_permission_request(uint32_t request_id, uint32_t state) {
  PendingPermissionRequest p;
  {
    std::lock_guard<std::mutex> g(g_runtime.permission_mutex);
    auto it = g_runtime.pending_permissions.find(request_id);
    if (it == g_runtime.pending_permissions.end()) return;
    p = std::move(it->second);
    g_runtime.pending_permissions.erase(it);
  }
  if (p.args) p.args->put_State(buniteStateToWebView2(state));
  if (p.deferral) p.deferral->Complete();
}

}  // extern "C"
