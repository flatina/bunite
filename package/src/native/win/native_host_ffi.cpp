#include "native_host_internal.h"

#include "include/cef_version.h"
#include "include/cef_version_info.h"

// Screenshot path — PrintWindow PW_RENDERFULLCONTENT into HBITMAP, WIC encode
// to PNG/JPEG IStream, CryptBinaryToString → base64. PW_RENDERFULLCONTENT (Win
// 8.1+) captures DComp/D3D-composed content. The detection sweep at the end of
// captureToBytes rejects all-black frames (silent compositor mismatch). For
// hardware-accelerated CEF that even RENDERFULLCONTENT can't reach, the call
// returns black_frame and callers must fall back (CDP `Page.captureScreenshot`
// migration is the long-term plan).
#include <wincodec.h>
#include <wincrypt.h>
#include <VersionHelpers.h>

using bunite_win::runOnUiThreadSync;
using bunite_win::runOnCefUiThreadSync;

static constexpr int32_t BUNITE_ABI_VERSION = 7;

namespace {

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

extern "C" BUNITE_EXPORT bool bunite_init(
  const char* cef_dir,
  bool hide_console,
  bool popup_blocking,
  const char* engine_config_json
) {
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

constexpr uint32_t MOD_ALT = 1, MOD_CTRL = 2, MOD_META = 4, MOD_SHIFT = 8;

uint32_t cefModifiers(uint32_t bits) {
  uint32_t flags = 0;
  if (bits & MOD_SHIFT) flags |= EVENTFLAG_SHIFT_DOWN;
  if (bits & MOD_CTRL)  flags |= EVENTFLAG_CONTROL_DOWN;
  if (bits & MOD_ALT)   flags |= EVENTFLAG_ALT_DOWN;
  if (bits & MOD_META)  flags |= EVENTFLAG_COMMAND_DOWN;
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
    // BMP codepoints map cleanly to a single CHAR event. Surrogate pairs would
    // arrive as two CHAR events (mis-firing `keypress` twice); warn-once + skip
    // until proper supplementary-plane handling lands.
    for (size_t i = 0; i < wide.size(); ++i) {
      wchar_t ch = wide[i];
      if (ch >= 0xD800 && ch <= 0xDBFF) {
        static bool warned = false;
        if (!warned) { warned = true; BUNITE_WARN("cef type: supplementary-plane codepoint skipped"); }
        if (i + 1 < wide.size()) ++i;  // skip low surrogate
        continue;
      }
      CefKeyEvent ke{};
      ke.type = KEYEVENT_CHAR;
      ke.character = ch;
      ke.unmodified_character = ch;
      host->SendKeyEvent(ke);
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_press(uint32_t view_id, int32_t windows_vk_code,
                                                  int32_t /*mac_key_code*/,
                                                  const char* /*key*/, const char* /*code*/,
                                                  const char* character, uint32_t modifiers) {
  std::string char_str = character ? character : "";
  bunite_win::postCefUiTask([view_id, windows_vk_code, char_str, modifiers]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view || !view->browser) return;
    auto host = view->browser->GetHost();
    if (!host) return;
    uint32_t mod = cefModifiers(modifiers);

    // 3-event sequence: RAWKEYDOWN + CHAR + KEYUP — DOM keydown/keypress/keyup parity.
    if (windows_vk_code != 0) {
      CefKeyEvent down{};
      down.type = KEYEVENT_RAWKEYDOWN;
      down.windows_key_code = windows_vk_code;
      down.native_key_code = windows_vk_code;
      down.modifiers = mod;
      host->SendKeyEvent(down);
    }
    if (!char_str.empty()) {
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
    if (windows_vk_code != 0) {
      CefKeyEvent up{};
      up.type = KEYEVENT_KEYUP;
      up.windows_key_code = windows_vk_code;
      up.native_key_code = windows_vk_code;
      up.modifiers = mod;
      host->SendKeyEvent(up);
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_scroll(uint32_t view_id, double dx, double dy,
                                                   double x, double y, uint32_t modifiers) {
  bunite_win::postCefUiTask([view_id, dx, dy, x, y, modifiers]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view || !view->browser) return;
    auto host = view->browser->GetHost();
    if (!host) return;
    CefMouseEvent ev{};
    ev.x = static_cast<int>(x);
    ev.y = static_cast<int>(y);
    ev.modifiers = cefModifiers(modifiers);
    host->SendMouseWheelEvent(ev, static_cast<int>(dx), static_cast<int>(dy));
  });
}

namespace {

std::string cefBase64Encode(const BYTE* bytes, DWORD len) {
  DWORD out_len = 0;
  if (!CryptBinaryToStringA(bytes, len, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &out_len)) return {};
  std::string out(out_len, '\0');
  if (!CryptBinaryToStringA(bytes, len, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, out.data(), &out_len)) return {};
  out.resize(out_len);
  while (!out.empty() && out.back() == '\0') out.pop_back();
  return out;
}

void emitScreenshotError(uint32_t view_id, uint32_t request_id, const char* code, const std::string& msg) {
  std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                        ",\"ok\":false,\"code\":\"" + code + "\","
                        "\"message\":\"" + bunite_win::escapeJsonString(msg) + "\"}";
  bunite_win::emitWebviewEvent(view_id, "screenshot-result", payload);
}

// Sample 9 pixels (corners + edge midpoints + center). If all are RGB(0,0,0),
// PrintWindow handed us a black frame from a compositor it couldn't reach.
bool looksBlack(HBITMAP bmp, int w, int h) {
  BITMAPINFO bi{};
  bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bi.bmiHeader.biWidth = w;
  bi.bmiHeader.biHeight = -h;  // top-down
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  bi.bmiHeader.biCompression = BI_RGB;
  std::vector<uint32_t> pixels(w * h);
  HDC dc = GetDC(nullptr);
  int got = GetDIBits(dc, bmp, 0, h, pixels.data(), &bi, DIB_RGB_COLORS);
  ReleaseDC(nullptr, dc);
  if (got <= 0) return false;
  const int xs[3] = { 0, w / 2, w - 1 };
  const int ys[3] = { 0, h / 2, h - 1 };
  for (int yi = 0; yi < 3; ++yi) for (int xi = 0; xi < 3; ++xi) {
    if ((pixels[ys[yi] * w + xs[xi]] & 0x00FFFFFF) != 0) return false;
  }
  return true;
}

// Capture `hwnd` to PNG/JPEG bytes via PrintWindow + WIC. Returns empty on failure.
bool captureToBytes(HWND hwnd, const wchar_t* mimeFormat, int32_t quality,
                    std::vector<BYTE>& out, std::string& errCode) {
  errCode.clear();
  if (!IsWindows8Point1OrGreater()) { errCode = "not_supported"; return false; }
  RECT rc{};
  if (!GetClientRect(hwnd, &rc)) { errCode = "runtime_error"; return false; }
  const int w = rc.right - rc.left;
  const int h = rc.bottom - rc.top;
  if (w <= 0 || h <= 0) { errCode = "runtime_error"; return false; }

  // CefBrowserHost's HWND owns the DPI context; using its DC keeps per-monitor scaling correct.
  HDC src = GetDC(hwnd);
  HDC mem = CreateCompatibleDC(src);
  HBITMAP bmp = CreateCompatibleBitmap(src, w, h);
  HGDIOBJ old = SelectObject(mem, bmp);
  // PW_RENDERFULLCONTENT (0x2) — capture D3D / DComp surfaces. Falls back to
  // WM_PRINT on < Win 8.1 (gated above).
  BOOL ok = PrintWindow(hwnd, mem, 0x00000002);
  SelectObject(mem, old);
  DeleteDC(mem);
  ReleaseDC(hwnd, src);
  if (!ok) { DeleteObject(bmp); errCode = "runtime_error"; return false; }

  // Black-frame detection: PrintWindow returns TRUE even when the GPU
  // compositor surface is unreachable. Sample pixels; bail honestly.
  if (looksBlack(bmp, w, h)) { DeleteObject(bmp); errCode = "black_frame"; return false; }

  // WIC needs COM on this thread; tolerate already-initialised modes.
  HRESULT coHr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  const bool coOwned = (coHr == S_OK || coHr == S_FALSE);
  auto coCleanup = [coOwned]() { if (coOwned) CoUninitialize(); };

  Microsoft::WRL::ComPtr<IWICImagingFactory> factory;
  if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(&factory)))) { DeleteObject(bmp); coCleanup(); errCode = "runtime_error"; return false; }

  Microsoft::WRL::ComPtr<IStream> stream;
  if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &stream))) { DeleteObject(bmp); coCleanup(); errCode = "runtime_error"; return false; }

