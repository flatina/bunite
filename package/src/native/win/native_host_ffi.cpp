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
#include <atomic>
#include <functional>
#include <mutex>
#include <unordered_map>


using bunite_win::runOnUiThreadSync;
using bunite_win::runOnCefUiThreadSync;

static constexpr int32_t BUNITE_ABI_VERSION = 10;

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
         BUNITE_CAP_AX | BUNITE_CAP_BOUNDING_RECT;
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

