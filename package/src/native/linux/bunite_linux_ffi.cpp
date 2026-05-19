#include "bunite_linux_internal.h"
#include "webview_storage.h"

#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>

using bunite_linux::g_runtime;
using bunite_linux::runOnUiThreadSync;

#define BUNITE_LINUX_TODO(name)                                                        \
  do {                                                                                 \
    static std::once_flag once;                                                        \
    std::call_once(once, []() {                                                        \
      BUNITE_WARN("%s not implemented yet on linux (skeleton stub)", name);            \
    });                                                                                \
  } while (0)

extern "C" BUNITE_EXPORT bool bunite_window_create(
  uint32_t window_id, double x, double y, double width, double height,
  const char* title, const char* title_bar_style,
  bool transparent, bool hidden, bool minimized, bool maximized
) {
  return runOnUiThreadSync([=]() -> bool {
    return bunite_linux::createWindow(window_id, x, y, width, height, title, title_bar_style,
                                      transparent, hidden, minimized, maximized);
  });
}

extern "C" BUNITE_EXPORT void bunite_window_destroy(uint32_t window_id) {
  runOnUiThreadSync([=]() { bunite_linux::destroyWindow(window_id); });
}

extern "C" BUNITE_EXPORT void bunite_window_reset_close_pending(uint32_t window_id) {
  runOnUiThreadSync([=]() {
    if (auto* s = bunite_linux::findWindow(window_id)) s->close_pending.store(false);
  });
}

extern "C" BUNITE_EXPORT void bunite_window_show(uint32_t window_id) {
  runOnUiThreadSync([=]() {
    if (auto* s = bunite_linux::findWindow(window_id)) gtk_window_present(s->window);
  });
}

extern "C" BUNITE_EXPORT void bunite_window_close(uint32_t window_id) {
  runOnUiThreadSync([=]() {
    if (auto* s = bunite_linux::findWindow(window_id)) gtk_window_close(s->window);
  });
}

extern "C" BUNITE_EXPORT void bunite_window_set_title(uint32_t window_id, const char* title) {
  std::string t = title ? title : "";
  runOnUiThreadSync([=]() {
    if (auto* s = bunite_linux::findWindow(window_id)) gtk_window_set_title(s->window, t.c_str());
  });
}

extern "C" BUNITE_EXPORT void bunite_window_minimize(uint32_t window_id) {
  runOnUiThreadSync([=]() {
    auto* s = bunite_linux::findWindow(window_id);
    if (s && !s->minimized.exchange(true)) gtk_window_minimize(s->window);
  });
}

extern "C" BUNITE_EXPORT void bunite_window_unminimize(uint32_t window_id) {
  runOnUiThreadSync([=]() {
    auto* s = bunite_linux::findWindow(window_id);
    // GTK4 has no unminimize — present() raises and de-minimizes.
    if (s && s->minimized.exchange(false)) gtk_window_present(s->window);
  });
}

extern "C" BUNITE_EXPORT bool bunite_window_is_minimized(uint32_t window_id) {
  return runOnUiThreadSync([=]() -> bool {
    auto* s = bunite_linux::findWindow(window_id);
    return s ? s->minimized.load() : false;
  });
}

extern "C" BUNITE_EXPORT void bunite_window_maximize(uint32_t window_id) {
  runOnUiThreadSync([=]() {
    auto* s = bunite_linux::findWindow(window_id);
    if (s && !s->maximized.exchange(true)) gtk_window_maximize(s->window);
  });
}

extern "C" BUNITE_EXPORT void bunite_window_unmaximize(uint32_t window_id) {
  runOnUiThreadSync([=]() {
    auto* s = bunite_linux::findWindow(window_id);
    if (s && s->maximized.exchange(false)) gtk_window_unmaximize(s->window);
  });
}

extern "C" BUNITE_EXPORT bool bunite_window_is_maximized(uint32_t window_id) {
  return runOnUiThreadSync([=]() -> bool {
    auto* s = bunite_linux::findWindow(window_id);
    return s ? s->maximized.load() : false;
  });
}

