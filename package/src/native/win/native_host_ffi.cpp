#include "native_host_internal.h"

#include "include/cef_version.h"
#include "include/cef_version_info.h"
#include "include/cef_parser.h"
#include "include/cef_values.h"

// CDP path — input dispatch (mouse wheel) and screenshot use CefBrowserHost::
// ExecuteDevToolsMethod. Replies arrive on the CefDevToolsMessageObserver.
// scroll: SendMouseWheelEvent doesn't reach the page in windowed CEF
//   (verified empirically on Win 11 / CEF 119+).
// screenshot: PrintWindow PW_RENDERFULLCONTENT misses hardware-composited
//   surfaces (returns all-black). Page.captureScreenshot is compositor-aware.
#include <algorithm>
#include <array>
#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <vector>


using bunite_win::runOnUiThreadSync;
using bunite_win::runOnCefUiThreadSync;

static constexpr int32_t BUNITE_ABI_VERSION = 12;

namespace {

// CDP message routing: ExecuteDevToolsMethod returns a message_id; the
// singleton observer routes OnDevToolsMethodResult back to a stashed callback.
std::mutex g_cdp_cb_mutex;
std::unordered_map<int, std::function<void(bool, std::string)>> g_cdp_callbacks;

class BuniteDevToolsObserver : public CefDevToolsMessageObserver {
public:
  void OnDevToolsMethodResult(CefRefPtr<CefBrowser>, int message_id, bool success,
                              const void* result, size_t result_size) override {
    std::function<void(bool, std::string)> cb;
    {
      std::lock_guard<std::mutex> lk(g_cdp_cb_mutex);
      auto it = g_cdp_callbacks.find(message_id);
      if (it == g_cdp_callbacks.end()) return;
      cb = std::move(it->second);
      g_cdp_callbacks.erase(it);
    }
    std::string r;
    if (result && result_size) r.assign(static_cast<const char*>(result), result_size);
    cb(success, std::move(r));
  }
  void OnDevToolsEvent(CefRefPtr<CefBrowser> browser,
                       const CefString& method,
                       const void* params,
                       size_t params_size) override {
    std::string m = method.ToString();
    if (m != "Target.attachedToTarget" && m != "Target.detachedFromTarget") return;
    std::string p;
    if (params && params_size) p.assign(static_cast<const char*>(params), params_size);
    CefRefPtr<CefValue> val = CefParseJSON(p, JSON_PARSER_RFC);
    if (!val || val->GetType() != VTYPE_DICTIONARY) return;
    auto d = val->GetDictionary();
    uint32_t view_id = 0;
    {
      std::lock_guard<std::mutex> lk(g_runtime.object_mutex);
      auto it = g_runtime.browser_to_view_id.find(browser->GetIdentifier());
      if (it == g_runtime.browser_to_view_id.end()) return;
      view_id = it->second;
    }
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view) return;
    if (m == "Target.attachedToTarget") {
      std::string session_id = d->HasKey("sessionId") ? d->GetString("sessionId").ToString() : "";
      if (session_id.empty()) return;
      auto info = d->HasKey("targetInfo") ? d->GetDictionary("targetInfo") : nullptr;
      if (!info) return;
      std::string type = info->HasKey("type") ? info->GetString("type").ToString() : "";
      std::string target_id = info->HasKey("targetId") ? info->GetString("targetId").ToString() : "";
      // For iframe targets in modern Chromium, targetId is the devtools frame
      // token — identical to Page.FrameId. Spike-verified per OOPIF plan.
      if (type != "iframe" || target_id.empty()) return;
      std::lock_guard<std::mutex> lk(view->oopif_sessions_mutex);
      view->oopif_sessions[target_id] = session_id;
    } else {
      std::string session_id = d->HasKey("sessionId") ? d->GetString("sessionId").ToString() : "";
      if (session_id.empty()) return;
      std::lock_guard<std::mutex> lk(view->oopif_sessions_mutex);
      for (auto it = view->oopif_sessions.begin(); it != view->oopif_sessions.end(); ) {
        if (it->second == session_id) it = view->oopif_sessions.erase(it);
        else ++it;
      }
    }
  }
  void OnDevToolsAgentDetached(CefRefPtr<CefBrowser>) override {
    // Pending method results are dropped by CEF on detach (browser crash,
    // process restart). Fire all callbacks with a failure result to prevent
    // hung promises in the TS layer.
    std::unordered_map<int, std::function<void(bool, std::string)>> orphans;
    {
      std::lock_guard<std::mutex> lk(g_cdp_cb_mutex);
      orphans.swap(g_cdp_callbacks);
    }
    for (auto& kv : orphans) kv.second(false, "{\"error\":\"devtools_agent_detached\"}");
  }
  IMPLEMENT_REFCOUNTING(BuniteDevToolsObserver);
};

CefRefPtr<CefDevToolsMessageObserver> getDevToolsObserver() {
  static CefRefPtr<CefDevToolsMessageObserver> obs = new BuniteDevToolsObserver();
  return obs;
}

// Raw-id space for SendDevToolsMessage (sessionId-routed calls). High range
// avoids collision with CEF's internal counter used by ExecuteDevToolsMethod.
std::atomic<int> g_raw_cdp_id_counter{0x40000000};
int nextRawCdpId() { return ++g_raw_cdp_id_counter; }

void cefSendRaw(ViewHost* v, const std::string& message, int id_for_cb,
                std::function<void(bool, std::string)> cb) {
  if (!v || !v->browser) { if (cb) cb(false, "{\"error\":\"view not ready\"}"); return; }
  if (cb) {
    std::lock_guard<std::mutex> lk(g_cdp_cb_mutex);
    g_cdp_callbacks[id_for_cb] = std::move(cb);
  }
  if (!v->browser->GetHost()->SendDevToolsMessage(message.data(), message.size())) {
    std::function<void(bool, std::string)> orphan;
    {
      std::lock_guard<std::mutex> lk(g_cdp_cb_mutex);
      auto it = g_cdp_callbacks.find(id_for_cb);
      if (it != g_cdp_callbacks.end()) { orphan = std::move(it->second); g_cdp_callbacks.erase(it); }
    }
    if (orphan) orphan(false, "{\"error\":\"SendDevToolsMessage failed\"}");
  }
}

void cefCdpCall(ViewHost* v, const std::string& method, const std::string& params_json,
                std::function<void(bool, std::string)> cb = nullptr) {
  if (!v || !v->browser) {
    if (cb) cb(false, "{}");
    return;
  }
  CefRefPtr<CefDictionaryValue> params;
  if (!params_json.empty()) {
    CefRefPtr<CefValue> val = CefParseJSON(params_json, JSON_PARSER_RFC);
    if (val && val->GetType() == VTYPE_DICTIONARY) params = val->GetDictionary();
  }
  if (!params) params = CefDictionaryValue::Create();
  // Register the callback under the *assigned* message id (ExecuteDevToolsMethod
  // returns it). We supply 0 to let CEF assign so our counter can't collide
  // with CEF's internal counter.
  const int assigned_id = v->browser->GetHost()->ExecuteDevToolsMethod(0, method, params);
  if (assigned_id == 0) {
    if (cb) cb(false, "{\"error\":\"ExecuteDevToolsMethod failed\"}");
    return;
  }
  if (cb) {
    std::lock_guard<std::mutex> lk(g_cdp_cb_mutex);
    g_cdp_callbacks[assigned_id] = std::move(cb);
  }
}

std::string wideToUtf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int bytes = WideCharToMultiByte(
    CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(bytes), '\0');
  WideCharToMultiByte(
    CP_UTF8, 0, value.data(), static_cast<int>(value.size()),
    out.data(), bytes, nullptr, nullptr);
  return out;
}

std::string resolveProcessHelperPath() {
  std::wstring buffer(MAX_PATH, L'\0');
  DWORD len = GetModuleFileNameW(
    bunite_win::getCurrentModuleHandle(),
    buffer.data(),
    static_cast<DWORD>(buffer.size()));
  while (len == buffer.size() && GetLastError() == ERROR_INSUFFICIENT_BUFFER) {
    buffer.resize(buffer.size() * 2);
    len = GetModuleFileNameW(
      bunite_win::getCurrentModuleHandle(),
      buffer.data(),
      static_cast<DWORD>(buffer.size()));
  }
  buffer.resize(len);

  std::filesystem::path dll_path(buffer);
  std::filesystem::path helper_path = dll_path.parent_path() / L"process_helper.exe";
  if (!std::filesystem::exists(helper_path)) {
    BUNITE_ERROR("process_helper.exe not found alongside libBuniteNative.dll at: %s",
                 helper_path.string().c_str());
    return {};
  }
  return wideToUtf8(helper_path.wstring());
}

} // namespace

namespace bunite_win {
void registerCdpObserverForView(ViewHost* view) {
  if (!view || !view->browser) return;
  view->devtools_registration =
      view->browser->GetHost()->AddDevToolsMessageObserver(getDevToolsObserver());
}

void respondToDialogRequest(ViewHost* view, uint32_t request_id,
                            bool accept, const std::string& text) {
  if (!view) return;
  auto it = view->pending_dialogs.find(request_id);
  if (it == view->pending_dialogs.end()) return;
  CefRefPtr<CefJSDialogCallback> cb = std::move(it->second);
  view->pending_dialogs.erase(it);
  if (cb) cb->Continue(accept, text);
}
}  // namespace bunite_win

