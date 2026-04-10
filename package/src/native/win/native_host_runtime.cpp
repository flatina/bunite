#include "native_host_internal.h"

RuntimeState g_runtime;

namespace bunite_win {

HINSTANCE getCurrentModuleHandle() {
  HMODULE module = nullptr;
  GetModuleHandleExW(
    GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
    reinterpret_cast<LPCWSTR>(&getCurrentModuleHandle),
    &module
  );
  return module;
}

bool isOnUiThread() {
  return g_runtime.ui_thread_id != 0 && GetCurrentThreadId() == g_runtime.ui_thread_id;
}

void postUiTask(std::function<void()> task) {
  {
    std::lock_guard<std::mutex> lock(g_runtime.task_mutex);
    g_runtime.queued_tasks.push(std::move(task));
  }

  if (g_runtime.message_window) {
    PostMessageW(g_runtime.message_window, kRunQueuedTaskMessage, 0, 0);
  }
}

void postCefUiTask(std::function<void()> task) {
  CefPostTask(TID_UI, new CefClosureTask(std::move(task)));
}

void executeQueuedUiTasks() {
  for (;;) {
    std::queue<std::function<void()>> tasks;
    {
      std::lock_guard<std::mutex> lock(g_runtime.task_mutex);
      if (g_runtime.queued_tasks.empty()) {
        break;
      }
      tasks.swap(g_runtime.queued_tasks);
    }

    while (!tasks.empty()) {
      auto task = std::move(tasks.front());
      tasks.pop();
      task();
    }
  }
}

// ---------------------------------------------------------------------------
// Window procedures
// ---------------------------------------------------------------------------

static LRESULT CALLBACK messageWindowProc(HWND hwnd, UINT message, WPARAM w_param, LPARAM l_param) {
  switch (message) {
    case kRunQueuedTaskMessage:
      executeQueuedUiTasks();
      return 0;

    case kFinalizeShutdownMessage:
      shutdownCefOnUiThread();
      PostQuitMessage(0);
      return 0;
  }

  return DefWindowProcW(hwnd, message, w_param, l_param);
}

static LRESULT CALLBACK buniteWindowProc(HWND hwnd, UINT message, WPARAM w_param, LPARAM l_param) {
  WindowHost* window = reinterpret_cast<WindowHost*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));

  if (message == WM_NCCREATE) {
    auto* create_struct = reinterpret_cast<CREATESTRUCTW*>(l_param);
    window = static_cast<WindowHost*>(create_struct->lpCreateParams);
    SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(window));
    return DefWindowProcW(hwnd, message, w_param, l_param);
  }

  switch (message) {
    case WM_SETFOCUS:
      if (window) {
        emitWindowEvent(window->id, "focus");
      }
      break;

    case WM_KILLFOCUS:
      if (window) {
        emitWindowEvent(window->id, "blur");
      }
      break;

    case WM_MOVE:
      if (window) {
        syncWindowFrame(window);
        emitWindowEvent(
          window->id,
          "move",
          "{\"x\":" + std::to_string(window->frame.left) +
            ",\"y\":" + std::to_string(window->frame.top) +
            ",\"maximized\":" + (window->maximized ? "true" : "false") +
            ",\"minimized\":" + (window->minimized ? "true" : "false") + "}"
        );
      }
      break;

    case WM_ERASEBKGND:
      return 1;

    case WM_SIZE:
      if (window) {
        syncWindowFrame(window);

        {
          std::vector<ViewHost*> views_copy;
          {
            std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
            views_copy = window->views;
          }
          for (auto* view : views_copy) {
            resizeViewToFit(view);
          }
        }

        emitWindowEvent(
          window->id,
          "resize",
          "{\"x\":" + std::to_string(window->frame.left) +
            ",\"y\":" + std::to_string(window->frame.top) +
            ",\"width\":" + std::to_string(window->frame.right - window->frame.left) +
            ",\"height\":" + std::to_string(window->frame.bottom - window->frame.top) +
            ",\"maximized\":" + (window->maximized ? "true" : "false") +
            ",\"minimized\":" + (window->minimized ? "true" : "false") + "}"
        );
      }
      break;

    case WM_CLOSE:
      if (window && !window->close_pending.exchange(true)) {
        emitWindowEvent(window->id, "close-requested");
      }
      return 0;

    case WM_ENDSESSION:
      if (w_param && window) {
        g_runtime.shutting_down.store(true);
        destroyWindowHost(window);
      }
      return 0;

    case WM_NCDESTROY:
      if (window) {
        window->hwnd = nullptr;
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        finalizeWindowHost(window);
      }
      return 0;
  }

  return DefWindowProcW(hwnd, message, w_param, l_param);
}