extern "C" BUNITE_EXPORT void bunite_window_set_frame(
  uint32_t window_id, double x, double y, double width, double height
) {
  (void)x; (void)y;
  runOnUiThreadSync([=]() {
    if (auto* s = bunite_linux::findWindow(window_id))
      gtk_window_set_default_size(s->window, (int)width, (int)height);
  });
}

extern "C" BUNITE_EXPORT bool bunite_view_create(
  uint32_t view_id, uint32_t window_id,
  const char* url, const char* html, const char* preload,
  const char* appres_root, const char* navigation_rules_json,
  double x, double y, double width, double height,
  bool auto_resize, bool sandbox, const char* preload_origins_json
) {
  (void)sandbox;
  return runOnUiThreadSync([=]() -> bool {
    return bunite_linux::createView(view_id, window_id, url, html, preload, appres_root,
                                    navigation_rules_json, preload_origins_json,
                                    x, y, width, height, auto_resize);
  });
}

extern "C" BUNITE_EXPORT void bunite_view_execute_javascript(uint32_t view_id, const char* script) {
  std::string s = script ? script : "";
  runOnUiThreadSync([=]() {
    if (auto* v = bunite_linux::findView(view_id))
      webkit_web_view_evaluate_javascript(v->webview, s.c_str(), -1, nullptr, nullptr, nullptr, nullptr, nullptr);
  });
}

namespace {

struct EvaluateCtx {
  uint32_t view_id;
  uint32_t request_id;
};

void on_evaluate_done(GObject* source, GAsyncResult* res, gpointer user_data) {
  auto* ctx = static_cast<EvaluateCtx*>(user_data);
  WebKitWebView* wv = WEBKIT_WEB_VIEW(source);
  GError* err = nullptr;
  JSCValue* value = webkit_web_view_evaluate_javascript_finish(wv, res, &err);

  std::string payload = "{\"requestId\":" + std::to_string(ctx->request_id);
  if (err || !value) {
    std::string msg = err ? err->message : "evaluate failed";
    if (err) g_error_free(err);
    payload += ",\"ok\":false,\"code\":\"runtime_error\","
               "\"message\":\"" + bunite_linux::escapeJsonString(msg) + "\"}";
  } else if (!jsc_value_is_string(value)) {
    payload += ",\"ok\":false,\"code\":\"runtime_error\","
               "\"message\":\"wrapper returned non-string\"}";
  } else {
    char* raw = jsc_value_to_string(value);
    std::string inner = raw ? raw : "";
    if (raw) g_free(raw);
    if (inner.find("\"__bunite_ok\":true") != std::string::npos) {
      static const std::string prefix = "{\"__bunite_ok\":true,\"value\":";
      std::string value_json = "null";
      if (inner.compare(0, prefix.size(), prefix) == 0 &&
          inner.size() > prefix.size() + 1) {
        value_json = inner.substr(prefix.size(), inner.size() - prefix.size() - 1);
      }
      payload += ",\"ok\":true,\"value\":\"" + bunite_linux::escapeJsonString(value_json) + "\"}";
    } else {
      std::string msg = "script threw";
      size_t key = inner.find("\"message\":\"");
      if (key != std::string::npos) {
        size_t start = key + std::strlen("\"message\":\"");
        size_t end = start;
        while (end < inner.size()) {
          if (inner[end] == '"' && (end == start || inner[end - 1] != '\\')) break;
          ++end;
        }
        if (end > start) msg = inner.substr(start, end - start);
      }
      payload += ",\"ok\":false,\"code\":\"runtime_error\","
                 "\"message\":\"" + bunite_linux::escapeJsonString(msg) + "\"}";
    }
  }
  if (value) g_object_unref(value);
  bunite_linux::emitWebviewEvent(ctx->view_id, "evaluate-result", payload);
  delete ctx;
}

}  // namespace

