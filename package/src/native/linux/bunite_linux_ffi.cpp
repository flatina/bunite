#include "bunite_linux_internal.h"
#include "webview_storage.h"

#include <cairo.h>

#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

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
      static const std::string codePrefix = "{\"__bunite_ok\":false,\"code\":\"";
      std::string code = "runtime_error";
      std::string msg = "script threw";
      if (inner.compare(0, codePrefix.size(), codePrefix) == 0) {
        size_t start = codePrefix.size();
        size_t end = start;
        while (end < inner.size() && inner[end] != '"') ++end;
        if (end > start) code = inner.substr(start, end - start);
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
      payload += ",\"ok\":false,\"code\":\"" + bunite_linux::escapeJsonString(code) + "\","
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
      ")})}catch(e){var c=(e&&e.name===\"SecurityError\")?\"cross_origin\":\"runtime_error\";"
      "return JSON.stringify({__bunite_ok:false,code:c,"
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

// Screenshot — webkit_web_view_get_snapshot → cairo_surface_t → PNG bytes via
// cairo_surface_write_to_png_stream → g_base64_encode. JPEG path uses GdkPixbuf
// for `pixbuf_save_to_buffer(... "jpeg" ...)`.
namespace {

struct LinuxShotCtx {
  uint32_t view_id;
  uint32_t request_id;
  std::string format;  // "png" | "jpeg"
  int32_t quality;
};

void emitLinuxShotError(uint32_t view_id, uint32_t request_id, const char* code, const std::string& msg) {
  std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                        ",\"ok\":false,\"code\":\"" + code + "\","
                        "\"message\":\"" + bunite_linux::escapeJsonString(msg) + "\"}";
  bunite_linux::emitWebviewEvent(view_id, "screenshot-result", payload);
}

cairo_status_t cairo_buf_writer(void* closure, const unsigned char* data, unsigned int len) {
  auto* buf = static_cast<std::vector<unsigned char>*>(closure);
  buf->insert(buf->end(), data, data + len);
  return CAIRO_STATUS_SUCCESS;
}

void on_snapshot_done(GObject* source, GAsyncResult* res, gpointer user_data) {
  auto* ctx = static_cast<LinuxShotCtx*>(user_data);
  WebKitWebView* wv = WEBKIT_WEB_VIEW(source);
  GError* err = nullptr;
  cairo_surface_t* surface = webkit_web_view_get_snapshot_finish(wv, res, &err);
  if (!surface) {
    emitLinuxShotError(ctx->view_id, ctx->request_id, "runtime_error",
                       err ? err->message : "snapshot returned nil");
    if (err) g_error_free(err);
    delete ctx;
    return;
  }

  std::vector<unsigned char> bytes;
  cairo_status_t st = CAIRO_STATUS_SUCCESS;
  std::string mime;
  if (ctx->format == "jpeg" || ctx->format == "jpg") {
    // No native cairo JPEG; render surface to GdkPixbuf via cairo, save JPEG buffer.
    int w = cairo_image_surface_get_width(surface);
    int h = cairo_image_surface_get_height(surface);
    GdkPixbuf* pix = gdk_pixbuf_get_from_surface(surface, 0, 0, w, h);
    if (!pix) { st = CAIRO_STATUS_NO_MEMORY; }
    else {
      gchar* raw = nullptr; gsize raw_len = 0;
      char qbuf[8]; snprintf(qbuf, sizeof(qbuf), "%d", ctx->quality < 0 ? 90 : (ctx->quality > 100 ? 100 : ctx->quality));
      GError* perr = nullptr;
      if (gdk_pixbuf_save_to_buffer(pix, &raw, &raw_len, "jpeg", &perr, "quality", qbuf, nullptr)) {
        bytes.assign(raw, raw + raw_len);
        g_free(raw);
      } else {
        if (perr) { st = CAIRO_STATUS_WRITE_ERROR; g_error_free(perr); }
      }
      g_object_unref(pix);
    }
    mime = "image/jpeg";
    ctx->format = "jpeg";
  } else {
    st = cairo_surface_write_to_png_stream(surface, cairo_buf_writer, &bytes);
    mime = "image/png";
    ctx->format = "png";
  }
  cairo_surface_destroy(surface);

  if (st != CAIRO_STATUS_SUCCESS || bytes.empty()) {
    emitLinuxShotError(ctx->view_id, ctx->request_id, "runtime_error", "encode failed");
    delete ctx;
    return;
  }
  gchar* b64 = g_base64_encode(bytes.data(), bytes.size());
  std::string payload = "{\"requestId\":" + std::to_string(ctx->request_id) +
                        ",\"ok\":true,\"format\":\"" + ctx->format +
                        "\",\"mime\":\"" + mime +
                        "\",\"dataBase64\":\"" + (b64 ? b64 : "") + "\"}";
  if (b64) g_free(b64);
  bunite_linux::emitWebviewEvent(ctx->view_id, "screenshot-result", payload);
  delete ctx;
}

}  // namespace

extern "C" BUNITE_EXPORT uint32_t bunite_view_capabilities(uint32_t view_id) {
  // WebKitGTK — input dispatch impossible on GTK4+Wayland; screenshot via cairo.
  auto* v = bunite_linux::findView(view_id);
  if (!v) return 0;
  return BUNITE_CAP_EVALUATE | BUNITE_CAP_TITLE_CHANGED |
         BUNITE_CAP_SCREENSHOT | BUNITE_CAP_FORMAT_PNG | BUNITE_CAP_FORMAT_JPEG;
}

extern "C" BUNITE_EXPORT void bunite_view_screenshot(uint32_t view_id, uint32_t request_id,
                                                       const char* format, int32_t quality) {
  std::string fmt = format ? format : "png";
  runOnUiThreadSync([=]() {
    auto* v = bunite_linux::findView(view_id);
    if (!v || !v->webview) {
      emitLinuxShotError(view_id, request_id, "not_supported", "view not ready");
      return;
    }
    auto* ctx = new LinuxShotCtx{view_id, request_id, fmt, quality};
    webkit_web_view_get_snapshot(v->webview, WEBKIT_SNAPSHOT_REGION_VISIBLE,
                                 WEBKIT_SNAPSHOT_OPTIONS_NONE, nullptr,
                                 on_snapshot_done, ctx);
  });
}

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