extern "C" BUNITE_EXPORT int32_t bunite_abi_version(void) {
  return BUNITE_ABI_VERSION;
}

extern "C" BUNITE_EXPORT const char* bunite_engine_name(void) {
  return "cef";
}

extern "C" BUNITE_EXPORT const char* bunite_engine_version(void) {
  // Prefer runtime libcef.dll version — same-major fallback may load a different CEF than headers. Compile-time before init.
  static std::string cached;
  static std::once_flag once;
  std::call_once(once, []() {
    if (g_runtime.cef_initialized) {
      char buf[128];
      std::snprintf(buf, sizeof(buf), "%d.%d.%d+chromium-%d.%d.%d.%d",
        cef_version_info(0), cef_version_info(1), cef_version_info(2),
        cef_version_info(4), cef_version_info(5), cef_version_info(6),
        cef_version_info(7));
      cached = buf;
    } else {
      cached = CEF_VERSION;
    }
  });
  return cached.c_str();
}

extern "C" BUNITE_EXPORT void bunite_set_log_level(int32_t level) {
  buniteSetLogLevel(static_cast<BuniteLogLevel>(level));
}

// See webview2_runtime.cpp `reapChildrenOnExit`. Same rationale for process_helper.
static void reapChildrenOnExit() {
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) return;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION info{};
  info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info, sizeof(info)) ||
      !AssignProcessToJobObject(job, GetCurrentProcess())) {
    CloseHandle(job);
  }
}

extern "C" BUNITE_EXPORT bool bunite_init(
  const char* cef_dir,
  bool hide_console,
  bool popup_blocking,
  const char* engine_config_json
) {
  buniteApplyEnvLogLevel();
  reapChildrenOnExit();
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
    g_runtime.process_helper_path = resolveProcessHelperPath();
    g_runtime.cef_dir = cef_dir ? cef_dir : "";
    g_runtime.popup_blocking = popup_blocking;
    g_runtime.chromium_flags = bunite_win::parseChromiumFlagsJson(
      engine_config_json ? engine_config_json : "");
  }

  if (hide_console) {
    if (HWND console = GetConsoleWindow()) {
      ShowWindow(console, SW_HIDE);
    }
  }

  g_runtime.ui_thread = std::thread(bunite_win::uiThreadMain);

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

extern "C" BUNITE_EXPORT void bunite_pump_once(void) {
  // No-op (dedicated UI thread). ABI parity with mac/linux cooperative pumps.
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

  bunite_win::postCefUiTask([]() {
    bunite_win::cancelPendingPermissionRequestsOnUiThread();
    bunite_win::cancelPendingRouteRequestsOnUiThread();
  });

  runOnUiThreadSync<void>([]() {
    bunite_win::closeAllWindowsForShutdown();
  });

  bunite_win::postCefUiTask([]() {
    bunite_win::maybeCompleteShutdownOnUiThread();
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
      bunite_win::utf8ToWide(title ? title : ""),
      bunite_win::utf8ToWide(title_bar_style ? title_bar_style : ""),
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
      bunite_win::makeWindowStyle(window->title_bar_style),
      static_cast<int>(x),
      static_cast<int>(y),
      static_cast<int>(std::max(width, 100.0)),
      static_cast<int>(std::max(height, 100.0)),
      nullptr,
      nullptr,
      bunite_win::getCurrentModuleHandle(),
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
    auto* window = bunite_win::getWindowHostById(window_id);
    bunite_win::destroyWindowHost(window);
  });
}