// ---------------------------------------------------------------------------
// Window class registration & UI thread entry
// ---------------------------------------------------------------------------

bool registerWindowClasses() {
  static std::once_flag once;
  static bool registered = false;

  std::call_once(once, []() {
    HINSTANCE module = getCurrentModuleHandle();

    WNDCLASSW window_class{};
    window_class.lpfnWndProc = buniteWindowProc;
    window_class.hInstance = module;
    window_class.lpszClassName = kWindowClass;
    window_class.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    window_class.hbrBackground = nullptr;

    registered = RegisterClassW(&window_class) != 0;
  });

  return registered;
}

void uiThreadMain() {
  g_runtime.ui_thread_id = GetCurrentThreadId();
  OleInitialize(nullptr);

  bool init_success = false;
  if (registerWindowClasses()) {
    g_runtime.message_window = CreateWindowExW(
      0,
      L"STATIC",
      L"",
      0,
      0,
      0,
      0,
      0,
      nullptr,
      nullptr,
      getCurrentModuleHandle(),
      nullptr
    );

    if (g_runtime.message_window) {
      SetWindowLongPtrW(
        g_runtime.message_window,
        GWLP_WNDPROC,
        reinterpret_cast<LONG_PTR>(messageWindowProc)
      );

      // Consume a hostile STARTUPINFO.wShowWindow override.
      // When launched via `bun run`, the child receives STARTF_USESHOWWINDOW
      // with wShowWindow=SW_HIDE, which overrides the nCmdShow parameter of
      // the first ShowWindow call in the process.  We only consume the
      // override when it would hide windows; legitimate values like
      // SW_SHOWMAXIMIZED are left for the first real window to honour.
      {
        STARTUPINFOW si{};
        si.cb = sizeof(si);
        GetStartupInfoW(&si);
        if ((si.dwFlags & STARTF_USESHOWWINDOW) && si.wShowWindow == SW_HIDE) {
          ShowWindow(g_runtime.message_window, SW_HIDE);
        }
      }

      init_success = initializeCefOnUiThread();
    } else {
      BUNITE_ERROR("Failed to create message window (err=%lu).", GetLastError());
    }
  } else {
    BUNITE_ERROR("Failed to register window classes.");
  }

  {
    std::lock_guard<std::mutex> lock(g_runtime.lifecycle_mutex);
    g_runtime.init_success = init_success;
    g_runtime.init_finished = true;
    g_runtime.initialized = init_success;
  }
  g_runtime.lifecycle_cv.notify_all();

  if (!init_success) {
    if (g_runtime.message_window) {
      DestroyWindow(g_runtime.message_window);
      g_runtime.message_window = nullptr;
    }
    g_runtime.ui_thread_id = 0;
    {
      std::lock_guard<std::mutex> lock(g_runtime.lifecycle_mutex);
      g_runtime.shutdown_complete = true;
    }
    g_runtime.lifecycle_cv.notify_all();
    return;
  }

  MSG msg{};
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }

  if (g_runtime.message_window) {
    DestroyWindow(g_runtime.message_window);
    g_runtime.message_window = nullptr;
  }

  OleUninitialize();

  g_runtime.ui_thread_id = 0;
  {
    std::lock_guard<std::mutex> lock(g_runtime.lifecycle_mutex);
    g_runtime.initialized = false;
    g_runtime.shutdown_complete = true;
  }
  g_runtime.lifecycle_cv.notify_all();
}

} // namespace bunite_win