extern "C" BUNITE_EXPORT void bunite_view_evaluate(uint32_t view_id, uint32_t request_id, const char* script) {
  // Wrapper matches WebView2/CEF: try/catch returns JSON envelope string.
  // jsc_value_to_string delivers the wrapper's return value directly.
  if (!script) {
    std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                          ",\"ok\":false,\"code\":\"runtime_error\","
                          "\"message\":\"null script\"}";
    bunite_linux::emitWebviewEvent(view_id, "evaluate-result", payload);
    return;
  }
  std::string wrapped =
      "(function(){try{return JSON.stringify({__bunite_ok:true,value:("
      + std::string(script) +
      ")})}catch(e){return JSON.stringify({__bunite_ok:false,"
      "message:(e&&e.message)?e.message:String(e),"
      "name:(e&&e.name)||\"\"})}})()";
  runOnUiThreadSync([=]() {
    auto* v = bunite_linux::findView(view_id);
    if (!v || !v->webview) {
      std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                            ",\"ok\":false,\"code\":\"not_supported\","
                            "\"message\":\"view not ready\"}";
      bunite_linux::emitWebviewEvent(view_id, "evaluate-result", payload);
      return;
    }
    auto* ctx = new EvaluateCtx{view_id, request_id};
    webkit_web_view_evaluate_javascript(
        v->webview, wrapped.c_str(), -1, nullptr, nullptr, nullptr,
        on_evaluate_done, ctx);
  });
}

extern "C" BUNITE_EXPORT void bunite_view_load_url(uint32_t view_id, const char* url) {
  std::string s = url ? url : "";
  runOnUiThreadSync([=]() {
    auto* v = bunite_linux::findView(view_id);
    if (!v) return;
    bunite::WebviewContentStorage::instance().remove(view_id);
    webkit_web_view_load_uri(v->webview, s.c_str());
  });
}

extern "C" BUNITE_EXPORT void bunite_view_load_html(uint32_t view_id, const char* html) {
  std::string content = html ? html : "";
  runOnUiThreadSync([=]() {
    auto* v = bunite_linux::findView(view_id);
    if (!v) return;
    bunite::WebviewContentStorage::instance().set(view_id, content);
    webkit_web_view_load_uri(v->webview, "appres://app.internal/internal/index.html");
  });
}

extern "C" BUNITE_EXPORT void bunite_register_appres_route(const char* path) {
  bunite::AppResRouteStorage::instance().registerRoute(path ? path : "");
}

extern "C" BUNITE_EXPORT void bunite_unregister_appres_route(const char* path) {
  bunite::AppResRouteStorage::instance().unregisterRoute(path ? path : "");
}

extern "C" BUNITE_EXPORT void bunite_complete_route_request(uint32_t request_id, const char* html) {
  std::string body = html ? html : "";
  runOnUiThreadSync([=]() {
    auto it = bunite_linux::g_runtime.pending_route_tasks.find(request_id);
    if (it == bunite_linux::g_runtime.pending_route_tasks.end()) return;
    WebKitURISchemeRequest* req = it->second.request;
    bunite_linux::g_runtime.pending_route_tasks.erase(it);
    GInputStream* stream = g_memory_input_stream_new_from_data(
      g_memdup2(body.data(), body.size()), (gssize)body.size(), g_free);
    webkit_uri_scheme_request_finish(req, stream, (gint64)body.size(), "text/html");
    g_object_unref(stream);
    g_object_unref(req);
  });
}