extern "C" BUNITE_EXPORT void bunite_window_reset_close_pending(uint32_t window_id) {
  runOnUiThreadSync<void>([window_id]() {
    auto* window = bunite_win::getWindowHostById(window_id);
    if (window) {
      window->close_pending.store(false);
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_window_show(uint32_t window_id) {
  runOnUiThreadSync<void>([window_id]() {
    auto* window = bunite_win::getWindowHostById(window_id);
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
    auto* window = bunite_win::getWindowHostById(window_id);
    if (!window || !window->hwnd) {
      return;
    }
    SendMessageW(window->hwnd, WM_CLOSE, 0, 0);
  });
}

extern "C" BUNITE_EXPORT void bunite_window_set_title(uint32_t window_id, const char* title) {
  runOnUiThreadSync<void>([window_id, value = std::string(title ? title : "")]() {
    auto* window = bunite_win::getWindowHostById(window_id);
    if (!window || !window->hwnd) {
      return;
    }
    window->title = bunite_win::utf8ToWide(value);
    SetWindowTextW(window->hwnd, window->title.c_str());
  });
}

extern "C" BUNITE_EXPORT void bunite_window_minimize(uint32_t window_id) {
  runOnUiThreadSync<void>([window_id]() {
    auto* window = bunite_win::getWindowHostById(window_id);
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
    auto* window = bunite_win::getWindowHostById(window_id);
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
    auto* window = bunite_win::getWindowHostById(window_id);
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
    auto* window = bunite_win::getWindowHostById(window_id);
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
    auto* window = bunite_win::getWindowHostById(window_id);
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
    auto* window = bunite_win::getWindowHostById(window_id);
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
    auto* window = bunite_win::getWindowHostById(window_id);
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

extern "C" BUNITE_EXPORT void bunite_window_begin_move_drag(uint32_t window_id) {
  // CEF runs Bun on a separate thread, so WM_NCLBUTTONDOWN's modal move loop
  // doesn't freeze JS — keep the OS-native drag (Win11 snap/aero-shake). Post
  // to the HWND-owning Win32 UI thread (ReleaseCapture + the loop are
  // thread-local there).
  bunite_win::postUiTask([window_id]() {
    auto* window = bunite_win::getWindowHostById(window_id);
    if (!window || !window->hwnd) return;
    ReleaseCapture();
    SendMessageW(window->hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0);
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
  bool sandbox,
  const char* preload_origins_json
) {
  auto origins = bunite_win::parseNavigationRulesJson(preload_origins_json ? preload_origins_json : "");

  return runOnUiThreadSync<bool>([=, origins = std::move(origins)]() -> bool {
    auto* window = bunite_win::getWindowHostById(window_id);
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
      bunite_win::parseNavigationRulesJson(navigation_rules_json ? navigation_rules_json : ""),
      auto_resize ? static_cast<int>(ViewAnchorMode::Fill) : static_cast<int>(ViewAnchorMode::None),
      0.0,
      sandbox,
      origins
    };

    {
      std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
      g_runtime.views_by_id[view_id] = view;
      window->views.push_back(view);
    }

    if (!bunite_win::createBrowserForView(view)) {
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

extern "C" BUNITE_EXPORT void bunite_view_execute_javascript(uint32_t view_id, const char* script) {
  bunite_win::postCefUiTask([view_id, code = std::string(script ? script : "")]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view || !view->browser || !view->browser->GetMainFrame()) {
      return;
    }
    view->browser->GetMainFrame()->ExecuteJavaScript(
      code, view->browser->GetMainFrame()->GetURL(), 0
    );
  });
}

extern "C" BUNITE_EXPORT void bunite_view_evaluate(uint32_t view_id, uint32_t request_id, const char* script) {
  bunite_win::postCefUiTask([view_id, request_id, code = std::string(script ? script : "")]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view || !view->browser || !view->browser->GetMainFrame()) {
      std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                            ",\"ok\":false,\"code\":\"not_supported\","
                            "\"message\":\"view not ready\"}";
      bunite_win::emitWebviewEvent(view_id, "evaluate-result", payload);
      return;
    }
    auto message = CefProcessMessage::Create("bunite.evaluate.request");
    auto args = message->GetArgumentList();
    args->SetInt(0, static_cast<int>(request_id));
    args->SetString(1, code);
    view->browser->GetMainFrame()->SendProcessMessage(PID_RENDERER, message);
  });
}

extern "C" BUNITE_EXPORT void bunite_view_load_url(uint32_t view_id, const char* url) {
  bunite_win::postCefUiTask([view_id, next_url = std::string(url ? url : "")]() {
    auto* view = bunite_win::getViewHostById(view_id);
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
  bunite_win::postCefUiTask([view_id, content = std::string(html ? html : "")]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view) {
      return;
    }

    view->html = content;
    bunite::WebviewContentStorage::instance().set(view->id, content);
    if (view->browser && view->browser->GetMainFrame()) {
      view->browser->GetMainFrame()->LoadURL("appres://app.internal/internal/index.html");
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_set_visible(uint32_t view_id, bool visible) {
  runOnUiThreadSync<void>([view_id, visible]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view) {
      return;
    }
    auto browser = view->browser;
    if (!browser) {
      view->pending_visible = visible;
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
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view) {
      return;
    }
    auto browser = view->browser;
    if (!browser) {
      view->pending_bring_to_front = true;
      return;
    }
    HWND browser_hwnd = browser->GetHost()->GetWindowHandle();
    if (browser_hwnd) {
      SetWindowPos(browser_hwnd, HWND_TOP, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_set_mask_region(
  uint32_t view_id,
  const double* rects,
  uint32_t count
) {
  std::vector<RECT> mask_rects;
  mask_rects.reserve(count);
  for (uint32_t i = 0; i < count; i++) {
    const double* r = rects + i * 4;
    mask_rects.push_back(RECT{
      static_cast<LONG>(r[0]),
      static_cast<LONG>(r[1]),
      static_cast<LONG>(r[0] + r[2]),
      static_cast<LONG>(r[1] + r[3])
    });
  }

  runOnUiThreadSync<void>([view_id, mask_rects = std::move(mask_rects)]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view) return;
    auto browser = view->browser;
    if (!browser) return;
    HWND hwnd = browser->GetHost()->GetWindowHandle();
    if (!hwnd) return;

    // Helper: apply region to a window and all its descendants
    auto applyRegionToTree = [](HWND root, HRGN rgn) {
      EnumChildWindows(root, [](HWND child, LPARAM lParam) -> BOOL {
        HRGN src = reinterpret_cast<HRGN>(lParam);
        RECT childRect;
        GetWindowRect(child, &childRect);
        HWND parent = GetParent(child);
        POINT offset = { childRect.left, childRect.top };
        if (parent) ScreenToClient(parent, &offset);
        HRGN copy = CreateRectRgn(0, 0, 0, 0);
        CombineRgn(copy, src, nullptr, RGN_COPY);
        OffsetRgn(copy, -offset.x, -offset.y);
        if (!SetWindowRgn(child, copy, TRUE)) {
          DeleteObject(copy);
        }
        return TRUE;
      }, reinterpret_cast<LPARAM>(rgn));
      if (!SetWindowRgn(root, rgn, TRUE)) {
        DeleteObject(rgn);
      }
    };

    if (mask_rects.empty()) {
      // Clear region — restore full window
      SetWindowRgn(hwnd, nullptr, TRUE);
      EnumChildWindows(hwnd, [](HWND child, LPARAM) -> BOOL {
        SetWindowRgn(child, nullptr, TRUE);
        return TRUE;
      }, 0);
      return;
    }

    // Start with the full window rect
    RECT wr;
    GetClientRect(hwnd, &wr);
    HRGN full = CreateRectRgnIndirect(&wr);

    // Subtract each mask rect (punch holes)
    for (const auto& mr : mask_rects) {
      RECT surface_relative = {
        mr.left - view->bounds.left,
        mr.top - view->bounds.top,
        mr.right - view->bounds.left,
        mr.bottom - view->bounds.top
      };
      HRGN hole = CreateRectRgnIndirect(&surface_relative);
      CombineRgn(full, full, hole, RGN_DIFF);
      DeleteObject(hole);
    }

    applyRegionToTree(hwnd, full);
  });
}

extern "C" BUNITE_EXPORT void bunite_view_set_input_passthrough(uint32_t view_id, bool passthrough) {
  runOnUiThreadSync<void>([view_id, passthrough]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view) return;
    view->pending_passthrough = passthrough;
    auto browser = view->browser;
    if (!browser) return;
    HWND hwnd = browser->GetHost()->GetWindowHandle();
    if (!hwnd) return;
    EnableWindow(hwnd, passthrough ? FALSE : TRUE);
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
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view) {
      return;
    }
    const RECT new_bounds = RECT{
      static_cast<LONG>(x),
      static_cast<LONG>(y),
      static_cast<LONG>(x + width),
      static_cast<LONG>(y + height)
    };
    auto browser = view->browser;
    if (!browser) {
      view->has_pending_bounds = true;
      view->pending_bounds = new_bounds;
      view->anchor_mode = static_cast<int>(ViewAnchorMode::None);
      return;
    }
    view->anchor_mode = static_cast<int>(ViewAnchorMode::None);
    view->bounds = new_bounds;
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

extern "C" BUNITE_EXPORT void bunite_view_set_bounds_async(
  uint32_t view_id,
  double x,
  double y,
  double width,
  double height
) {
  bunite_win::postUiTask([view_id, x, y, width, height]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view) {
      return;
    }
    const RECT new_bounds = RECT{
      static_cast<LONG>(x),
      static_cast<LONG>(y),
      static_cast<LONG>(x + width),
      static_cast<LONG>(y + height)
    };
    auto browser = view->browser;
    if (!browser) {
      view->has_pending_bounds = true;
      view->pending_bounds = new_bounds;
      view->anchor_mode = static_cast<int>(ViewAnchorMode::None);
      return;
    }
    view->anchor_mode = static_cast<int>(ViewAnchorMode::None);
    view->bounds = new_bounds;
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

  if (pending.callback) {
    pending.callback->Continue();
  }
}

extern "C" BUNITE_EXPORT void bunite_view_set_anchor(uint32_t view_id, int mode, double inset) {
  runOnUiThreadSync<void>([view_id, mode, inset]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view) {
      return;
    }
    view->anchor_mode = mode;
    view->anchor_inset = inset;
    bunite_win::resizeViewToFit(view);
  });
}

extern "C" BUNITE_EXPORT void bunite_view_go_back(uint32_t view_id) {
  bunite_win::postCefUiTask([view_id]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (view && view->browser) {
      view->browser->GoBack();
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_reload(uint32_t view_id) {
  bunite_win::postCefUiTask([view_id]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (view && view->browser) {
      view->browser->Reload();
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_remove(uint32_t view_id) {
  bunite_win::postCefUiTask([view_id]() { bunite_win::closeViewHost(bunite_win::getViewHostById(view_id)); });
}

// Input dispatch — native CEF API. Real OS-input path → MouseEvent.isTrusted = true.
namespace {

// Local names — `MOD_ALT`/`MOD_SHIFT` are Win32 RegisterHotKey macros.
constexpr uint32_t kBmodAlt = 1, kBmodCtrl = 2, kBmodMeta = 4, kBmodShift = 8;

uint32_t cefModifiers(uint32_t bits) {
  uint32_t flags = 0;
  if (bits & kBmodShift) flags |= EVENTFLAG_SHIFT_DOWN;
  if (bits & kBmodCtrl)  flags |= EVENTFLAG_CONTROL_DOWN;
  if (bits & kBmodAlt)   flags |= EVENTFLAG_ALT_DOWN;
  if (bits & kBmodMeta)  flags |= EVENTFLAG_COMMAND_DOWN;
  return flags;
}

cef_mouse_button_type_t cefButton(int32_t b) {
  switch (b) { case 1: return MBT_MIDDLE; case 2: return MBT_RIGHT; default: return MBT_LEFT; }
}

}  // namespace

extern "C" BUNITE_EXPORT void bunite_view_click(uint32_t view_id, double x, double y,
                                                  int32_t button, int32_t click_count, uint32_t modifiers) {
  if (click_count < 1) click_count = 1;
  bunite_win::postCefUiTask([view_id, x, y, button, click_count, modifiers]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view || !view->browser) return;
    auto host = view->browser->GetHost();
    if (!host) return;
    CefMouseEvent ev{};
    ev.x = static_cast<int>(x);
    ev.y = static_cast<int>(y);
    ev.modifiers = cefModifiers(modifiers);
    // Multi-click → repeated pairs with increasing clickCount so the page sees dblclick.
    for (int i = 1; i <= click_count; ++i) {
      host->SendMouseClickEvent(ev, cefButton(button), /*mouseUp=*/false, i);
      host->SendMouseClickEvent(ev, cefButton(button), /*mouseUp=*/true, i);
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_type(uint32_t view_id, const char* text) {
  std::string s = text ? text : "";
  bunite_win::postCefUiTask([view_id, s]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view || !view->browser) return;
    auto host = view->browser->GetHost();
    if (!host) return;
    std::wstring wide(s.size(), 0);
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                                wide.data(), static_cast<int>(wide.size()));
    wide.resize(n);
    // Per character: RAWKEYDOWN + CHAR + KEYUP. CHAR-only doesn't trigger the
    // DOM `input` event on text fields — Chromium expects a paired key cycle.
    // BMP only (surrogate pairs would mis-fire `keypress` twice).
    for (size_t i = 0; i < wide.size(); ++i) {
      wchar_t ch = wide[i];
      if (ch >= 0xD800 && ch <= 0xDBFF) {
        static bool warned = false;
        if (!warned) { warned = true; BUNITE_WARN("cef type: supplementary-plane codepoint skipped"); }
        if (i + 1 < wide.size()) ++i;
        continue;
      }
      const int vk = (ch >= 'a' && ch <= 'z') ? (ch - ('a' - 'A'))  // letters map to upper VK
                    : (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') ? ch
                    : 0;
      CefKeyEvent down{};
      down.type = KEYEVENT_RAWKEYDOWN;
      down.windows_key_code = vk ? vk : ch;
      down.character = ch;
      down.unmodified_character = ch;
      host->SendKeyEvent(down);
      CefKeyEvent c{};
      c.type = KEYEVENT_CHAR;
      c.windows_key_code = ch;
      c.character = ch;
      c.unmodified_character = ch;
      host->SendKeyEvent(c);
      CefKeyEvent up{};
      up.type = KEYEVENT_KEYUP;
      up.windows_key_code = vk ? vk : ch;
      up.character = ch;
      up.unmodified_character = ch;
      host->SendKeyEvent(up);
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_press(uint32_t view_id, int32_t windows_vk_code,
                                                  int32_t /*mac_key_code*/,
                                                  const char* /*key*/, const char* /*code*/,
                                                  const char* character, uint32_t modifiers,
                                                  int32_t action, bool extended, int32_t /*location*/) {
  std::string char_str = character ? character : "";
  bunite_win::postCefUiTask([view_id, windows_vk_code, char_str, modifiers, action, extended]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view || !view->browser) return;
    auto host = view->browser->GetHost();
    if (!host) return;
    uint32_t mod = cefModifiers(modifiers);
    // Chromium's KeycodeConverter::NativeKeycodeToDomCode expects raw scancode
    // with 0xE0 prefix when extended (see chromium ui/events dom_code_data.inc).
    // Not LPARAM — Chromium's Win backend keys off scancode|(extended ? 0xE000 : 0).
    UINT scancode = windows_vk_code ? MapVirtualKeyW(static_cast<UINT>(windows_vk_code), MAPVK_VK_TO_VSC) : 0;
    int32_t native = static_cast<int32_t>(extended ? (0xE000u | scancode) : scancode);

    if (action != 1 && windows_vk_code != 0) {
      CefKeyEvent down{};
      down.type = KEYEVENT_RAWKEYDOWN;
      down.windows_key_code = windows_vk_code;
      down.native_key_code = native;
      down.modifiers = mod;
      host->SendKeyEvent(down);
    }
    // CHAR rides with the down half (Playwright convention) — emitted only
    // when we're sending the down (action=both or down).
    if (action != 1 && !char_str.empty()) {
      std::wstring wide(char_str.size(), 0);
      int n = MultiByteToWideChar(CP_UTF8, 0, char_str.c_str(), static_cast<int>(char_str.size()),
                                  wide.data(), static_cast<int>(wide.size()));
      wide.resize(n);
      for (size_t i = 0; i < wide.size(); ++i) {
        wchar_t ch = wide[i];
        if (ch >= 0xD800 && ch <= 0xDBFF) {
          if (i + 1 < wide.size()) ++i;
          continue;
        }
        CefKeyEvent ce{};
        ce.type = KEYEVENT_CHAR;
        ce.character = ch;
        ce.unmodified_character = ch;
        ce.windows_key_code = ch;
        ce.modifiers = mod;
        host->SendKeyEvent(ce);
      }
    }
    if (action != 0 && windows_vk_code != 0) {
      CefKeyEvent up{};
      up.type = KEYEVENT_KEYUP;
      up.windows_key_code = windows_vk_code;
      up.native_key_code = native;
      up.modifiers = mod;
      host->SendKeyEvent(up);
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_scroll(uint32_t view_id, double dx, double dy,
                                                   double x, double y, uint32_t modifiers) {
  bunite_win::postCefUiTask([view_id, dx, dy, x, y, modifiers]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view) return;
    // CDP path — native SendMouseWheelEvent doesn't reach the page in
    // windowed CEF. deltaY is CSS pixels, matching WV2.
    std::string params =
      "{\"type\":\"mouseWheel\""
      ",\"x\":" + std::to_string(x) +
      ",\"y\":" + std::to_string(y) +
      ",\"deltaX\":" + std::to_string(dx) +
      ",\"deltaY\":" + std::to_string(dy) +
      ",\"modifiers\":" + std::to_string(modifiers) + "}";
    cefCdpCall(view, "Input.dispatchMouseEvent", params);
  });
}

extern "C" BUNITE_EXPORT void bunite_view_mouse(uint32_t view_id, int32_t action,
                                                  double x, double y, int32_t button,
                                                  uint32_t modifiers) {
  bunite_win::postCefUiTask([view_id, action, x, y, button, modifiers]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view || !view->browser) return;
    auto host = view->browser->GetHost();
    if (!host) return;
    CefMouseEvent ev{};
    ev.x = static_cast<int>(x);
    ev.y = static_cast<int>(y);
    ev.modifiers = cefModifiers(modifiers);
    if (action == 0) {
      // move
      host->SendMouseMoveEvent(ev, /*mouseLeave=*/false);
    } else {
      // down (1) / up (2)
      CefBrowserHost::MouseButtonType btn = (button == 2) ? MBT_RIGHT
                                          : (button == 1) ? MBT_MIDDLE : MBT_LEFT;
      host->SendMouseClickEvent(ev, btn, /*mouseUp=*/action == 2, /*clickCount=*/1);
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_respond_dialog(uint32_t view_id, uint32_t request_id,
                                                          bool accept, const char* text) {
  std::string text_str = text ? text : "";
  bunite_win::postCefUiTask([view_id, request_id, accept, text_str]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view) return;
    bunite_win::respondToDialogRequest(view, request_id, accept, text_str);
  });
}

namespace {

void emitScreenshotError(uint32_t view_id, uint32_t request_id, const char* code, const std::string& msg) {
  std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                        ",\"ok\":false,\"code\":\"" + code + "\","
                        "\"message\":\"" + bunite_win::escapeJsonString(msg) + "\"}";
  bunite_win::emitWebviewEvent(view_id, "screenshot-result", payload);
}

}  // namespace

extern "C" BUNITE_EXPORT uint32_t bunite_view_capabilities(uint32_t view_id) {
  // CEF — click/type/press are native (isTrusted=true); scroll and
  // screenshot go via CDP (windowed SendMouseWheelEvent doesn't reach the
  // page, and Page.captureScreenshot is compositor-aware vs PrintWindow's
  // black-frame trap).
  auto* view = bunite_win::getViewHostById(view_id);
  if (!view) return 0;
  return BUNITE_CAP_EVALUATE | BUNITE_CAP_SURFACE_EVENTS |
         BUNITE_CAP_NATIVE_INPUT_TRUSTED |
         BUNITE_CAP_CLICK | BUNITE_CAP_TYPE | BUNITE_CAP_PRESS | BUNITE_CAP_SCROLL |
         BUNITE_CAP_MOUSE | BUNITE_CAP_DIALOGS | BUNITE_CAP_CONSOLE |
         BUNITE_CAP_SCREENSHOT | BUNITE_CAP_FORMAT_PNG | BUNITE_CAP_FORMAT_JPEG |
         BUNITE_CAP_AX | BUNITE_CAP_BOUNDING_RECT | BUNITE_CAP_FRAMES |
         BUNITE_CAP_DOWNLOADS | BUNITE_CAP_POPUPS |
         BUNITE_CAP_RESOLVE_AND_CLICK;
}

extern "C" BUNITE_EXPORT void bunite_view_set_download_policy(uint32_t view_id, int32_t policy, const char* download_dir) {
  bunite_win::postCefUiTask([view_id, policy, dir = std::string(download_dir ? download_dir : "")]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view) return;
    int32_t p = policy;
    if (p < 0 || p > 2) p = 2;
    view->download_policy.store(p);
    view->download_dir = dir;
  });
}

namespace bunite_win {

void applyPopupAccept(ViewHost* view, uint32_t host_window_id, double x, double y, double w, double h) {
  if (!view || !view->browser) return;
  auto* host = getWindowHostById(host_window_id);
  if (!host || !host->hwnd) return;
  view->window = host;
  view->is_popup_pending = false;
  host->views.push_back(view);
  HWND browser_hwnd = view->browser->GetHost()->GetWindowHandle();
  if (browser_hwnd) {
    SetParent(browser_hwnd, host->hwnd);
    SetWindowPos(browser_hwnd, HWND_TOP,
      static_cast<int>(x), static_cast<int>(y),
      static_cast<int>(w), static_cast<int>(h),
      SWP_SHOWWINDOW | SWP_NOACTIVATE);
    view->bounds = RECT{
      static_cast<LONG>(x), static_cast<LONG>(y),
      static_cast<LONG>(x + w), static_cast<LONG>(y + h)
    };
  }
  // Re-emit view-ready so the TS-side BrowserView.adopt resolves its
  // `_readyPromise` (the original view-ready from OnAfterCreated fired before
  // the TS resolver was registered).
  emitWebviewEvent(view->id, "view-ready", "");
}

}  // namespace bunite_win

extern "C" BUNITE_EXPORT void bunite_view_popup_accept(uint32_t new_view_id, uint32_t host_window_id,
                                                       double x, double y, double w, double h) {
  bunite_win::postCefUiTask([new_view_id, host_window_id, x, y, w, h]() {
    auto* view = bunite_win::getViewHostById(new_view_id);
    if (!view) return;
    if (!view->browser) {
      // OnAfterCreated hasn't fired yet; stash the accept and apply when it does.
      view->pending_popup_accept = ViewHost::PendingPopupAccept{host_window_id, x, y, w, h};
      return;
    }
    bunite_win::applyPopupAccept(view, host_window_id, x, y, w, h);
  });
}

extern "C" BUNITE_EXPORT void bunite_view_popup_dismiss(uint32_t new_view_id) {
  bunite_win::postCefUiTask([new_view_id]() {
    auto* view = bunite_win::getViewHostById(new_view_id);
    if (!view) return;
    if (!view->is_popup_pending && view->window) return;  // already adopted — caller responsibility, ignore.
    if (view->browser) {
      view->closing.store(true);
      view->browser->GetHost()->CloseBrowser(true);
    } else {
      // Browser not yet created — let OnAfterCreated handle dismissal.
      view->popup_dismiss_requested = true;
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_screenshot(uint32_t view_id, uint32_t request_id,
                                                       const char* format, int32_t quality) {
  std::string fmt = format ? format : "png";
  bunite_win::postCefUiTask([view_id, request_id, fmt, quality]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view) {
      emitScreenshotError(view_id, request_id, "not_supported", "view not ready");
      return;
    }
    const bool jpeg = (fmt == "jpeg" || fmt == "jpg");
    const std::string outFmt = jpeg ? "jpeg" : "png";
    const std::string mime = jpeg ? "image/jpeg" : "image/png";
    std::string params = "{\"format\":\"" + outFmt + "\"";
    if (jpeg && quality >= 0) params += ",\"quality\":" + std::to_string(quality);
    params += "}";
    cefCdpCall(view, "Page.captureScreenshot", params,
        [view_id, request_id, outFmt, mime](bool ok, std::string result) {
          if (!ok) {
            emitScreenshotError(view_id, request_id, "runtime_error",
                                std::string("Page.captureScreenshot failed: ") + result);
            return;
          }
          CefRefPtr<CefValue> val = CefParseJSON(result, JSON_PARSER_RFC);
          if (!val || val->GetType() != VTYPE_DICTIONARY) {
            emitScreenshotError(view_id, request_id, "runtime_error", "captureScreenshot malformed result");
            return;
          }
          CefString data = val->GetDictionary()->GetString("data");
          if (data.empty()) {
            emitScreenshotError(view_id, request_id, "runtime_error", "captureScreenshot missing data");
            return;
          }
          std::string b64 = data.ToString();
          std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                                ",\"ok\":true,\"format\":\"" + outFmt +
                                "\",\"mime\":\"" + mime +
                                "\",\"dataBase64\":\"" + b64 + "\"}";
          bunite_win::emitWebviewEvent(view_id, "screenshot-result", payload);
        });
  });
}

static void emitAxError(uint32_t view_id, uint32_t request_id, const char* code, const std::string& message) {
  std::string esc; esc.reserve(message.size());
  for (char c : message) {
    if (c == '"' || c == '\\') { esc.push_back('\\'); esc.push_back(c); }
    else if (c == '\n') esc += "\\n";
    else if (c == '\r') esc += "\\r";
    else if (c == '\t') esc += "\\t";
    else esc.push_back(c);
  }
  std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                        ",\"ok\":false,\"code\":\"" + code +
                        "\",\"message\":\"" + esc + "\"}";
  bunite_win::emitWebviewEvent(view_id, "accessibility-result", payload);
}

extern "C" BUNITE_EXPORT void bunite_view_accessibility_snapshot(uint32_t view_id, uint32_t request_id,
                                                                  int32_t /*interesting_only*/) {
  // CDP `Accessibility.getFullAXTree` takes `depth`/`frameId` only; the
  // interesting-only filter is applied TS-side on the flat node list.
  bunite_win::postCefUiTask([view_id, request_id]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view) { emitAxError(view_id, request_id, "not_supported", "view not ready"); return; }
    cefCdpCall(view, "Accessibility.getFullAXTree", "{}",
        [view_id, request_id](bool ok, std::string result) {
          if (!ok) { emitAxError(view_id, request_id, "runtime_error", "getFullAXTree failed: " + result); return; }
          std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                                ",\"ok\":true,\"tree\":" + result + "}";
          bunite_win::emitWebviewEvent(view_id, "accessibility-result", payload);
        });
  });
}

static void emitListFramesError(uint32_t view_id, uint32_t request_id, const char* code, const std::string& message) {
  std::string esc; esc.reserve(message.size());
  for (char c : message) {
    if (c == '"' || c == '\\') { esc.push_back('\\'); esc.push_back(c); }
    else esc.push_back(c);
  }
  std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                        ",\"ok\":false,\"code\":\"" + code +
                        "\",\"message\":\"" + esc + "\"}";
  bunite_win::emitWebviewEvent(view_id, "list-frames-result", payload);
}

extern "C" BUNITE_EXPORT void bunite_view_list_frames(uint32_t view_id, uint32_t request_id) {
  bunite_win::postCefUiTask([view_id, request_id]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view) { emitListFramesError(view_id, request_id, "not_supported", "view not ready"); return; }
    cefCdpCall(view, "Page.getFrameTree", "{}",
        [view_id, request_id](bool ok, std::string result) {
          if (!ok) { emitListFramesError(view_id, request_id, "runtime_error", "getFrameTree failed: " + result); return; }
          // Raw CDP `{frameTree:{frame,childFrames}}` — TS flattens.
          std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                                ",\"ok\":true,\"raw\":" + result + "}";
          bunite_win::emitWebviewEvent(view_id, "list-frames-result", payload);
        });
  });
}

extern "C" BUNITE_EXPORT void bunite_view_evaluate_in_frame(uint32_t view_id, uint32_t request_id,
                                                              const char* script_c, const char* frame_id_c) {
  std::string script = script_c ? script_c : "";
  std::string frameId = frame_id_c ? frame_id_c : "";
  if (frameId.empty()) {
    bunite_view_evaluate(view_id, request_id, script_c);
    return;
  }
  bunite_win::postCefUiTask([view_id, request_id, script, frameId]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view) {
      std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                            ",\"ok\":false,\"code\":\"not_supported\",\"message\":\"view not ready\"}";
      bunite_win::emitWebviewEvent(view_id, "evaluate-result", payload);
      return;
    }
    // Step 1: create an isolated world in the target frame.
    std::string isoParams = "{\"frameId\":\"" + bunite_win::escapeJsonString(frameId) + "\",\"worldName\":\"bunite-eval\"}";
    cefCdpCall(view, "Page.createIsolatedWorld", isoParams,
        [view_id, request_id, script](bool ok, std::string isoResult) {
          if (!ok) {
            std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                                  ",\"ok\":false,\"code\":\"runtime_error\","
                                  "\"message\":\"createIsolatedWorld failed\"}";
            bunite_win::emitWebviewEvent(view_id, "evaluate-result", payload);
            return;
          }
          CefRefPtr<CefValue> val = CefParseJSON(isoResult, JSON_PARSER_RFC);
          if (!val || val->GetType() != VTYPE_DICTIONARY) {
            std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                                  ",\"ok\":false,\"code\":\"runtime_error\","
                                  "\"message\":\"createIsolatedWorld malformed\"}";
            bunite_win::emitWebviewEvent(view_id, "evaluate-result", payload);
            return;
          }
          int contextId = val->GetDictionary()->GetInt("executionContextId");
          // Re-lookup view — async gap may have destroyed it.
          auto* view2 = bunite_win::getViewHostById(view_id);
          if (!view2) {
            std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                                  ",\"ok\":false,\"code\":\"not_supported\","
                                  "\"message\":\"view destroyed\"}";
            bunite_win::emitWebviewEvent(view_id, "evaluate-result", payload);
            return;
          }
          // Step 2: Runtime.evaluate in that context.
          std::string escScript; escScript.reserve(script.size());
          for (char c : script) {
            if (c == '"' || c == '\\') { escScript.push_back('\\'); escScript.push_back(c); }
            else if (c == '\n') escScript += "\\n";
            else if (c == '\r') escScript += "\\r";
            else if (c == '\t') escScript += "\\t";
            else escScript.push_back(c);
          }
          std::string evalParams = "{\"expression\":\"" + escScript +
                                   "\",\"contextId\":" + std::to_string(contextId) +
                                   ",\"returnByValue\":true,\"awaitPromise\":true}";
          cefCdpCall(view2, "Runtime.evaluate", evalParams,
              [view_id, request_id](bool ok2, std::string evalResult) {
                if (!ok2) {
                  std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                                        ",\"ok\":false,\"code\":\"runtime_error\","
                                        "\"message\":\"Runtime.evaluate failed\"}";
                  bunite_win::emitWebviewEvent(view_id, "evaluate-result", payload);
                  return;
                }
                CefRefPtr<CefValue> ev = CefParseJSON(evalResult, JSON_PARSER_RFC);
                if (!ev || ev->GetType() != VTYPE_DICTIONARY) {
                  std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                                        ",\"ok\":false,\"code\":\"runtime_error\","
                                        "\"message\":\"Runtime.evaluate malformed\"}";
                  bunite_win::emitWebviewEvent(view_id, "evaluate-result", payload);
                  return;
                }
                CefRefPtr<CefDictionaryValue> d = ev->GetDictionary();
                if (d->HasKey("exceptionDetails")) {
                  CefRefPtr<CefDictionaryValue> ex = d->GetDictionary("exceptionDetails");
                  std::string msg = ex && ex->HasKey("text") ? ex->GetString("text").ToString() : "runtime exception";
                  std::string escMsg; escMsg.reserve(msg.size());
                  for (char c : msg) {
                    if (c == '"' || c == '\\') { escMsg.push_back('\\'); escMsg.push_back(c); }
                    else escMsg.push_back(c);
                  }
                  std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                                        ",\"ok\":false,\"code\":\"runtime_error\","
                                        "\"message\":\"" + escMsg + "\"}";
                  bunite_win::emitWebviewEvent(view_id, "evaluate-result", payload);
                  return;
                }
                // result.value (JSON-serialized into "value") -> stringify.
                CefRefPtr<CefDictionaryValue> result = d->GetDictionary("result");
                std::string valueJson = "null";
                if (result && result->HasKey("value")) {
                  CefRefPtr<CefValue> v = result->GetValue("value");
                  if (v) valueJson = CefWriteJSON(v, JSON_WRITER_DEFAULT);
                }
                // The host expects "value" to be a JSON STRING (it re-parses).
                std::string escVal; escVal.reserve(valueJson.size());
                for (char c : valueJson) {
                  if (c == '"' || c == '\\') { escVal.push_back('\\'); escVal.push_back(c); }
                  else if (c == '\n') escVal += "\\n";
                  else if (c == '\r') escVal += "\\r";
                  else if (c == '\t') escVal += "\\t";
                  else escVal.push_back(c);
                }
                std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                                      ",\"ok\":true,\"value\":\"" + escVal + "\"}";
                bunite_win::emitWebviewEvent(view_id, "evaluate-result", payload);
              });
        });
  });
}

namespace {

void emitResolveAndClickError(uint32_t view_id, uint32_t request_id, const char* code, const std::string& msg) {
  std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                        ",\"ok\":false,\"code\":\"" + code + "\","
                        "\"message\":\"" + bunite_win::escapeJsonString(msg) + "\"}";
  bunite_win::emitWebviewEvent(view_id, "resolve-and-click-result", payload);
}

const char* cdpButtonName(int32_t b) {
  switch (b) { case 1: return "middle"; case 2: return "right"; default: return "left"; }
}

std::string escapeForJsString(const std::string& s) {
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

std::string escapeForJsonString(const std::string& s) {
  std::string out; out.reserve(s.size());
  for (char c : s) {
    if (c == '"' || c == '\\') { out.push_back('\\'); out.push_back(c); }
    else if (c == '\n') out += "\\n";
    else if (c == '\r') out += "\\r";
    else if (c == '\t') out += "\\t";
    else out.push_back(c);
  }
  return out;
}

std::string buildResolveScript(const std::string& selector) {
  // Frame-local rect + innerWidth/innerHeight for bilinear mapping when the
  // frame is transformed (rotate/scale). Main frame uses iw/ih harmlessly.
  std::string sel_lit = "\"" + escapeForJsString(selector) + "\"";
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

// Extract the user-returned value dict from a Runtime.evaluate response.
// Complex (dict/list) CefValue handles reference parent storage — round-trip
// through JSON so the returned dict has independent lifetime.
CefRefPtr<CefDictionaryValue> parseEvaluateValue(
    const std::string& evalResult,
    std::function<void(const char*, const std::string&)> onErr) {
  CefRefPtr<CefValue> ev = CefParseJSON(evalResult, JSON_PARSER_RFC);
  if (!ev || ev->GetType() != VTYPE_DICTIONARY) { onErr("runtime_error", "Runtime.evaluate malformed"); return nullptr; }
  CefRefPtr<CefDictionaryValue> d = ev->GetDictionary();
  if (d->HasKey("exceptionDetails")) {
    CefRefPtr<CefDictionaryValue> ex = d->GetDictionary("exceptionDetails");
    std::string msg = ex && ex->HasKey("text") ? ex->GetString("text").ToString() : "runtime exception";
    onErr("runtime_error", msg);
    return nullptr;
  }
  CefRefPtr<CefDictionaryValue> result = d->GetDictionary("result");
  if (!result || !result->HasKey("value")) { onErr("runtime_error", "evaluate returned no value"); return nullptr; }
  CefRefPtr<CefValue> v = result->GetValue("value");
  if (!v || v->GetType() != VTYPE_DICTIONARY) { onErr("runtime_error", "evaluate returned non-object"); return nullptr; }
  std::string userJson = CefWriteJSON(v, JSON_WRITER_DEFAULT);
  CefRefPtr<CefValue> independent = CefParseJSON(userJson, JSON_PARSER_RFC);
  if (!independent || independent->GetType() != VTYPE_DICTIONARY) {
    onErr("runtime_error", "evaluate value re-parse failed"); return nullptr;
  }
  return independent->GetDictionary();
}

void dispatchCdpClick(ViewHost* view, double cx, double cy,
                       int32_t button, int32_t click_count, uint32_t modifiers) {
  if (click_count < 1) click_count = 1;
  const char* btn = cdpButtonName(button);
  for (int i = 1; i <= click_count; ++i) {
    std::string base = "\"x\":" + std::to_string(cx) + ",\"y\":" + std::to_string(cy) +
                       ",\"button\":\"" + btn + "\",\"clickCount\":" + std::to_string(i) +
                       ",\"modifiers\":" + std::to_string(modifiers);
    cefCdpCall(view, "Input.dispatchMouseEvent", "{\"type\":\"mousePressed\"," + base + "}");
    cefCdpCall(view, "Input.dispatchMouseEvent", "{\"type\":\"mouseReleased\"," + base + "}");
  }
}

}  // namespace

namespace {

// Dispatch native click at page coords + emit success envelope.
void finishResolveAndClick(uint32_t view_id, uint32_t request_id, double x, double y,
                            double w, double h, double cx, double cy,
                            int32_t button, int32_t click_count, uint32_t modifiers) {
  auto* v = bunite_win::getViewHostById(view_id);
  if (!v || !v->browser) { emitResolveAndClickError(view_id, request_id, "runtime_error", "view destroyed"); return; }
  dispatchCdpClick(v, cx, cy, button, click_count, modifiers);
  // CEF CDP `Input.dispatchMouseEvent` produces DOM events with isTrusted=true
  // (empirical — `e.isTrusted` on page-side listener reports true).
  std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                        ",\"ok\":true,\"rect\":{\"x\":" + std::to_string(x) +
                        ",\"y\":" + std::to_string(y) +
                        ",\"width\":" + std::to_string(w) +
                        ",\"height\":" + std::to_string(h) + "},"
                        "\"isTrustedEvent\":true}";
  bunite_win::emitWebviewEvent(view_id, "resolve-and-click-result", payload);
}

struct FrameResolveOk { double x, y, w, h, cx, cy, iw, ih; };

// CefDictionaryValue::GetDouble returns 0 for VTYPE_INT — JSON.stringify
// serializes integer-valued numbers without `.0` so values like rect.height==35
// re-parse as VTYPE_INT. Coerce here.
double dictNumber(CefRefPtr<CefDictionaryValue> d, const char* key) {
  if (!d || !d->HasKey(key)) return 0.0;
  switch (d->GetType(key)) {
    case VTYPE_INT:    return static_cast<double>(d->GetInt(key));
    case VTYPE_DOUBLE: return d->GetDouble(key);
    default: return 0.0;
  }
}

// Parse a Runtime.evaluate response (either main-session or sessionId-routed)
// and forward the script's frame-local fields to `onOk`. The script's failure
// branch (`{ok:false,code:...}`) routes through `onErr`.
void parseEvalAndContinue(uint32_t view_id, uint32_t request_id, bool ok, const std::string& evalResult,
                           std::function<void(const FrameResolveOk&)> onOk) {
  auto onErr = [view_id, request_id](const char* code, const std::string& msg) {
    emitResolveAndClickError(view_id, request_id, code, msg);
  };
  if (!ok) {
    BUNITE_INFO("cef/eval: Runtime.evaluate failed view=%u request=%u body=%.300s%s",
                view_id, request_id, evalResult.c_str(),
                evalResult.size() > 300 ? "..." : "");
    onErr("runtime_error", "Runtime.evaluate failed"); return;
  }
  auto value = parseEvaluateValue(evalResult, onErr);
  if (!value) return;
  if (!value->HasKey("ok") || !value->GetBool("ok")) {
    std::string code = value->HasKey("code") ? value->GetString("code").ToString() : "runtime_error";
    onErr(code.c_str(), "");
    return;
  }
  onOk(FrameResolveOk{
      dictNumber(value, "x"),  dictNumber(value, "y"),
      dictNumber(value, "w"),  dictNumber(value, "h"),
      dictNumber(value, "cx"), dictNumber(value, "cy"),
      dictNumber(value, "iw"), dictNumber(value, "ih"),
  });
}

// Issue Runtime.evaluate inside the target frame — sessionId-routed (OOPIF) or
// isolated-world via main session (same-renderer cross-origin or same-origin).
void evalInFrame(uint32_t view_id, uint32_t request_id, const std::string& frameId,
                  const std::string& escScript,
                  std::function<void(const FrameResolveOk&)> onOk) {
  auto* view = bunite_win::getViewHostById(view_id);
  if (!view || !view->browser) { emitResolveAndClickError(view_id, request_id, "runtime_error", "view destroyed"); return; }
  // Look up auto-attached OOPIF session.
  std::string session_id;
  {
    std::lock_guard<std::mutex> lk(view->oopif_sessions_mutex);
    auto it = view->oopif_sessions.find(frameId);
    if (it != view->oopif_sessions.end()) session_id = it->second;
  }
  if (!session_id.empty()) {
    int id = nextRawCdpId();
    std::string msg = "{\"id\":" + std::to_string(id) +
                      ",\"sessionId\":\"" + session_id +
                      "\",\"method\":\"Runtime.evaluate\""
                      ",\"params\":{\"expression\":\"" + escScript +
                      "\",\"returnByValue\":true,\"awaitPromise\":true}}";
    cefSendRaw(view, msg, id,
        [view_id, request_id, onOk](bool ok, std::string r) {
          parseEvalAndContinue(view_id, request_id, ok, r, onOk);
        });
    return;
  }
  // In-process: createIsolatedWorld + Runtime.evaluate via main session.
  std::string isoParams = "{\"frameId\":\"" + bunite_win::escapeJsonString(frameId) + "\",\"worldName\":\"bunite-rac\"}";
  cefCdpCall(view, "Page.createIsolatedWorld", isoParams,
      [view_id, request_id, escScript, onOk](bool ok, std::string isoResult) {
        if (!ok) { emitResolveAndClickError(view_id, request_id, "runtime_error", "createIsolatedWorld failed"); return; }
        CefRefPtr<CefValue> val = CefParseJSON(isoResult, JSON_PARSER_RFC);
        if (!val || val->GetType() != VTYPE_DICTIONARY) {
          emitResolveAndClickError(view_id, request_id, "runtime_error", "createIsolatedWorld malformed"); return;
        }
        int contextId = val->GetDictionary()->GetInt("executionContextId");
        auto* v2 = bunite_win::getViewHostById(view_id);
        if (!v2) { emitResolveAndClickError(view_id, request_id, "runtime_error", "view destroyed"); return; }
        std::string evalParams = "{\"expression\":\"" + escScript +
                                 "\",\"contextId\":" + std::to_string(contextId) +
                                 ",\"returnByValue\":true,\"awaitPromise\":true}";
        cefCdpCall(v2, "Runtime.evaluate", evalParams,
            [view_id, request_id, onOk](bool ok2, std::string r) {
              parseEvalAndContinue(view_id, request_id, ok2, r, onOk);
            });
      });
}

// Bilinear: (fx, fy) ∈ [0, iw] × [0, ih] → page coord using clockwise quad
// TL/TR/BR/BL. Handles axis-aligned, scaled, rotated, and skewed iframes.
inline void bilinearMap(const std::array<double, 8>& q, double iw, double ih,
                         double fx, double fy, double& px, double& py) {
  const double u = (iw > 0) ? (fx / iw) : 0.0;
  const double v = (ih > 0) ? (fy / ih) : 0.0;
  px = (1-u)*(1-v)*q[0] + u*(1-v)*q[2] + u*v*q[4] + (1-u)*v*q[6];
  py = (1-u)*(1-v)*q[1] + u*(1-v)*q[3] + u*v*q[5] + (1-u)*v*q[7];
}

// Recursive frame path lookup in Page.getFrameTree response.
// Returns [outermost frame id, ..., target_frame_id] including main; empty if
// target not in tree.
std::vector<std::string> findFramePath(CefRefPtr<CefDictionaryValue> node, const std::string& target) {
  if (!node) return {};
  CefRefPtr<CefDictionaryValue> frame = node->HasKey("frame") ? node->GetDictionary("frame") : nullptr;
  if (!frame) return {};
  std::string this_id = frame->GetString("id").ToString();
  if (this_id == target) return {this_id};
  CefRefPtr<CefListValue> children = node->HasKey("childFrames") ? node->GetList("childFrames") : nullptr;
  if (!children) return {};
  for (size_t i = 0; i < children->GetSize(); ++i) {
    auto v = children->GetValue(i);
    if (!v || v->GetType() != VTYPE_DICTIONARY) continue;
    auto sub = findFramePath(v->GetDictionary(), target);
    if (!sub.empty()) { sub.insert(sub.begin(), this_id); return sub; }
  }
  return {};
}

bool parseQuadFromBoxModel(const std::string& result, std::array<double, 8>& out) {
  CefRefPtr<CefValue> bv = CefParseJSON(result, JSON_PARSER_RFC);
  if (!bv || bv->GetType() != VTYPE_DICTIONARY) return false;
  auto model = bv->GetDictionary()->HasKey("model") ? bv->GetDictionary()->GetDictionary("model") : nullptr;
  if (!model) return false;
  auto content = model->HasKey("content") ? model->GetList("content") : nullptr;
  if (!content || content->GetSize() < 8) return false;
  for (int i = 0; i < 8; ++i) {
    // CDP serializes integer pixel positions without `.0`; coerce from INT.
    switch (content->GetType(i)) {
      case VTYPE_INT:    out[i] = static_cast<double>(content->GetInt(i)); break;
      case VTYPE_DOUBLE: out[i] = content->GetDouble(i); break;
      default: out[i] = 0.0;
    }
  }
  return true;
}

// Eval a script on a specific session (OOPIF) or main session (empty session_id).
// Result delivered as raw JSON of `Runtime.evaluate` response.
void evalRaw(ViewHost* view, const std::string& session_id, const std::string& escScript,
              std::function<void(bool, std::string)> cb) {
  if (session_id.empty()) {
    std::string params = "{\"expression\":\"" + escScript + "\",\"returnByValue\":true,\"awaitPromise\":true}";
    cefCdpCall(view, "Runtime.evaluate", params, std::move(cb));
    return;
  }
  int id = nextRawCdpId();
  std::string msg = "{\"id\":" + std::to_string(id) +
                    ",\"sessionId\":\"" + session_id +
                    "\",\"method\":\"Runtime.evaluate\",\"params\":{\"expression\":\"" +
                    escScript + "\",\"returnByValue\":true,\"awaitPromise\":true}}";
  cefSendRaw(view, msg, id, std::move(cb));
}

// State threaded through chain-walk continuations.
struct ChainState {
  uint32_t view_id;
  uint32_t request_id;
  std::string targetFrameId;
  std::string escScript;
  int32_t button, click_count;
  uint32_t modifiers;
  // chain[0] = main frameId, chain[1..N-1] = outermost..target. N >= 2.
  std::vector<std::string> chain;
  // For each link i (parent = chain[i], child = chain[i+1]): quad in parent's coord system.
  std::vector<std::array<double, 8>> link_quads;
  // For chain[i] (i in [1..N-2]): innerWidth/innerHeight of that ancestor frame.
  // Used when mapping FROM chain[i+1]'s coords up to chain[i]'s coords.
  // Indexed by ancestor's chain position; chain[N-1] (target) iw/ih comes from
  // the target eval, not stored here.
  std::vector<std::pair<double, double>> ancestor_inner;
};

void composeAndDispatch(std::shared_ptr<ChainState> s, const FrameResolveOk& fr);
void fetchTargetEval(std::shared_ptr<ChainState> s);
void fetchAncestorInner(std::shared_ptr<ChainState> s, size_t i);
void fetchLink(std::shared_ptr<ChainState> s, size_t link_idx);

// Look up the session for an ancestor frame (chain[idx]). idx == 0 → main (empty).
std::string sessionForChainIdx(uint32_t view_id, const std::vector<std::string>& chain, size_t idx) {
  if (idx == 0) return {};
  auto* view = bunite_win::getViewHostById(view_id);
  if (!view) return {};
  std::lock_guard<std::mutex> lk(view->oopif_sessions_mutex);
  auto it = view->oopif_sessions.find(chain[idx]);
  return (it != view->oopif_sessions.end()) ? it->second : std::string{};
}

void fetchLink(std::shared_ptr<ChainState> s, size_t link_idx) {
  if (link_idx + 1 >= s->chain.size()) {
    // All links collected. Move to ancestor inner sizes.
    fetchAncestorInner(s, 1);
    return;
  }
  const std::string parent_session = sessionForChainIdx(s->view_id, s->chain, link_idx);
  const std::string& child_frameId = s->chain[link_idx + 1];
  auto* view = bunite_win::getViewHostById(s->view_id);
  if (!view) { emitResolveAndClickError(s->view_id, s->request_id, "runtime_error", "view destroyed"); return; }
  // DOM.getFrameOwner on parent's session.
  std::string ownerParams = "{\"frameId\":\"" + bunite_win::escapeJsonString(child_frameId) + "\"}";
  auto onOwner = [s, link_idx, parent_session](bool ok, std::string r) {
    if (!ok) { emitResolveAndClickError(s->view_id, s->request_id, "not_found", "getFrameOwner failed"); return; }
    CefRefPtr<CefValue> val = CefParseJSON(r, JSON_PARSER_RFC);
    if (!val || val->GetType() != VTYPE_DICTIONARY) { emitResolveAndClickError(s->view_id, s->request_id, "runtime_error", "getFrameOwner malformed"); return; }
    int backendNodeId = val->GetDictionary()->HasKey("backendNodeId") ? val->GetDictionary()->GetInt("backendNodeId") : 0;
    if (!backendNodeId) { emitResolveAndClickError(s->view_id, s->request_id, "not_found", "no backendNodeId"); return; }
    auto* v2 = bunite_win::getViewHostById(s->view_id);
    if (!v2) { emitResolveAndClickError(s->view_id, s->request_id, "runtime_error", "view destroyed"); return; }
    std::string boxParams = "{\"backendNodeId\":" + std::to_string(backendNodeId) + "}";
    auto onBox = [s, link_idx](bool ok2, std::string rb) {
      if (!ok2) { emitResolveAndClickError(s->view_id, s->request_id, "not_visible", "iframe has no box"); return; }
      std::array<double, 8> quad{};
      if (!parseQuadFromBoxModel(rb, quad)) { emitResolveAndClickError(s->view_id, s->request_id, "runtime_error", "bad quad"); return; }
      s->link_quads.push_back(quad);
      fetchLink(s, link_idx + 1);
    };
    if (parent_session.empty()) {
      cefCdpCall(v2, "DOM.getBoxModel", boxParams, onBox);
    } else {
      int id = nextRawCdpId();
      std::string msg = "{\"id\":" + std::to_string(id) +
                        ",\"sessionId\":\"" + parent_session +
                        "\",\"method\":\"DOM.getBoxModel\",\"params\":" + boxParams + "}";
      cefSendRaw(v2, msg, id, onBox);
    }
  };
  if (parent_session.empty()) {
    cefCdpCall(view, "DOM.getFrameOwner", ownerParams, onOwner);
  } else {
    int id = nextRawCdpId();
    std::string msg = "{\"id\":" + std::to_string(id) +
                      ",\"sessionId\":\"" + parent_session +
                      "\",\"method\":\"DOM.getFrameOwner\",\"params\":" + ownerParams + "}";
    cefSendRaw(view, msg, id, onOwner);
  }
}

void fetchAncestorInner(std::shared_ptr<ChainState> s, size_t i) {
  // i ranges [1, N-2]. Skip N-1 (target — iw/ih from target eval).
  if (i + 1 >= s->chain.size()) {
    // Done with ancestors. Eval target script.
    fetchTargetEval(s);
    return;
  }
  const std::string sid = sessionForChainIdx(s->view_id, s->chain, i);
  auto* view = bunite_win::getViewHostById(s->view_id);
  if (!view) { emitResolveAndClickError(s->view_id, s->request_id, "runtime_error", "view destroyed"); return; }
  const std::string& script = "JSON.stringify({iw:innerWidth,ih:innerHeight})";
  std::string escScript = escapeForJsonString(script);
  evalRaw(view, sid, escScript,
      [s, i](bool ok, std::string r) {
        if (!ok) { emitResolveAndClickError(s->view_id, s->request_id, "runtime_error", "ancestor eval failed"); return; }
        // Result envelope: {"result":{"type":"string","value":"<json string>"}}
        CefRefPtr<CefValue> v = CefParseJSON(r, JSON_PARSER_RFC);
        if (!v || v->GetType() != VTYPE_DICTIONARY) { emitResolveAndClickError(s->view_id, s->request_id, "runtime_error", "ancestor eval malformed"); return; }
        auto result = v->GetDictionary()->GetDictionary("result");
        if (!result || !result->HasKey("value")) { emitResolveAndClickError(s->view_id, s->request_id, "runtime_error", "ancestor eval no value"); return; }
        std::string vs = result->GetString("value").ToString();
        CefRefPtr<CefValue> inner = CefParseJSON(vs, JSON_PARSER_RFC);
        if (!inner || inner->GetType() != VTYPE_DICTIONARY) { emitResolveAndClickError(s->view_id, s->request_id, "runtime_error", "ancestor inner malformed"); return; }
        s->ancestor_inner.push_back({dictNumber(inner->GetDictionary(), "iw"), dictNumber(inner->GetDictionary(), "ih")});
        fetchAncestorInner(s, i + 1);
      });
}

void fetchTargetEval(std::shared_ptr<ChainState> s) {
  evalInFrame(s->view_id, s->request_id, s->targetFrameId, s->escScript,
      [s](const FrameResolveOk& fr) { composeAndDispatch(s, fr); });
}

void composeAndDispatch(std::shared_ptr<ChainState> s, const FrameResolveOk& fr) {
  // Stack iw/ih per chain level chain[1..N-1] for the bilinear walk.
  // chain[N-1] = target → fr.iw, fr.ih.
  // chain[i] (1 <= i < N-1) → s->ancestor_inner[i-1].
  // link_quads[i] = quad of chain[i+1]'s iframe element, in chain[i]'s coords.
  // Map order: from target up to main, applying bilinear at each link.
  auto mapCorner = [&](double fx, double fy, double& px, double& py) {
    double cur_x = fx, cur_y = fy;
    double cur_iw = fr.iw, cur_ih = fr.ih;
    // link i (chain[i+1] in chain[i]'s coords) for i = N-2 down to 0.
    for (size_t i = s->link_quads.size(); i-- > 0; ) {
      double mapped_x, mapped_y;
      bilinearMap(s->link_quads[i], cur_iw, cur_ih, cur_x, cur_y, mapped_x, mapped_y);
      cur_x = mapped_x; cur_y = mapped_y;
      if (i == 0) break;  // chain[i] is main-direct child handled; next would be main itself
      // Now in chain[i]'s coords; next iteration maps to chain[i-1]'s coords.
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
  finishResolveAndClick(s->view_id, s->request_id,
      min_x, min_y, max_x - min_x, max_y - min_y, pcx, pcy,
      s->button, s->click_count, s->modifiers);
}

// `frameId` non-empty: walk ancestor chain via Page.getFrameTree, compose
// bilinear transforms across nested OOPIF/same-origin frames, dispatch click
// in main-page coords.
void runFrameTargeted(uint32_t view_id, uint32_t request_id, const std::string& frameId,
                       const std::string& escScript,
                       int32_t button, int32_t click_count, uint32_t modifiers) {
  auto* view = bunite_win::getViewHostById(view_id);
  if (!view || !view->browser) { emitResolveAndClickError(view_id, request_id, "runtime_error", "view destroyed"); return; }
  cefCdpCall(view, "Page.getFrameTree", "{}",
      [view_id, request_id, frameId, escScript, button, click_count, modifiers](bool ok, std::string r) {
        if (!ok) { emitResolveAndClickError(view_id, request_id, "runtime_error", "getFrameTree failed"); return; }
        CefRefPtr<CefValue> val = CefParseJSON(r, JSON_PARSER_RFC);
        if (!val || val->GetType() != VTYPE_DICTIONARY) { emitResolveAndClickError(view_id, request_id, "runtime_error", "getFrameTree malformed"); return; }
        auto root = val->GetDictionary()->GetDictionary("frameTree");
        std::vector<std::string> chain = findFramePath(root, frameId);
        if (chain.size() < 2) { emitResolveAndClickError(view_id, request_id, "not_found", "frame not in tree"); return; }
        auto s = std::make_shared<ChainState>();
        s->view_id = view_id;
        s->request_id = request_id;
        s->targetFrameId = frameId;
        s->escScript = escScript;
        s->button = button;
        s->click_count = click_count;
        s->modifiers = modifiers;
        s->chain = std::move(chain);  // chain[0] = main, chain[N-1] = target
        fetchLink(s, 0);
      });
}

}  // namespace

extern "C" BUNITE_EXPORT void bunite_view_resolve_and_click(
    uint32_t view_id, uint32_t request_id,
    const char* selector_c, const char* frame_id_c,
    int32_t button, int32_t click_count, uint32_t modifiers) {
  std::string selector = selector_c ? selector_c : "";
  std::string frameId = frame_id_c ? frame_id_c : "";
  bunite_win::postCefUiTask([view_id, request_id, selector, frameId, button, click_count, modifiers]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view || !view->browser) { emitResolveAndClickError(view_id, request_id, "runtime_error", "view not ready"); return; }

    std::string script = buildResolveScript(selector);
    std::string escScript = escapeForJsonString(script);

    if (frameId.empty()) {
      // Main frame — fr.x/y/w/h are already page-viewport coords (iw/ih unused).
      std::string evalParams = "{\"expression\":\"" + escScript + "\",\"returnByValue\":true,\"awaitPromise\":true}";
      cefCdpCall(view, "Runtime.evaluate", evalParams,
          [view_id, request_id, button, click_count, modifiers](bool ok, std::string r) {
            parseEvalAndContinue(view_id, request_id, ok, r,
                [view_id, request_id, button, click_count, modifiers](const FrameResolveOk& fr) {
                  finishResolveAndClick(view_id, request_id,
                                         fr.x, fr.y, fr.w, fr.h, fr.cx, fr.cy,
                                         button, click_count, modifiers);
                });
          });
      return;
    }

    // Frame-targeted: lazy Target.setAutoAttach so OOPIF frames get sessionIds
    // populated into view->oopif_sessions via OnDevToolsEvent. Wait for response
    // so attachedToTarget events fire before we proceed.
    if (!view->oopif_autoattach_armed.exchange(true)) {
      cefCdpCall(view, "Target.setAutoAttach",
          "{\"autoAttach\":true,\"flatten\":true,\"waitForDebuggerOnStart\":false}",
          [view_id, request_id, frameId, escScript, button, click_count, modifiers](bool ok, std::string) {
            if (!ok) { emitResolveAndClickError(view_id, request_id, "runtime_error", "setAutoAttach failed"); return; }
            runFrameTargeted(view_id, request_id, frameId, escScript, button, click_count, modifiers);
          });
      return;
    }
    runFrameTargeted(view_id, request_id, frameId, escScript, button, click_count, modifiers);
  });
}

extern "C" BUNITE_EXPORT void bunite_view_open_devtools(uint32_t view_id) {
  bunite_win::postCefUiTask([view_id]() { bunite_win::openDevToolsForView(bunite_win::getViewHostById(view_id)); });
}

extern "C" BUNITE_EXPORT void bunite_view_close_devtools(uint32_t view_id) {
  bunite_win::postCefUiTask([view_id]() { bunite_win::closeDevToolsForView(bunite_win::getViewHostById(view_id)); });
}

extern "C" BUNITE_EXPORT void bunite_view_toggle_devtools(uint32_t view_id) {
  bunite_win::postCefUiTask([view_id]() { bunite_win::toggleDevToolsForView(bunite_win::getViewHostById(view_id)); });
}

extern "C" BUNITE_EXPORT void bunite_complete_permission_request(uint32_t request_id, uint32_t state) {
  bunite_win::postCefUiTask([=]() {
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

