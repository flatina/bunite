#pragma once

#include "../shared/ffi_exports.h"
#include "../shared/log.h"
#include "../shared/webview_storage.h"

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

constexpr wchar_t kWindowClass[] = L"BuniteWindowClass";
constexpr UINT kRunQueuedTaskMessage = WM_APP + 1;
constexpr UINT kFinalizeShutdownMessage = WM_APP + 4;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

enum class PermissionRequestKind {
  Prompt,
  MediaAccess
};

// View anchor modes for automatic layout during window resize.
enum class ViewAnchorMode {
  None = 0,       // manual bounds
  Fill = 1,       // fill client area
  Top = 2,        // top strip (fixed height)
  BelowTop = 3    // below top strip
};

// ---------------------------------------------------------------------------
// Structures
// ---------------------------------------------------------------------------

struct PendingPermissionRequest {
  PermissionRequestKind kind;
  uint32_t permissions = 0;
  CefRefPtr<CefPermissionPromptCallback> prompt_callback;
  CefRefPtr<CefMediaAccessCallback> media_callback;
};

struct WindowHost;

struct ViewHost {
  uint32_t id = 0;
  WindowHost* window = nullptr;
  RECT bounds{0, 0, 0, 0};
  std::string url;
  std::string html;
  std::string preload_script;
  std::string appres_root;
  std::vector<std::string> navigation_rules;
  int anchor_mode = static_cast<int>(ViewAnchorMode::Fill);
  double anchor_inset = 0;
  bool sandbox = false;
  std::vector<std::string> preload_origins;
  std::atomic<bool> closing = false;
  CefRefPtr<CefBrowser> browser;
  CefRefPtr<CefClient> client;

  // Pending state: applied in OnAfterCreated when browser HWND becomes available.
  bool pending_visible = true;
  bool pending_bring_to_front = false;
  bool pending_passthrough = false;
  bool has_pending_bounds = false;
  RECT pending_bounds{0, 0, 0, 0};
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

extern RuntimeState g_runtime;

// ---------------------------------------------------------------------------
// Cross-TU function declarations (namespace bunite_win)
// ---------------------------------------------------------------------------

namespace bunite_win {

HINSTANCE getCurrentModuleHandle();
bool isOnUiThread();                                        // [any thread]
void postUiTask(std::function<void()> task);                // [any thread]
void postCefUiTask(std::function<void()> task);             // [any thread]
void executeQueuedUiTasks();                                // [UI thread]
bool registerWindowClasses();                               // [UI thread]
void uiThreadMain();                                        // [spawned thread]

std::wstring utf8ToWide(const std::string& value);
std::string escapeJsonString(const std::string& value);
std::vector<std::string> splitButtonLabels(const std::string& buttons_csv);
std::string trimAsciiWhitespace(const std::string& value);
std::string toLowerAscii(std::string value);
bool globMatchCaseInsensitive(const std::string& pattern, const std::string& value);
std::vector<std::string> parseNavigationRulesJson(const std::string& rules_json);
std::map<std::string, std::string> parseChromiumFlagsJson(const std::string& json);
bool shouldAlwaysAllowNavigationUrl(const std::string& url);
bool shouldAllowNavigation(const ViewHost* view, const std::string& url);
void emitWindowEvent(uint32_t window_id, const char* event_name, const std::string& payload = {});
void emitWebviewEvent(uint32_t view_id, const char* event_name, const std::string& payload = {});

std::string normalizeAppResPath(const std::string& url);
std::string getMimeType(const std::filesystem::path& file_path);
std::string getAppResRootForView(uint32_t view_id);
std::optional<std::string> loadAppResResource(uint32_t view_id, const std::string& url, std::string& mime_type);
void registerAppResSchemeHandlers();                        // [CEF UI thread]

void removeBrowserMapping(int browser_id);
void syncWindowFrame(WindowHost* window);                   // [UI thread]
void resizeViewToFit(ViewHost* view);                       // [UI thread]
void finalizeViewHost(ViewHost* view);                      // [CEF UI thread]
void closeViewHost(ViewHost* view);                         // [any thread]
void destroyWindowHost(WindowHost* window);                 // [UI thread]
void finalizeWindowHost(WindowHost* window);                // [UI thread]
void openDevToolsForView(ViewHost* view);                   // [CEF UI thread]
void closeDevToolsForView(ViewHost* view);                  // [CEF UI thread]
void toggleDevToolsForView(ViewHost* view);                 // [CEF UI thread]
bool initializeCefOnUiThread();                             // [UI thread]
void shutdownCefOnUiThread();                               // [UI thread]
void cancelPendingPermissionRequestsOnUiThread();           // [CEF UI thread]
void cancelPendingRouteRequestsOnUiThread();                // [CEF UI thread]
void maybeCompleteShutdownOnUiThread();                     // [CEF UI thread]
void closeAllWindowsForShutdown();                          // [UI thread]
WindowHost* getWindowHostById(uint32_t window_id);
ViewHost* getViewHostById(uint32_t view_id);
DWORD makeWindowStyle(const std::wstring& title_bar_style);
bool createBrowserForView(ViewHost* view);                  // [UI thread]

class CefClosureTask : public CefTask {
public:
  explicit CefClosureTask(std::function<void()> fn) : fn_(std::move(fn)) {}
  void Execute() override { fn_(); }
private:
  std::function<void()> fn_;
  IMPLEMENT_REFCOUNTING(CefClosureTask);
};

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
inline void runOnUiThreadSync<void>(std::function<void()> task) {
  if (isOnUiThread()) {
    task();
    return;
  }

  auto packaged = std::make_shared<std::packaged_task<void()>>(std::move(task));
  auto future = packaged->get_future();
  postUiTask([packaged]() { (*packaged)(); });
  future.get();
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
inline void runOnCefUiThreadSync<void>(std::function<void()> task) {
  if (CefCurrentlyOn(TID_UI)) {
    task();
    return;
  }

  auto packaged = std::make_shared<std::packaged_task<void()>>(std::move(task));
  auto future = packaged->get_future();
  postCefUiTask([packaged]() { (*packaged)(); });
  future.get();
}

} // namespace bunite_win
