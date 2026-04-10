#include "native_host_internal.h"

using bunite_win::runOnUiThreadSync;
using bunite_win::runOnCefUiThreadSync;

extern "C" BUNITE_EXPORT void bunite_set_log_level(int32_t level) {
  buniteSetLogLevel(static_cast<BuniteLogLevel>(level));
}

extern "C" BUNITE_EXPORT bool bunite_init(
  const char* process_helper_path,
  const char* cef_dir,
  bool hide_console,
  bool popup_blocking,
  const char* chromium_flags_json
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
    g_runtime.process_helper_path = process_helper_path ? process_helper_path : "";
    g_runtime.cef_dir = cef_dir ? cef_dir : "";
    g_runtime.popup_blocking = popup_blocking;
    g_runtime.chromium_flags = bunite_win::parseChromiumFlagsJson(
      chromium_flags_json ? chromium_flags_json : "");
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
  bool sandbox
) {
  return runOnUiThreadSync<bool>([=]() -> bool {
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
      sandbox
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

extern "C" BUNITE_EXPORT int32_t bunite_show_message_box(
  const char* type,
  const char* title,
  const char* message,
  const char* detail,
  const char* buttons,
  int32_t default_id,
  int32_t cancel_id
) {
  return runOnUiThreadSync<int32_t>([=]() -> int32_t {
    std::string composed_message = message ? message : "";
    if (detail && std::strlen(detail) > 0) {
      if (!composed_message.empty()) {
        composed_message += "\n\n";
      }
      composed_message += detail;
    }

    UINT flags = MB_OK;
    const std::string type_name = type ? type : "info";
    if (type_name == "none") {
      // Intentionally no icon flag.
    } else if (type_name == "warning") {
      flags |= MB_ICONWARNING;
    } else if (type_name == "error") {
      flags |= MB_ICONERROR;
    } else if (type_name == "question") {
      flags |= MB_ICONQUESTION;
    } else {
      flags |= MB_ICONINFORMATION;
    }

    const std::vector<std::string> labels = bunite_win::splitButtonLabels(buttons ? buttons : "");
    std::vector<std::string> normalized_labels;
    normalized_labels.reserve(labels.size());
    for (const std::string& label : labels) {
      normalized_labels.push_back(bunite_win::toLowerAscii(bunite_win::trimAsciiWhitespace(label)));
    }

    if (normalized_labels.size() == 2) {
      if (normalized_labels[0] == "yes" && normalized_labels[1] == "no") {
        flags = (flags & ~MB_OK) | MB_YESNO;
      } else {
        flags = (flags & ~MB_OK) | MB_OKCANCEL;
      }
    } else if (
      normalized_labels.size() >= 3 &&
      normalized_labels[0] == "yes" &&
      normalized_labels[1] == "no" &&
      normalized_labels[2] == "cancel"
    ) {
      flags = (flags & ~MB_OK) | MB_YESNOCANCEL;
    }

    if (default_id == 1) {
      flags |= MB_DEFBUTTON2;
    } else if (default_id >= 2) {
      flags |= MB_DEFBUTTON3;
    }

    const std::wstring window_title = bunite_win::utf8ToWide(title ? title : "");
    const std::wstring window_message = bunite_win::utf8ToWide(composed_message);
    const int result = MessageBoxW(GetActiveWindow(), window_message.c_str(), window_title.c_str(), flags);

    switch (result) {
      case IDOK:
      case IDYES:
        return 0;
      case IDNO:
        return 1;
      case IDCANCEL:
        return cancel_id >= 0 ? cancel_id : (labels.size() > 2 ? 2 : 1);
      default:
        return cancel_id >= 0 ? cancel_id : -1;
    }
  });
}

extern "C" BUNITE_EXPORT uint32_t bunite_show_browser_message_box(
  const char* type,
  const char* title,
  const char* message,
  const char* detail,
  const char* buttons,
  int32_t default_id,
  int32_t cancel_id
) {
  return runOnCefUiThreadSync<uint32_t>([=]() -> uint32_t {
    ViewHost* view = bunite_win::getPreferredMessageBoxView();
    if (!view || !view->browser || !view->browser->GetMainFrame()) {
      return 0;
    }

    const uint32_t request_id = [&]() {
      std::lock_guard<std::mutex> lock(g_runtime.message_box_mutex);
      uint32_t id = g_runtime.next_message_box_request_id++;
      if (id == 0) {
        id = g_runtime.next_message_box_request_id++;
      }
      g_runtime.pending_message_boxes.emplace(
        id,
        PendingMessageBoxRequest{
          view->id,
          cancel_id
        }
      );
      return id;
    }();

    const std::vector<std::string> labels = bunite_win::splitButtonLabels(buttons ? buttons : "");
    const std::vector<std::string> browser_labels = labels.empty()
      ? std::vector<std::string>{ "OK" }
      : labels;

    view->browser->GetMainFrame()->ExecuteJavaScript(
      bunite_win::buildBrowserMessageBoxScript(
        request_id,
        type ? type : "info",
        title ? title : "",
        message ? message : "",
        detail ? detail : "",
        browser_labels,
        default_id,
        cancel_id
      ),
      view->browser->GetMainFrame()->GetURL(),
      0
    );

    return request_id;
  });
}

extern "C" BUNITE_EXPORT void bunite_cancel_browser_message_box(uint32_t request_id) {
  runOnUiThreadSync<void>([=]() { bunite_win::cancelPendingMessageBoxRequest(request_id); });
}