extern "C" BUNITE_EXPORT void bunite_view_set_visible(uint32_t view_id, bool visible) {
  runOnUiThreadSync([=]() {
    if (auto* v = bunite_linux::findView(view_id)) {
      gtk_widget_set_visible(v->container ? v->container : GTK_WIDGET(v->webview), visible);
      if (visible) bunite_linux::queueViewRedraw(v->webview);
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_set_input_passthrough(uint32_t view_id, bool passthrough) {
  runOnUiThreadSync([=]() {
    if (auto* v = bunite_linux::findView(view_id))
      gtk_widget_set_can_target(GTK_WIDGET(v->webview), !passthrough);
  });
}

extern "C" BUNITE_EXPORT void bunite_view_set_mask_region(uint32_t view_id, const double* rects, uint32_t count) {
  // GTK4 has no per-widget region cull primitive — mask not implemented.
  (void)view_id; (void)rects; (void)count; BUNITE_LINUX_TODO("bunite_view_set_mask_region");
}

extern "C" BUNITE_EXPORT void bunite_view_bring_to_front(uint32_t view_id) {
  runOnUiThreadSync([=]() {
    auto* v = bunite_linux::findView(view_id);
    if (!v) return;
    // GtkOverlay handles z-order; reparenting blanks child surfaces under WSLg.
    bunite_linux::queueViewRedraw(v->webview);
  });
}

extern "C" BUNITE_EXPORT void bunite_view_set_bounds(
  uint32_t view_id, double x, double y, double width, double height
) {
  runOnUiThreadSync([=]() { bunite_linux::applyViewBounds(view_id, x, y, width, height); });
}

extern "C" BUNITE_EXPORT void bunite_view_set_bounds_async(
  uint32_t view_id, double x, double y, double width, double height
) {
  auto* invoke = new std::function<void()>(
    [=]() { bunite_linux::applyViewBounds(view_id, x, y, width, height); });
  g_main_context_invoke_full(g_runtime.ui_context, G_PRIORITY_DEFAULT,
    +[](gpointer data) -> gboolean {
      (*static_cast<std::function<void()>*>(data))();
      return G_SOURCE_REMOVE;
    },
    invoke,
    +[](gpointer data) { delete static_cast<std::function<void()>*>(data); });
}

extern "C" BUNITE_EXPORT void bunite_view_set_anchor(uint32_t view_id, int mode, double inset) {
  (void)view_id; (void)mode; (void)inset; BUNITE_LINUX_TODO("bunite_view_set_anchor");
}

extern "C" BUNITE_EXPORT void bunite_view_go_back(uint32_t view_id) {
  runOnUiThreadSync([=]() {
    if (auto* v = bunite_linux::findView(view_id)) webkit_web_view_go_back(v->webview);
  });
}

extern "C" BUNITE_EXPORT void bunite_view_reload(uint32_t view_id) {
  runOnUiThreadSync([=]() {
    if (auto* v = bunite_linux::findView(view_id)) webkit_web_view_reload(v->webview);
  });
}

extern "C" BUNITE_EXPORT void bunite_view_remove(uint32_t view_id) {
  runOnUiThreadSync([=]() { bunite_linux::removeView(view_id); });
}

// Input dispatch — no-op on GTK4 + Wayland (no portable synthetic-input primitive).
// Capability `click/type/press/scroll: false` is honest; calls are silent no-ops.
extern "C" BUNITE_EXPORT void bunite_view_click(uint32_t, double, double, int32_t, int32_t, uint32_t) {}
extern "C" BUNITE_EXPORT void bunite_view_type(uint32_t, const char*) {}
extern "C" BUNITE_EXPORT void bunite_view_press(uint32_t, int32_t, int32_t, const char*, const char*, const char*, uint32_t) {}
extern "C" BUNITE_EXPORT void bunite_view_scroll(uint32_t, double, double, double, double, uint32_t) {}

extern "C" BUNITE_EXPORT void bunite_view_open_devtools(uint32_t view_id) {
  (void)view_id; BUNITE_LINUX_TODO("bunite_view_open_devtools");
}

extern "C" BUNITE_EXPORT void bunite_view_close_devtools(uint32_t view_id) {
  (void)view_id; BUNITE_LINUX_TODO("bunite_view_close_devtools");
}

extern "C" BUNITE_EXPORT void bunite_view_toggle_devtools(uint32_t view_id) {
  (void)view_id; BUNITE_LINUX_TODO("bunite_view_toggle_devtools");
}

extern "C" BUNITE_EXPORT void bunite_complete_permission_request(uint32_t request_id, uint32_t state) {
  (void)request_id; (void)state; BUNITE_LINUX_TODO("bunite_complete_permission_request");
}
