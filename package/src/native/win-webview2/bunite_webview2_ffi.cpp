#include "webview2_internal.h"

#include <cstring>
#include <wincrypt.h>  // CryptBinaryToStringA — base64 encoding for screenshot payload.

using namespace bunite_webview2;

// Forward declaration of helper defined in webview2_runtime.cpp.
namespace bunite_webview2 {
void setViewInputPassthrough(ViewHost* v, bool passthrough);
}

extern "C" {

BUNITE_EXPORT int32_t bunite_abi_version(void) { return 9; }

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
  WindowHost* w = getWindow(window_id);
  if (w && w->hwnd) DestroyWindow(w->hwnd);
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
// MouseEvent.isTrusted is false (CDP-synthesized); capability honest.
namespace {

const char* cdpMouseButton(int32_t b) {
  switch (b) { case 1: return "middle"; case 2: return "right"; default: return "left"; }
}

void cdpCall(ViewHost* v, const wchar_t* method, const std::string& json) {
  if (!v || !v->webview) return;
  v->webview->CallDevToolsProtocolMethod(
      method, utf8ToWide(json).c_str(), nullptr);
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

  auto buildPart = [&](const char* type, bool include_text) {
    std::string out = "{\"type\":\"";
    out += type;
    out += "\",\"modifiers\":" + std::to_string(modifiers);
    if (windows_vk_code != 0) out += ",\"windowsVirtualKeyCode\":" + std::to_string(windows_vk_code);
    if (!key_str.empty())  out += ",\"key\":\""  + escapeJsonString(key_str)  + "\"";
    if (!code_str.empty()) out += ",\"code\":\"" + escapeJsonString(code_str) + "\"";
    // CDP `location`: 0 standard, 1 left mod, 2 right mod, 3 numpad.
    if (location > 0) out += ",\"location\":" + std::to_string(location);
    if (include_text && !char_str.empty())
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
         BUNITE_CAP_SCREENSHOT | BUNITE_CAP_FORMAT_PNG | BUNITE_CAP_FORMAT_JPEG;
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
