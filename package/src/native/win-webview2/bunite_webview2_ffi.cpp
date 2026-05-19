#include "webview2_internal.h"

#include <cstring>

using namespace bunite_webview2;

// Forward declaration of helper defined in webview2_runtime.cpp.
namespace bunite_webview2 {
void setViewInputPassthrough(ViewHost* v, bool passthrough);
}

extern "C" {

BUNITE_EXPORT int32_t bunite_abi_version(void) { return 5; }

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
  auto lifetime = g_runtime.lifetime;
  v->webview->ExecuteScript(
      utf8ToWide(script).c_str(),
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
              // WebView2 returns JSON-encoded result. Embed as a JSON string so
              // the JS-side parses it as a string and re-JSON.parses to get the
              // value back (the `value` field of the envelope is a raw JSON
              // string per the FFI contract).
              std::string value = wideToUtf8(raw);
              payload = "{\"requestId\":" + std::to_string(request_id) +
                        ",\"ok\":true,\"value\":\"" + escapeJsonString(value) + "\"}";
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