  GUID container = (wcscmp(mimeFormat, L"jpeg") == 0) ? GUID_ContainerFormatJpeg : GUID_ContainerFormatPng;

  Microsoft::WRL::ComPtr<IWICBitmapEncoder> encoder;
  if (FAILED(factory->CreateEncoder(container, nullptr, &encoder)) ||
      FAILED(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache))) {
    DeleteObject(bmp); coCleanup(); errCode = "runtime_error"; return false;
  }
  Microsoft::WRL::ComPtr<IWICBitmapFrameEncode> frame;
  Microsoft::WRL::ComPtr<IPropertyBag2> bag;
  if (FAILED(encoder->CreateNewFrame(&frame, &bag))) { DeleteObject(bmp); coCleanup(); errCode = "runtime_error"; return false; }
  if (container == GUID_ContainerFormatJpeg && bag) {
    PROPBAG2 opt{}; opt.pstrName = const_cast<LPOLESTR>(L"ImageQuality");
    VARIANT v{}; v.vt = VT_R4; v.fltVal = (quality < 0 ? 0.9f : std::min(quality, 100) / 100.0f);
    bag->Write(1, &opt, &v);
  }
  if (FAILED(frame->Initialize(bag.Get()))) { DeleteObject(bmp); coCleanup(); errCode = "runtime_error"; return false; }
  Microsoft::WRL::ComPtr<IWICBitmap> wic_bmp;
  if (FAILED(factory->CreateBitmapFromHBITMAP(bmp, nullptr, WICBitmapIgnoreAlpha, &wic_bmp))) {
    DeleteObject(bmp); coCleanup(); errCode = "runtime_error"; return false;
  }
  // WIC bitmap retains a reference to the HBITMAP pixel data — keep `bmp`
  // alive until encoder.Commit() finishes reading pixels.
  if (FAILED(frame->WriteSource(wic_bmp.Get(), nullptr)) ||
      FAILED(frame->Commit()) || FAILED(encoder->Commit())) {
    DeleteObject(bmp); coCleanup(); errCode = "runtime_error"; return false;
  }
  DeleteObject(bmp);

  HGLOBAL hg = nullptr;
  if (FAILED(GetHGlobalFromStream(stream.Get(), &hg)) || !hg) { coCleanup(); errCode = "runtime_error"; return false; }
  const SIZE_T sz = GlobalSize(hg);
  void* p = GlobalLock(hg);
  if (!p) { coCleanup(); errCode = "runtime_error"; return false; }
  out.assign(static_cast<BYTE*>(p), static_cast<BYTE*>(p) + sz);
  GlobalUnlock(hg);
  coCleanup();
  return true;
}

}  // namespace

