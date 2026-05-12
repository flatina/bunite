#pragma once

#include "callbacks.h"
#include "ffi_exports.h"
#include "log.h"
#include "permissions.h"

#include <gtk/gtk.h>
#include <webkit/webkit.h>

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <pthread.h>
#include <string>
#include <unordered_map>
#include <vector>

namespace bunite_linux {

struct WindowState {
  GtkWindow* window = nullptr;
  // gtk_window_set_child accepts only one widget; overlay hosts the main view
  // (set_child) and future surfaces (add_overlay).
  GtkOverlay* host = nullptr;
  std::atomic<bool> close_pending{false};
  // GTK4 has no is_minimized query, and is_maximized reflects compositor state
  // (ignored on WSLg / some tiling WMs). Logical state tracked for FFI parity.
  std::atomic<bool> minimized{false};
  std::atomic<bool> maximized{false};
};

struct ViewState {
  GtkWidget* container = nullptr;
  WebKitWebView* webview = nullptr;
  uint32_t window_id = 0;
  std::string appres_root;
  std::string preload_script;
  std::string stored_html;
  std::vector<std::string> navigation_rules;
};

struct RuntimeState {
  std::mutex object_mutex;
  std::unordered_map<uint32_t, WindowState> windows;
  std::unordered_map<uint32_t, ViewState> views;

  bool initialized = false;
  bool popup_blocking = false;
  std::atomic<bool> shutting_down{false};

  GtkApplication* app = nullptr;
  GMainContext* ui_context = nullptr;
  pthread_t ui_thread = 0;
  bool ui_thread_set = false;

  std::unordered_map<uint32_t, WebKitPermissionRequest*> pending_permissions;
  uint32_t next_permission_request_id = 1;

  struct PendingRoute { uint32_t view_id; WebKitURISchemeRequest* request; };
  std::unordered_map<uint32_t, PendingRoute> pending_route_tasks;
  uint32_t next_route_request_id = 1;

  BuniteWebviewEventHandler webview_event_handler = nullptr;
  BuniteWindowEventHandler window_event_handler = nullptr;
};

extern RuntimeState g_runtime;

bool isOnMainThread();

template <typename Block>
auto runOnUiThreadSync(Block block) -> decltype(block()) {
  using R = decltype(block());
  if (isOnMainThread()) return block();
  if constexpr (std::is_void_v<R>) {
    std::mutex m;
    std::condition_variable cv;
    bool done = false;
    auto invoke = [&]() {
      block();
      {
        std::lock_guard<std::mutex> lock(m);
        done = true;
      }
      cv.notify_all();
    };
    auto trampoline = +[](gpointer data) -> gboolean {
      (*static_cast<decltype(invoke)*>(data))();
      return G_SOURCE_REMOVE;
    };
    g_main_context_invoke_full(g_runtime.ui_context, G_PRIORITY_DEFAULT, trampoline, &invoke, nullptr);
    std::unique_lock<std::mutex> lock(m);
    cv.wait(lock, [&]() { return done; });
  } else {
    R result{};
    std::mutex m;
    std::condition_variable cv;
    bool done = false;
    auto invoke = [&]() {
      result = block();
      {
        std::lock_guard<std::mutex> lock(m);
        done = true;
      }
      cv.notify_all();
    };
    auto trampoline = +[](gpointer data) -> gboolean {
      (*static_cast<decltype(invoke)*>(data))();
      return G_SOURCE_REMOVE;
    };
    g_main_context_invoke_full(g_runtime.ui_context, G_PRIORITY_DEFAULT, trampoline, &invoke, nullptr);
    std::unique_lock<std::mutex> lock(m);
    cv.wait(lock, [&]() { return done; });
    return result;
  }
}

std::string escapeJsonString(const std::string& value);

void emitWindowEvent(uint32_t window_id, const char* event_name, const std::string& payload = {});
void emitWebviewEvent(uint32_t view_id, const char* event_name, const std::string& payload = {});

bool globMatchCaseInsensitive(const std::string& pattern, const std::string& value);
std::vector<std::string> parseNavigationRulesJson(const std::string& json);
bool shouldAlwaysAllowNavigationUrl(const std::string& url);
bool shouldAllowNavigation(const ViewState* view, const std::string& url);

WindowState* findWindow(uint32_t window_id);
bool createWindow(uint32_t window_id, double x, double y, double width, double height,
                  const char* title, const char* title_bar_style,
                  bool transparent, bool hidden, bool minimized, bool maximized);
void destroyWindow(uint32_t window_id);

ViewState* findView(uint32_t view_id);
uint32_t viewIdForWebView(WebKitWebView* wv);
bool createView(uint32_t view_id, uint32_t window_id,
                const char* url, const char* html, const char* preload, const char* appres_root,
                const char* navigation_rules_json, const char* preload_origins_json,
                double x, double y, double width, double height, bool auto_resize);
void removeView(uint32_t view_id);
void detachViewSideState(uint32_t view_id);
void applyViewBounds(uint32_t view_id, double x, double y, double width, double height);
void queueViewRedraw(WebKitWebView* wv);

void registerAppresScheme(WebKitWebContext* ctx);

}  // namespace bunite_linux
