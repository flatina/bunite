#include "bunite_linux_internal.h"

#include <cstdlib>
#include <string>
#include <vector>

namespace bunite_linux {

RuntimeState g_runtime;

bool isOnMainThread() {
  return g_runtime.ui_thread_set && pthread_equal(pthread_self(), g_runtime.ui_thread);
}

}  // namespace bunite_linux

namespace {

constexpr int32_t kBuniteAbiVersion = 9;

}  // namespace

extern "C" BUNITE_EXPORT int32_t bunite_abi_version(void) { return kBuniteAbiVersion; }
extern "C" BUNITE_EXPORT void bunite_set_log_level(int32_t level) { (void)level; }

extern "C" BUNITE_EXPORT const char* bunite_engine_name(void) { return "webkitgtk"; }

extern "C" BUNITE_EXPORT const char* bunite_engine_version(void) {
  static std::string cached =
    std::to_string(webkit_get_major_version()) + "." +
    std::to_string(webkit_get_minor_version()) + "." +
    std::to_string(webkit_get_micro_version());
  return cached.c_str();
}

extern "C" BUNITE_EXPORT bool bunite_init(
  const char* cef_dir, bool hide_console, bool popup_blocking, const char* engine_config_json
) {
  (void)cef_dir; (void)hide_console; (void)engine_config_json;
  auto& rt = bunite_linux::g_runtime;
  if (rt.initialized) return true;
  rt.popup_blocking = popup_blocking;
  rt.ui_thread = pthread_self();
  rt.ui_thread_set = true;
  rt.ui_context = g_main_context_default();

  gtk_init();

  GtkApplication* app = gtk_application_new("dev.bunite.app", G_APPLICATION_NON_UNIQUE);
  GError* err = nullptr;
  const gboolean registered = g_application_register(G_APPLICATION(app), nullptr, &err);
  if (!registered) {
    BUNITE_ERROR("bunite_init: g_application_register failed: %s", err ? err->message : "(unknown)");
    if (err) g_error_free(err);
    g_object_unref(app);
    rt.ui_context = nullptr;
    rt.ui_thread_set = false;
    return false;
  }

  rt.app = app;
  rt.initialized = true;
  return true;
}

// JS drives the default GLib context from Bun's loop.
extern "C" BUNITE_EXPORT void bunite_run_loop(void) {}
extern "C" BUNITE_EXPORT void bunite_pump_once(void) {
  if (!bunite_linux::isOnMainThread()) {
    BUNITE_WARN("bunite_pump_once called off the GTK thread; ignoring.");
    return;
  }
  GMainContext* ctx = bunite_linux::g_runtime.ui_context;
  if (!ctx) return;

  const gint64 deadline = g_get_monotonic_time() + 5000;  // 5ms
  do {
    if (!g_main_context_pending(ctx)) break;
    g_main_context_iteration(ctx, FALSE);
  } while (g_get_monotonic_time() < deadline);
}

extern "C" BUNITE_EXPORT void bunite_quit(void) {
  auto& rt = bunite_linux::g_runtime;
  if (!rt.initialized) return;
  rt.shutting_down.store(true);

  std::vector<GtkWindow*> windows;
  {
    std::lock_guard<std::mutex> lock(rt.object_mutex);
    for (auto& [_, state] : rt.windows) {
      if (state.window) windows.push_back(state.window);
    }
  }
  for (GtkWindow* window : windows) {
    gtk_window_destroy(window);
  }

  if (rt.app) {
    g_application_quit(G_APPLICATION(rt.app));
    g_object_unref(rt.app);
    rt.app = nullptr;
  }
  rt.ui_context = nullptr;
  rt.ui_thread_set = false;
  rt.initialized = false;
  rt.shutting_down.store(false);
}

extern "C" BUNITE_EXPORT void bunite_free_cstring(const char* value) {
  std::free(const_cast<char*>(value));
}

extern "C" BUNITE_EXPORT void bunite_set_webview_event_handler(BuniteWebviewEventHandler handler) {
  bunite_linux::g_runtime.webview_event_handler = handler;
}

extern "C" BUNITE_EXPORT void bunite_set_window_event_handler(BuniteWindowEventHandler handler) {
  bunite_linux::g_runtime.window_event_handler = handler;
}