extern "C" BUNITE_EXPORT uint32_t bunite_view_capabilities(uint32_t view_id) {
  // CEF — native input (isTrusted=true), PrintWindow screenshot (Win 8.1+).
  auto* view = bunite_win::getViewHostById(view_id);
  if (!view) return 0;
  uint32_t bits = BUNITE_CAP_EVALUATE | BUNITE_CAP_TITLE_CHANGED |
                  BUNITE_CAP_NATIVE_INPUT_TRUSTED |
                  BUNITE_CAP_CLICK | BUNITE_CAP_TYPE | BUNITE_CAP_PRESS | BUNITE_CAP_SCROLL;
  if (IsWindows8Point1OrGreater()) {
    bits |= BUNITE_CAP_SCREENSHOT | BUNITE_CAP_FORMAT_PNG | BUNITE_CAP_FORMAT_JPEG;
  }
  return bits;
}

extern "C" BUNITE_EXPORT void bunite_view_screenshot(uint32_t view_id, uint32_t request_id,
                                                       const char* format, int32_t quality) {
  std::string fmt = format ? format : "png";
  bunite_win::postCefUiTask([view_id, request_id, fmt, quality]() {
    auto* view = bunite_win::getViewHostById(view_id);
    if (!view || !view->browser) {
      emitScreenshotError(view_id, request_id, "not_supported", "view not ready");
      return;
    }
    HWND hwnd = view->browser->GetHost()->GetWindowHandle();
    if (!hwnd) {
      emitScreenshotError(view_id, request_id, "not_supported", "no window handle");
      return;
    }
    const bool jpeg = (fmt == "jpeg" || fmt == "jpg");
    std::vector<BYTE> bytes;
    std::string errCode;
    if (!captureToBytes(hwnd, jpeg ? L"jpeg" : L"png", quality, bytes, errCode) || bytes.empty()) {
      const char* code = errCode.empty() ? "runtime_error" : errCode.c_str();
      const char* msg = (errCode == "black_frame")
        ? "PrintWindow returned all-black; CEF compositor unreachable"
        : (errCode == "not_supported" ? "PW_RENDERFULLCONTENT requires Windows 8.1+" : "PrintWindow + WIC failed");
      emitScreenshotError(view_id, request_id, code, msg);
      return;
    }
    std::string b64 = cefBase64Encode(bytes.data(), static_cast<DWORD>(bytes.size()));
    if (b64.empty()) {
      emitScreenshotError(view_id, request_id, "runtime_error", "base64 encode failed");
      return;
    }
    const std::string mime = jpeg ? "image/jpeg" : "image/png";
    const std::string outFmt = jpeg ? "jpeg" : "png";
    std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                          ",\"ok\":true,\"format\":\"" + outFmt +
                          "\",\"mime\":\"" + mime +
                          "\",\"dataBase64\":\"" + b64 + "\"}";
    bunite_win::emitWebviewEvent(view_id, "screenshot-result", payload);
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

