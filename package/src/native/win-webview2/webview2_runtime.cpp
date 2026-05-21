#include "webview2_internal.h"

#include <algorithm>
#include <unordered_map>

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Make;

namespace bunite_webview2 {

RuntimeState g_runtime;

// Pending nav URI by (view_id, nav_id) — NavigationCompleted's get_Source()
// returns the previous committed URL on provisional failure, so we stash the
// URI at NavigationStarting and look it up on completion.
static std::unordered_map<uint64_t, std::string> g_nav_uris;
static uint64_t navKey(uint32_t view_id, uint64_t nav_id) {
  return (static_cast<uint64_t>(view_id) << 56) ^ nav_id;
}

static HINSTANCE g_module = nullptr;
static bool g_co_initialized = false;

HINSTANCE getCurrentModuleHandle() {
  if (g_module) return g_module;
  HMODULE mod = nullptr;
  GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                     GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                     reinterpret_cast<LPCWSTR>(&getCurrentModuleHandle), &mod);
  g_module = static_cast<HINSTANCE>(mod);
  return g_module;
}

// ---- task queue + pump ---------------------------------------------------
//
// Wake-message coalescing: one outstanding `kRunQueuedTaskMessage` is enough
// to guarantee a drain. Clearing the flag inside the message handler (before
// draining) preserves liveness for tasks posted during the drain itself.

static std::atomic<bool> g_wake_pending{false};

void postUiTask(std::function<void()> task) {
  {
    std::lock_guard<std::mutex> g(g_runtime.task_mutex);
    g_runtime.queued_tasks.push_back(std::move(task));
  }
  bool expected = false;
  if (g_runtime.message_window &&
      g_wake_pending.compare_exchange_strong(expected, true)) {
    PostMessageW(g_runtime.message_window, kRunQueuedTaskMessage, 0, 0);
  }
}

void executeQueuedUiTasks() {
  std::deque<std::function<void()>> drained;
  {
    std::lock_guard<std::mutex> g(g_runtime.task_mutex);
    drained.swap(g_runtime.queued_tasks);
  }
  for (auto& t : drained) {
    if (t) t();
  }
}

void pumpOnce() {
  MSG msg;
  while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
    if (msg.message == WM_QUIT) {
      g_runtime.shutting_down.store(true);
      return;
    }
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  // Drain queued tasks even if no message arrived.
  executeQueuedUiTasks();
}

// ---- window class + message window ---------------------------------------

LRESULT CALLBACK windowProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp);
LRESULT CALLBACK messageProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp);

static bool ensureClassRegistered(WNDCLASSEXW& cls) {
  WNDCLASSEXW probe{};
  probe.cbSize = sizeof(probe);
  if (GetClassInfoExW(cls.hInstance, cls.lpszClassName, &probe)) return true;
  if (RegisterClassExW(&cls) == 0) {
    DWORD err = GetLastError();
    if (err != ERROR_CLASS_ALREADY_EXISTS) {
      BUNITE_ERROR("webview2: RegisterClassExW(%ls) failed err=%lu",
                   cls.lpszClassName, err);
      return false;
    }
  }
  return true;
}

bool registerWindowClasses() {
  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = windowProc;
  wc.hInstance = getCurrentModuleHandle();
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hbrBackground = nullptr;
  wc.lpszClassName = kWindowClass;
  if (!ensureClassRegistered(wc)) return false;

  // View container — a plain child window we own. WebView2 controllers parent
  // to one of these, so SetWindowPos / EnableWindow on the container never
  // round-trips through the Edge GPU process (which deadlocks under load).
  WNDCLASSEXW vc{};
  vc.cbSize = sizeof(vc);
  vc.lpfnWndProc = DefWindowProcW;
  vc.hInstance = getCurrentModuleHandle();
  vc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  vc.hbrBackground = nullptr;
  vc.lpszClassName = kViewContainerClass;
  if (!ensureClassRegistered(vc)) return false;

  WNDCLASSEXW mc{};
  mc.cbSize = sizeof(mc);
  mc.lpfnWndProc = messageProc;
  mc.hInstance = getCurrentModuleHandle();
  mc.lpszClassName = L"BuniteWebView2MessageWindow";
  if (!ensureClassRegistered(mc)) return false;

  g_runtime.message_window = CreateWindowExW(0, mc.lpszClassName, L"",
                                              0, 0, 0, 0, 0,
                                              HWND_MESSAGE, nullptr,
                                              getCurrentModuleHandle(), nullptr);
  if (!g_runtime.message_window) return false;

  // Popup parking parent — a hidden top-level window. Children of HWND_MESSAGE
  // can't render (WebView2 child controllers won't initialize), so popup-minted
  // controllers live here until accept reparents to the user-visible host.
  g_runtime.popup_parent = CreateWindowExW(
      WS_EX_TOOLWINDOW, mc.lpszClassName, L"BunitePopupPark",
      WS_POPUP, 0, 0, 0, 0,
      nullptr, nullptr, getCurrentModuleHandle(), nullptr);
  if (!g_runtime.popup_parent) return false;

  // `bun run` passes STARTF_USESHOWWINDOW + SW_HIDE; Win documented behavior
  // is for the first ShowWindow call to use STARTUPINFO.wShowWindow instead
  // of the requested nCmdShow. Consume it here on the message window so the
  // first user-visible window's ShowWindow honors its argument.
  STARTUPINFOW si{};
  si.cb = sizeof(si);
  GetStartupInfoW(&si);
  if ((si.dwFlags & STARTF_USESHOWWINDOW) && si.wShowWindow == SW_HIDE) {
    ShowWindow(g_runtime.message_window, SW_HIDE);
  }
  return true;
}

// ---- environment bootstrap -----------------------------------------------

static void ensureEnvironment(std::function<void()> on_ready) {
  if (g_runtime.env_ready) { on_ready(); return; }
  g_runtime.env_waiters.push_back(std::move(on_ready));
  if (g_runtime.env_pending) return;
  g_runtime.env_pending = true;

  auto opts = Make<CoreWebView2EnvironmentOptions>();
  if (!g_runtime.additional_browser_arguments.empty()) {
    opts->put_AdditionalBrowserArguments(g_runtime.additional_browser_arguments.c_str());
  }
  if (!g_runtime.language.empty()) {
    opts->put_Language(g_runtime.language.c_str());
  }
  configureSchemes(opts.Get());

  std::wstring user_data = g_runtime.user_data_folder;
  if (user_data.empty()) {
    user_data = utf8ToWide(defaultUserDataFolder());
  }

  auto lifetime = g_runtime.lifetime;
  HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(
      nullptr,
      user_data.empty() ? nullptr : user_data.c_str(),
      opts.Get(),
      Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
          [lifetime](HRESULT cr, ICoreWebView2Environment* env) -> HRESULT {
            if (!lifetime || !lifetime->alive.load()) return S_OK;
            g_runtime.env_pending = false;
            auto waiters = std::move(g_runtime.env_waiters);
            if (FAILED(cr) || !env) {
              BUNITE_ERROR("webview2: env create failed hr=0x%08x — dropping %zu waiter(s)",
                           static_cast<unsigned>(cr), waiters.size());
              return S_OK;
            }
            g_runtime.env = env;
            g_runtime.env_ready = true;
            for (auto& w : waiters) w();
            return S_OK;
          }).Get());
  if (FAILED(hr)) {
    BUNITE_ERROR("webview2: CreateCoreWebView2EnvironmentWithOptions failed hr=0x%08x",
                 static_cast<unsigned>(hr));
    g_runtime.env_pending = false;
  }
}

// ---- event emission -----------------------------------------------------

// The JS side calls bunite_free_cstring on both pointers, so each must point
// at heap-owned memory we allocated with malloc/strdup.
void emitWindowEvent(uint32_t window_id, const char* name, const std::string& payload) {
  if (!g_runtime.window_event_handler) return;
  const char* body = payload.empty() ? "{}" : payload.c_str();
  g_runtime.window_event_handler(window_id, _strdup(name ? name : ""), _strdup(body));
}

void emitWebviewEvent(uint32_t view_id, const char* name, const std::string& payload) {
  if (!g_runtime.webview_event_handler) return;
  const char* body = payload.empty() ? "{}" : payload.c_str();
  g_runtime.webview_event_handler(view_id, _strdup(name ? name : ""), _strdup(body));
}

// ---- lookups ------------------------------------------------------------

WindowHost* getWindow(uint32_t id) {
  std::lock_guard<std::mutex> g(g_runtime.object_mutex);
  auto it = g_runtime.windows_by_id.find(id);
  return it == g_runtime.windows_by_id.end() ? nullptr : it->second;
}

ViewHost* getView(uint32_t id) {
  std::lock_guard<std::mutex> g(g_runtime.object_mutex);
  auto it = g_runtime.views_by_id.find(id);
  return it == g_runtime.views_by_id.end() ? nullptr : it->second;
}

// ---- window proc --------------------------------------------------------

static WindowHost* findWindowByHwnd(HWND hwnd) {
  std::lock_guard<std::mutex> g(g_runtime.object_mutex);
  for (auto& [id, w] : g_runtime.windows_by_id) {
    if (w->hwnd == hwnd) return w;
  }
  return nullptr;
}

static void applyViewLayout(ViewHost* v) {
  if (!v || !v->container_hwnd) return;
  RECT target = v->bounds;
  if (v->auto_resize && v->window && v->window->hwnd) {
    GetClientRect(v->window->hwnd, &target);
  }
  SetWindowPos(v->container_hwnd, nullptr,
               target.left, target.top,
               target.right - target.left, target.bottom - target.top,
               SWP_NOZORDER | SWP_NOACTIVATE);
  if (v->controller) {
    RECT inner{ 0, 0, target.right - target.left, target.bottom - target.top };
    v->controller->put_Bounds(inner);
  }
}

static void layoutViewsForWindow(WindowHost* w) {
  if (!w) return;
  for (ViewHost* v : w->views) applyViewLayout(v);
}

LRESULT CALLBACK windowProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_SIZE: {
      WindowHost* w = findWindowByHwnd(hwnd);
      if (w) layoutViewsForWindow(w);
      return 0;
    }
    case WM_CLOSE: {
      WindowHost* w = findWindowByHwnd(hwnd);
      if (w && !w->close_pending.load()) {
        w->close_pending.store(true);
        emitWindowEvent(w->id, "close-requested");
        return 0;       // wait for bunite_window_close
      }
      DestroyWindow(hwnd);
      return 0;
    }
    case WM_SETFOCUS:
    case WM_ACTIVATE: {
      WindowHost* w = findWindowByHwnd(hwnd);
      if (w) emitWindowEvent(w->id, "focus");
      break;
    }
    case WM_KILLFOCUS: {
      WindowHost* w = findWindowByHwnd(hwnd);
      if (w) emitWindowEvent(w->id, "blur");
      break;
    }
    case WM_DESTROY:
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

LRESULT CALLBACK messageProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == kRunQueuedTaskMessage) {
    // Reset the wake flag here, but DO NOT drain queued tasks from inside the
    // message dispatch — a task that invokes a WebView2 async COM method (e.g.
    // CreateCoreWebView2Controller) would otherwise enter a nested STA pump
    // and deadlock the Edge helper. Drain happens in pumpOnce() instead.
    g_wake_pending.store(false);
    return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

// ---- init / shutdown ----------------------------------------------------

// KILL_ON_JOB_CLOSE — Edge helpers die with bun.exe instead of holding the
// UDF SingletonLock. Handle leaked intentionally (kernel closes on exit).
static void reapChildrenOnExit() {
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) return;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION info{};
  info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info, sizeof(info)) ||
      !AssignProcessToJobObject(job, GetCurrentProcess())) {
    CloseHandle(job);  // already in a non-nestable job, etc — give up.
  }
}

bool initRuntime(const char* engine_dir, bool /*hide_console*/,
                 bool popup_blocking, const char* engine_config_json) {
  buniteApplyEnvLogLevel();
  BUNITE_INFO("webview2: bunite_init enter engine_dir=%s",
              (engine_dir && *engine_dir) ? engine_dir : "(null)");
  if (g_runtime.initialized.load()) return true;

  reapChildrenOnExit();

  HRESULT co = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
  if (SUCCEEDED(co)) g_co_initialized = true;
  else if (co != RPC_E_CHANGED_MODE) {
    BUNITE_ERROR("webview2: CoInitializeEx failed hr=0x%08x", static_cast<unsigned>(co));
    return false;
  }

  g_runtime.lifetime = std::make_shared<HostLifetime>();
  g_runtime.popup_blocking = popup_blocking;
  if (engine_dir && *engine_dir) g_runtime.user_data_folder = utf8ToWide(engine_dir);
  parseEngineConfig(engine_config_json ? engine_config_json : "",
                    g_runtime.user_data_folder,
                    g_runtime.additional_browser_arguments,
                    g_runtime.language);

  if (!registerWindowClasses()) {
    BUNITE_ERROR("webview2: window class registration failed");
    return false;
  }

  g_runtime.initialized.store(true);
  BUNITE_INFO("webview2: runtime initialized");

  // Eager-start the WebView2 environment so engine_version_string is ready by
  // the time the first BrowserWindow title is set. Bounded drain — if Edge
  // takes longer than the budget we just fall back to "unknown".
  ensureEnvironment([]() {});
  auto t0 = std::chrono::steady_clock::now();
  while (!g_runtime.env_ready && !g_runtime.shutting_down.load() &&
         std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now() - t0).count() < 500) {
    pumpOnce();
    Sleep(1);
  }

  return true;
}

void shutdownRuntime() {
  if (!g_runtime.initialized.load()) return;
  if (g_runtime.shutting_down.load()) return;
  g_runtime.shutting_down.store(true);

  cancelAllRouteRequests();

  std::vector<ViewHost*> views;
  std::vector<WindowHost*> windows;
  {
    std::lock_guard<std::mutex> g(g_runtime.object_mutex);
    for (auto& [_, v] : g_runtime.views_by_id) views.push_back(v);
    for (auto& [_, w] : g_runtime.windows_by_id) windows.push_back(w);
  }

  // Staged teardown — controller->Close() has no completion callback.
  // Each stage pumps so async Edge work can settle before the parent goes away.
  auto drain = [](int ms) {
    auto t0 = std::chrono::steady_clock::now();
    while (std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now() - t0).count() < ms) {
      pumpOnce();
      Sleep(1);
    }
  };

  for (auto* v : views) {
    if (v->controller) {
      v->closing.store(true);
      v->controller->Close();
    }
  }
  drain(250);

  for (auto* v : views) {
    if (v->container_hwnd) {
      DestroyWindow(v->container_hwnd);
      v->container_hwnd = nullptr;
    }
  }
  drain(100);

  for (auto* w : windows) {
    if (w->hwnd) DestroyWindow(w->hwnd);
  }
  drain(250);

  // Flip alive BEFORE deleting view/window structs so any straggling COM
  // callback that fires during the deletes short-circuits.
  if (g_runtime.lifetime) g_runtime.lifetime->alive.store(false);

  {
    std::lock_guard<std::mutex> g(g_runtime.object_mutex);
    for (auto* v : views) delete v;
    for (auto* w : windows) delete w;
    g_runtime.views_by_id.clear();
    g_runtime.windows_by_id.clear();
  }

  // Reset mutable runtime state so a re-init starts from a clean slate.
  {
    std::lock_guard<std::mutex> g(g_runtime.task_mutex);
    g_runtime.queued_tasks.clear();
  }
  {
    std::lock_guard<std::mutex> g(g_runtime.route_mutex);
    g_runtime.pending_routes.clear();
    g_runtime.registered_routes.clear();
    g_runtime.next_route_request_id = 1;
  }
  {
    std::lock_guard<std::mutex> g(g_runtime.permission_mutex);
    g_runtime.pending_permissions.clear();
    g_runtime.next_permission_request_id = 1;
  }
  g_runtime.env_waiters.clear();
  g_runtime.env_pending = false;
  g_runtime.env_ready = false;
  g_runtime.env.Reset();

  if (g_runtime.message_window) {
    DestroyWindow(g_runtime.message_window);
    g_runtime.message_window = nullptr;
  }
  if (g_co_initialized) { CoUninitialize(); g_co_initialized = false; }
  g_runtime.shutting_down.store(false);
  g_runtime.initialized.store(false);
}

// ---- window CRUD --------------------------------------------------------

static DWORD styleForTitleBar(const std::wstring& tbs) {
  if (tbs == L"hidden" || tbs == L"hiddenInset") {
    return WS_POPUP | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;
  }
  return WS_OVERLAPPEDWINDOW;
}

bool createWindow(uint32_t window_id, double x, double y, double w, double h,
                  const char* title, const char* title_bar_style,
                  bool transparent, bool hidden, bool minimized, bool maximized) {
  BUNITE_DEBUG("webview2: createWindow id=%u xy=(%g,%g) size=(%g,%g) hidden=%d trans=%d",
              window_id, x, y, w, h, hidden, transparent);
  WindowHost* host = new WindowHost();
  host->id = window_id;
  host->title = title ? utf8ToWide(title) : L"";
  host->title_bar_style = title_bar_style ? utf8ToWide(title_bar_style) : L"";
  host->transparent = transparent;
  host->hidden = hidden;
  host->minimized = minimized;
  host->maximized = maximized;

  DWORD style = styleForTitleBar(host->title_bar_style);
  DWORD ex_style = 0;
  if (transparent) ex_style |= WS_EX_LAYERED | WS_EX_NOREDIRECTIONBITMAP;

  int ix = (x == 0 && y == 0) ? CW_USEDEFAULT : static_cast<int>(x);
  int iy = (x == 0 && y == 0) ? CW_USEDEFAULT : static_cast<int>(y);
  int iw = static_cast<int>(w > 0 ? w : 800);
  int ih = static_cast<int>(h > 0 ? h : 600);

  HWND hwnd = CreateWindowExW(ex_style, kWindowClass, host->title.c_str(),
                              style, ix, iy, iw, ih, nullptr, nullptr,
                              getCurrentModuleHandle(), nullptr);
  if (!hwnd) {
    BUNITE_ERROR("webview2: CreateWindowExW failed err=%lu (class=%ls)",
                 GetLastError(), kWindowClass);
    delete host;
    return false;
  }
  BUNITE_DEBUG("webview2: createWindow hwnd=%p id=%u", hwnd, window_id);
  host->hwnd = hwnd;
  if (transparent) {
    // Fully transparent layered window — pixels are sourced from the WebView2
    // controller (Stage 3 sets DefaultBackgroundColor to {0,0,0,0}).
    SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
  }

  {
    std::lock_guard<std::mutex> g(g_runtime.object_mutex);
    g_runtime.windows_by_id[window_id] = host;
  }

  if (maximized) ShowWindow(hwnd, SW_MAXIMIZE);
  else if (minimized) ShowWindow(hwnd, SW_MINIMIZE);
  else if (!hidden) ShowWindow(hwnd, SW_SHOW);
  return true;
}

void destroyWindow(uint32_t window_id) {
  WindowHost* w = nullptr;
  bool last_window = false;
  {
    std::lock_guard<std::mutex> g(g_runtime.object_mutex);
    auto it = g_runtime.windows_by_id.find(window_id);
    if (it == g_runtime.windows_by_id.end()) return;
    w = it->second;
  }
  if (!w) return;
  std::vector<ViewHost*> views = w->views;
  for (auto* v : views) destroyView(v->id);
  if (w->hwnd) {
    DestroyWindow(w->hwnd);
    w->hwnd = nullptr;
  }
  {
    std::lock_guard<std::mutex> g(g_runtime.object_mutex);
    g_runtime.windows_by_id.erase(window_id);
    last_window = g_runtime.windows_by_id.empty();
  }
  emitWindowEvent(window_id, "close");
  if (last_window) emitWindowEvent(0, "all-windows-closed");
  delete w;
}

// ---- view CRUD ----------------------------------------------------------

static void attachControllerCallbacks(ViewHost* view);

// Synchronous teardown for a half-initialized view — called when wireView fails
// before the controller is alive. Cleans HWND + map entries + emits a signal so
// the JS side's `whenReady()` rejects instead of hanging.
static void abortView(uint32_t view_id) {
  ViewHost* v = nullptr;
  {
    std::lock_guard<std::mutex> g(g_runtime.object_mutex);
    auto it = g_runtime.views_by_id.find(view_id);
    if (it == g_runtime.views_by_id.end()) return;
    v = it->second;
    g_runtime.views_by_id.erase(it);
  }
  if (!v) return;
  if (v->window) {
    auto& vs = v->window->views;
    vs.erase(std::remove(vs.begin(), vs.end(), v), vs.end());
  }
  if (v->container_hwnd) {
    DestroyWindow(v->container_hwnd);
    v->container_hwnd = nullptr;
  }
  emitWebviewEvent(view_id, "view-init-failed");
  delete v;
}

static void wireView(ViewHost* view, std::function<void()> on_attached) {
  if (!g_runtime.env) {
    BUNITE_ERROR("webview2: wireView with no env");
    abortView(view->id);
    return;
  }
  auto lifetime = g_runtime.lifetime;
  uint32_t view_id = view->id;
  HWND host_hwnd = view->window->hwnd;

  // Create per-view container HWND (parent = host window). Start hidden so a
  // controller that fails to materialise doesn't flash an empty rectangle, and
  // so renderer-driven `setHidden(true)` can land before the surface appears.
  RECT initial = view->bounds;
  if (view->auto_resize) GetClientRect(host_hwnd, &initial);
  view->container_hwnd = CreateWindowExW(
      0, kViewContainerClass, L"",
      WS_CHILD | WS_CLIPCHILDREN,
      initial.left, initial.top,
      initial.right - initial.left, initial.bottom - initial.top,
      host_hwnd, nullptr, getCurrentModuleHandle(), nullptr);
  if (!view->container_hwnd) {
    BUNITE_ERROR("webview2: container HWND creation failed view=%u err=%lu",
                 view_id, GetLastError());
    abortView(view_id);
    return;
  }
  HRESULT hr = g_runtime.env->CreateCoreWebView2Controller(
      view->container_hwnd,
      Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
          [lifetime, view_id, on_attached](HRESULT cr, ICoreWebView2Controller* ctl) -> HRESULT {
            BUNITE_DEBUG("webview2: controller-create completion view=%u hr=0x%08x",
                        view_id, static_cast<unsigned>(cr));
            if (!lifetime || !lifetime->alive.load()) return S_OK;
            ViewHost* v = getView(view_id);
            if (!v) return S_OK;
            if (FAILED(cr) || !ctl) {
              BUNITE_ERROR("webview2: controller create failed hr=0x%08x",
                           static_cast<unsigned>(cr));
              abortView(view_id);
              return S_OK;
            }
            v->controller = ctl;
            ctl->QueryInterface(IID_PPV_ARGS(&v->controller2));
            ctl->get_CoreWebView2(&v->webview);
            if (v->webview) v->webview->QueryInterface(IID_PPV_ARGS(&v->webview2));

            if (v->window->transparent && v->controller2) {
              COREWEBVIEW2_COLOR clear{0, 0, 0, 0};
              v->controller2->put_DefaultBackgroundColor(clear);
            }

            // Controller bounds are container-relative.
            RECT cont{};
            GetClientRect(v->container_hwnd, &cont);
            ctl->put_Bounds(cont);
            ctl->put_IsVisible(v->pending_visible);
            if (v->pending_visible) ShowWindow(v->container_hwnd, SW_SHOWNA);

            attachControllerCallbacks(v);
            attachAppResFilter(v);
            v->ready.store(true);

            // Inject preload script. Wrapper enforces:
            //  - main frame only (matching CEF's OnContextCreated main-frame gate)
            //  - origin allowlist when `preload_origins` is non-empty
            // Empty allowlist = inject on every main frame (CEF parity default).
            if (!v->preload_script.empty() && v->webview) {
              std::string allowlist = "[";
              for (size_t i = 0; i < v->preload_origins.size(); ++i) {
                if (i) allowlist += ",";
                allowlist += "\"" + escapeJsonString(v->preload_origins[i]) + "\"";
              }
              allowlist += "]";
              std::string body =
                  "(function(){if(window.self!==window.top)return;"
                  "var __a=" + allowlist +
                  ",__o=location.origin;"
                  "if(__a.length){var __m=function(p,v){var i=0,j=0,s=-1,k=0,L=function(c){return c.charCodeAt(0)|32;};"
                  "while(j<v.length){if(i<p.length&&(p[i]===\"?\"||L(p[i])===L(v[j]))){i++;j++;}"
                  "else if(i<p.length&&p[i]===\"*\"){s=i++;k=j;}"
                  "else if(s>=0){i=s+1;j=++k;}else{return false;}}"
                  "while(i<p.length&&p[i]===\"*\")i++;return i===p.length;};"
                  "var __ok=false;for(var i=0;i<__a.length;i++){if(__m(__a[i],__o)){__ok=true;break;}}"
                  "if(!__ok)return;}"
                  + v->preload_script +
                  "})();";
              std::wstring wpreload = utf8ToWide(body);
              auto lt = lifetime;
              v->webview->AddScriptToExecuteOnDocumentCreated(
                  wpreload.c_str(),
                  Callback<ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler>(
                      [lt, view_id](HRESULT, LPCWSTR id) -> HRESULT {
                        if (!lt || !lt->alive.load()) return S_OK;
                        ViewHost* vv = getView(view_id);
                        if (vv && id) vv->add_script_id = id;
                        return S_OK;
                      }).Get());
            }

            // Initial navigation.
            if (!v->url.empty()) {
              v->webview->Navigate(utf8ToWide(v->url).c_str());
            } else if (!v->html.empty()) {
              v->webview->NavigateToString(utf8ToWide(v->html).c_str());
            }

            emitWebviewEvent(v->id, "view-ready");
            if (on_attached) on_attached();
            return S_OK;
          }).Get());
  if (FAILED(hr)) {
    BUNITE_ERROR("webview2: CreateCoreWebView2Controller failed hr=0x%08x",
                 static_cast<unsigned>(hr));
    abortView(view_id);
  }
}

bool createView(uint32_t view_id, uint32_t window_id,
                const char* url, const char* html,
                const char* preload, const char* appres_root,
                const char* navigation_rules_json,
                double x, double y, double w, double h,
                bool auto_resize, bool sandbox,
                const char* preload_origins_json) {
  BUNITE_DEBUG("webview2: createView view=%u window=%u url=%s",
              view_id, window_id, url && *url ? url : "(none)");
  WindowHost* window = getWindow(window_id);
  if (!window) {
    BUNITE_ERROR("webview2: createView for unknown window_id=%u", window_id);
    return false;
  }

  ViewHost* v = new ViewHost();
  v->id = view_id;
  v->window = window;
  v->url = url ? url : "";
  v->html = html ? html : "";
  v->preload_script = preload ? preload : "";
  v->appres_root = appres_root ? appres_root : "";
  v->sandbox = sandbox;
  v->auto_resize = auto_resize;
  v->bounds = { static_cast<LONG>(x), static_cast<LONG>(y),
                static_cast<LONG>(x + w), static_cast<LONG>(y + h) };
  if (navigation_rules_json && *navigation_rules_json) {
    v->navigation_rules = parseNavigationRulesJson(navigation_rules_json);
  }
  if (preload_origins_json && *preload_origins_json) {
    v->preload_origins = parsePreloadOriginsJson(preload_origins_json);
  }

  {
    std::lock_guard<std::mutex> g(g_runtime.object_mutex);
    g_runtime.views_by_id[view_id] = v;
  }
  window->views.push_back(v);

  // Defer the WebView2 controller bootstrap. Calling CreateCoreWebView2Controller
  // synchronously from inside a Win32 message dispatch (e.g. a renderer-driven
  // SurfaceCap.init RPC) enters a nested STA pump that can deadlock the Edge
  // helper's GPU IPC. Hopping through the queued-task loop guarantees the call
  // runs at top of the next pump iteration.
  postUiTask([view_id]() {
    ensureEnvironment([view_id]() {
      ViewHost* v = getView(view_id);
      if (!v) return;
      wireView(v, nullptr);
    });
  });
  return true;
}

void destroyView(uint32_t id) {
  ViewHost* v = nullptr;
  {
    std::lock_guard<std::mutex> g(g_runtime.object_mutex);
    auto it = g_runtime.views_by_id.find(id);
    if (it == g_runtime.views_by_id.end()) return;
    v = it->second;
    g_runtime.views_by_id.erase(it);
  }
  if (!v) return;

  if (v->window) {
    auto& vs = v->window->views;
    vs.erase(std::remove(vs.begin(), vs.end(), v), vs.end());
  }

  // Defer Close() → container destroy → delete across three pump ticks. Edge
  // gets at least one tick after Close() to settle before its parent HWND
  // vanishes; see shutdownRuntime's staged drains for the same reason.
  postUiTask([v]() {
    if (v->controller) {
      v->closing.store(true);
      v->controller->Close();
    }
    postUiTask([v]() {
      if (v->container_hwnd) {
        DestroyWindow(v->container_hwnd);
        v->container_hwnd = nullptr;
      }
      postUiTask([v]() { delete v; });
    });
  });
}

// ---- per-view event wiring ----------------------------------------------

static bool originAllowedForPreload(const ViewHost* v, const std::string& origin) {
  if (v->preload_origins.empty()) return true;  // engine-agnostic default
  for (auto& o : v->preload_origins) {
    if (globMatchCaseInsensitive(o, origin)) return true;
  }
  return false;
}

static void enumerateChildHwnds(HWND root, std::vector<HWND>& out) {
  EnumChildWindows(root, [](HWND child, LPARAM lp) -> BOOL {
    reinterpret_cast<std::vector<HWND>*>(lp)->push_back(child);
    return TRUE;
  }, reinterpret_cast<LPARAM>(&out));
}

static void applyInputPassthrough(ViewHost* v, bool passthrough) {
  if (!v->container_hwnd) return;
  // Disable our container (Bunite-owned). This also gates input to every
  // descendant — including the Edge-owned controller HWNDs — without ever
  // touching those cross-process windows, which was the original deadlock path.
  EnableWindow(v->container_hwnd, passthrough ? FALSE : TRUE);
}

static void attachControllerCallbacks(ViewHost* view) {
  if (!view->webview) return;
  auto lifetime = g_runtime.lifetime;
  uint32_t view_id = view->id;
  // Token reuse OK — controller->Close() releases all add_* handlers.
  EventRegistrationToken tok;

  // NavigationStarting — emit "will-navigate" (parity with CEF/mac/linux,
  // which fire regardless of allow), then cancel if nav rules say block.
  // Also emit "load-start" for the surfaceEvents stream + stash URI for
  // NavigationCompleted lookup (failure case: get_Source() returns prior URL).
  view->webview->add_NavigationStarting(
      Callback<ICoreWebView2NavigationStartingEventHandler>(
          [lifetime, view_id](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
            if (!lifetime || !lifetime->alive.load()) return S_OK;
            ViewHost* v = getView(view_id);
            if (!v) return S_OK;
            LPWSTR uri_raw = nullptr;
            args->get_Uri(&uri_raw);
            std::string url = wideToUtf8(uri_raw);
            if (uri_raw) CoTaskMemFree(uri_raw);
            emitWebviewEvent(v->id, "will-navigate", url);
            if (!shouldAllowNavigation(v, url)) {
              args->put_Cancel(TRUE);
              return S_OK;
            }
            UINT64 nav_id = 0;
            args->get_NavigationId(&nav_id);
            g_nav_uris[navKey(view_id, nav_id)] = url;
            emitWebviewEvent(v->id, "load-start", url);
            return S_OK;
          }).Get(),
      &tok);

  // SourceChanged — URL commit point; map to did-navigate (surfaceEvents
  // `navigate` arm). Distinct from NavigationCompleted which fires later.
  view->webview->add_SourceChanged(
      Callback<ICoreWebView2SourceChangedEventHandler>(
          [lifetime, view_id](ICoreWebView2* wv, ICoreWebView2SourceChangedEventArgs*) -> HRESULT {
            if (!lifetime || !lifetime->alive.load()) return S_OK;
            LPWSTR src_raw = nullptr;
            if (wv) wv->get_Source(&src_raw);
            std::string url = wideToUtf8(src_raw);
            if (src_raw) CoTaskMemFree(src_raw);
            emitWebviewEvent(view_id, "did-navigate", url);
            return S_OK;
          }).Get(),
      &tok);

  // NavigationCompleted — load lifecycle terminator. Success → load-finish
  // + dom-ready; failure → load-fail with WebErrorStatus as reason. Use the
  // URI we stashed at NavigationStarting — get_Source() returns the prior
  // committed URL on provisional-navigation failure.
  view->webview->add_NavigationCompleted(
      Callback<ICoreWebView2NavigationCompletedEventHandler>(
          [lifetime, view_id](ICoreWebView2* wv, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT {
            if (!lifetime || !lifetime->alive.load()) return S_OK;
            BOOL ok = FALSE;
            args->get_IsSuccess(&ok);
            UINT64 nav_id = 0;
            args->get_NavigationId(&nav_id);
            std::string url;
            auto it = g_nav_uris.find(navKey(view_id, nav_id));
            if (it != g_nav_uris.end()) {
              url = std::move(it->second);
              g_nav_uris.erase(it);
            } else {
              LPWSTR src_raw = nullptr;
              if (wv) wv->get_Source(&src_raw);
              url = wideToUtf8(src_raw);
              if (src_raw) CoTaskMemFree(src_raw);
            }
            if (ok) {
              emitWebviewEvent(view_id, "load-finish", url);
              emitWebviewEvent(view_id, "dom-ready", url);
            } else {
              COREWEBVIEW2_WEB_ERROR_STATUS status = COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN;
              args->get_WebErrorStatus(&status);
              std::string payload = "{\"url\":\"" + escapeJsonString(url) +
                                    "\",\"reason\":\"WebErrorStatus_" + std::to_string(static_cast<int>(status)) + "\"}";
              emitWebviewEvent(view_id, "load-fail", payload);
            }
            return S_OK;
          }).Get(),
      &tok);

  // ScriptDialogOpening — alert / confirm / prompt / beforeunload. Defer the
  // event so host can decide via `respondToDialog`.
  view->webview->add_ScriptDialogOpening(
      Callback<ICoreWebView2ScriptDialogOpeningEventHandler>(
          [lifetime, view_id](ICoreWebView2*, ICoreWebView2ScriptDialogOpeningEventArgs* args) -> HRESULT {
            if (!lifetime || !lifetime->alive.load()) return S_OK;
            ViewHost* v = getView(view_id);
            if (!v) return S_OK;
            ComPtr<ICoreWebView2Deferral> deferral;
            args->GetDeferral(&deferral);
            COREWEBVIEW2_SCRIPT_DIALOG_KIND kind = COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT;
            args->get_Kind(&kind);
            LPWSTR msg_raw = nullptr;
            args->get_Message(&msg_raw);
            std::string message = wideToUtf8(msg_raw);
            if (msg_raw) CoTaskMemFree(msg_raw);
            LPWSTR def_raw = nullptr;
            args->get_DefaultText(&def_raw);
            std::string default_prompt = wideToUtf8(def_raw);
            if (def_raw) CoTaskMemFree(def_raw);
            const char* kind_str = (kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_CONFIRM) ? "confirm"
                                 : (kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_PROMPT) ? "prompt"
                                 : (kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_BEFOREUNLOAD) ? "beforeunload"
                                 : "alert";
            const uint32_t rid = v->next_dialog_request_id++;
            v->pending_dialogs[rid] = ViewHost::PendingDialog{ args, std::move(deferral) };
            std::string payload = "{\"requestId\":" + std::to_string(rid) +
                                  ",\"kind\":\"" + kind_str +
                                  "\",\"message\":\"" + escapeJsonString(message) + "\"";
            if (kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_PROMPT) {
              payload += ",\"defaultPrompt\":\"" + escapeJsonString(default_prompt) + "\"";
            }
            payload += "}";
            emitWebviewEvent(view_id, "dialog", payload);
            return S_OK;
          }).Get(),
      &tok);

  // DocumentTitleChanged — surface for automation surfaceEvents title-change arm.
  view->webview->add_DocumentTitleChanged(
      Callback<ICoreWebView2DocumentTitleChangedEventHandler>(
          [lifetime, view_id](ICoreWebView2* wv, IUnknown*) -> HRESULT {
            if (!lifetime || !lifetime->alive.load()) return S_OK;
            LPWSTR title_raw = nullptr;
            if (wv) wv->get_DocumentTitle(&title_raw);
            std::string title = wideToUtf8(title_raw);
            if (title_raw) CoTaskMemFree(title_raw);
            std::string payload = "{\"title\":\"" + escapeJsonString(title) + "\"}";
            emitWebviewEvent(view_id, "title-changed", payload);
            return S_OK;
          }).Get(),
      &tok);

  // PermissionRequested — map to bunite kind and stash deferral.
  view->webview->add_PermissionRequested(
      Callback<ICoreWebView2PermissionRequestedEventHandler>(
          [lifetime, view_id](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) -> HRESULT {
            if (!lifetime || !lifetime->alive.load()) return S_OK;
            ViewHost* v = getView(view_id);
            if (!v) return S_OK;
            COREWEBVIEW2_PERMISSION_KIND kind;
            args->get_PermissionKind(&kind);
            uint32_t bit = permissionKindToBuniteBit(kind);

            ComPtr<ICoreWebView2Deferral> deferral;
            args->GetDeferral(&deferral);

            uint32_t req_id;
            {
              std::lock_guard<std::mutex> g(g_runtime.permission_mutex);
              req_id = g_runtime.next_permission_request_id++;
              PendingPermissionRequest p;
              p.view_id = v->id;
              p.bunite_kind = bit;
              p.args = args;
              p.deferral = deferral;
              g_runtime.pending_permissions[req_id] = std::move(p);
            }
            std::string payload = "{\"requestId\":" + std::to_string(req_id) +
                                  ",\"kind\":" + std::to_string(bit) + "}";
            emitWebviewEvent(v->id, "permission-requested", payload);
            return S_OK;
          }).Get(),
      &tok);

  // NewWindowRequested — eager-mint a popup ViewHost with the requested
  // CoreWebView2 (preserves window.opener) and emit `popup-requested`. Host
  // adopts via `bunite_view_popup_accept` or rejects via `bunite_view_popup_dismiss`;
  // SurfaceManager arms a 5s timer for the auto-dismiss safety net.
  view->webview->add_NewWindowRequested(
      Callback<ICoreWebView2NewWindowRequestedEventHandler>(
          [lifetime, view_id](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args_raw) -> HRESULT {
            if (!lifetime || !lifetime->alive.load()) return S_OK;
            ComPtr<ICoreWebView2NewWindowRequestedEventArgs> args(args_raw);
            LPWSTR uri_raw = nullptr;
            args->get_Uri(&uri_raw);
            std::string url = wideToUtf8(uri_raw);
            if (uri_raw) CoTaskMemFree(uri_raw);
            ComPtr<ICoreWebView2Deferral> deferral;
            args->GetDeferral(&deferral);
            args->put_Handled(TRUE);
            // Popup IDs live in the upper u32 half; TS allocator stays below.
            static std::atomic<uint32_t> g_popup_seq{0x80000000u};
            uint32_t new_view_id = g_popup_seq.fetch_add(1);
            auto* popup_raw = new ViewHost();
            popup_raw->id = new_view_id;
            popup_raw->window = nullptr;
            popup_raw->bounds = RECT{0, 0, 0, 0};
            popup_raw->auto_resize = false;
            popup_raw->container_hwnd = CreateWindowExW(
                0, kViewContainerClass, L"", WS_CHILD | WS_CLIPCHILDREN,
                0, 0, 0, 0, g_runtime.popup_parent,
                nullptr, getCurrentModuleHandle(), nullptr);
            {
              std::lock_guard<std::mutex> g(g_runtime.object_mutex);
              g_runtime.views_by_id[new_view_id] = popup_raw;
            }
            auto cleanupPopup = [new_view_id]() {
              auto* p = getView(new_view_id);
              if (!p) return;
              if (p->container_hwnd) DestroyWindow(p->container_hwnd);
              {
                std::lock_guard<std::mutex> g(g_runtime.object_mutex);
                g_runtime.views_by_id.erase(new_view_id);
              }
              delete p;
            };
            HRESULT sync_hr = g_runtime.env->CreateCoreWebView2Controller(
                popup_raw->container_hwnd,
                Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                    [lifetime, view_id, new_view_id, url, args, deferral, cleanupPopup](HRESULT hr, ICoreWebView2Controller* controller) -> HRESULT {
                      if (!lifetime || !lifetime->alive.load()) {
                        if (deferral) deferral->Complete();
                        cleanupPopup();
                        return S_OK;
                      }
                      auto* popup = getView(new_view_id);
                      if (!popup || FAILED(hr) || !controller) {
                        if (deferral) deferral->Complete();
                        cleanupPopup();
                        return S_OK;
                      }
                      popup->controller = controller;
                      controller->get_CoreWebView2(&popup->webview);
                      if (popup->webview) {
                        args->put_NewWindow(popup->webview.Get());
                      }
                      controller->put_IsVisible(FALSE);
                      RECT zero{0,0,0,0};
                      controller->put_Bounds(zero);
                      attachControllerCallbacks(popup);
                      attachAppResFilter(popup);
                      popup->ready.store(true);
                      if (deferral) deferral->Complete();
                      std::string payload = "{\"newSurfaceId\":" + std::to_string(new_view_id) +
                                            ",\"url\":\"" + escapeJsonString(url) +
                                            "\",\"disposition\":\"popup\"}";
                      emitWebviewEvent(view_id, "popup-requested", payload);
                      return S_OK;
                    }).Get());
            if (FAILED(sync_hr)) {
              if (deferral) deferral->Complete();
              cleanupPopup();
            }
            return S_OK;
          }).Get(),
      &tok);

  // WindowCloseRequested — surfaced as window-level close-requested.
  view->webview->add_WindowCloseRequested(
      Callback<ICoreWebView2WindowCloseRequestedEventHandler>(
          [lifetime, view_id](ICoreWebView2*, IUnknown*) -> HRESULT {
            if (!lifetime || !lifetime->alive.load()) return S_OK;
            ViewHost* v = getView(view_id);
            if (v && v->window) emitWindowEvent(v->window->id, "close-requested");
            return S_OK;
          }).Get(),
      &tok);

  // DownloadStarting (ICoreWebView2_4) — policy-driven: block | auto | ask.
  // Default block preserves the original behavior.
  ComPtr<ICoreWebView2_4> wv4;
  view->webview->QueryInterface(IID_PPV_ARGS(&wv4));
  if (wv4) {
    static std::atomic<uint32_t> g_download_seq{1};
    wv4->add_DownloadStarting(
        Callback<ICoreWebView2DownloadStartingEventHandler>(
            [lifetime, view_id, view](ICoreWebView2*, ICoreWebView2DownloadStartingEventArgs* args) -> HRESULT {
              if (!lifetime || !lifetime->alive.load()) return S_OK;
              ComPtr<ICoreWebView2DownloadOperation> op;
              args->get_DownloadOperation(&op);
              LPWSTR uri_raw = nullptr;
              if (op) op->get_Uri(&uri_raw);
              std::string url = wideToUtf8(uri_raw);
              if (uri_raw) CoTaskMemFree(uri_raw);
              int32_t policy = view->download_policy.load();
              const std::string id = "wv2-" + std::to_string(g_download_seq.fetch_add(1));
              // Only policy=0 (auto) allows. `ask` (1) is reserved and falls
              // back to block until implemented.
              if (policy != 0) {
                args->put_Cancel(TRUE);
                std::string payload = "{\"kind\":\"blocked\",\"id\":\"" + id +
                                      "\",\"url\":\"" + escapeJsonString(url) +
                                      "\",\"reason\":\"host-policy\"}";
                emitWebviewEvent(view_id, "download-event", payload);
                return S_OK;
              }
              // auto: don't cancel; report started + progress + completed.
              LPWSTR sugg_raw = nullptr;
              if (op) op->get_ContentDisposition(&sugg_raw);  // fallback
              LPWSTR result_path_raw = nullptr;
              args->get_ResultFilePath(&result_path_raw);
              std::string suggested = result_path_raw ? wideToUtf8(result_path_raw) : "";
              // strip dir, keep filename only.
              auto slash = suggested.find_last_of("/\\");
              if (slash != std::string::npos) suggested = suggested.substr(slash + 1);
              if (sugg_raw) CoTaskMemFree(sugg_raw);
              // Optional host downloadDir override.
              std::string overrideDir = view->download_dir;
              if (!overrideDir.empty() && result_path_raw) {
                std::string base = suggested.empty() ? "download" : suggested;
                std::string custom = overrideDir;
                if (!custom.empty() && custom.back() != '\\' && custom.back() != '/') custom.push_back('\\');
                custom += base;
                args->put_ResultFilePath(utf8ToWide(custom).c_str());
              }
              if (result_path_raw) CoTaskMemFree(result_path_raw);
              int64_t total = 0;
              if (op) op->get_TotalBytesToReceive(&total);
              std::string startPayload = "{\"kind\":\"started\",\"id\":\"" + id +
                                         "\",\"url\":\"" + escapeJsonString(url) +
                                         "\",\"suggestedFilename\":\"" + escapeJsonString(suggested) + "\"";
              if (total > 0) startPayload += ",\"sizeBytes\":" + std::to_string(total);
              startPayload += "}";
              emitWebviewEvent(view_id, "download-event", startPayload);
              if (op) {
                EventRegistrationToken btok{};
                op->add_BytesReceivedChanged(
                    Callback<ICoreWebView2BytesReceivedChangedEventHandler>(
                        [lifetime, view_id, id, op](ICoreWebView2DownloadOperation*, IUnknown*) -> HRESULT {
                          if (!lifetime || !lifetime->alive.load()) return S_OK;
                          INT64 rec = 0; op->get_BytesReceived(&rec);
                          INT64 tot = 0; op->get_TotalBytesToReceive(&tot);
                          std::string payload = "{\"kind\":\"progress\",\"id\":\"" + id +
                                                "\",\"receivedBytes\":" + std::to_string(rec);
                          if (tot > 0) payload += ",\"totalBytes\":" + std::to_string(tot);
                          payload += "}";
                          emitWebviewEvent(view_id, "download-event", payload);
                          return S_OK;
                        }).Get(),
                    &btok);
                EventRegistrationToken stok{};
                op->add_StateChanged(
                    Callback<ICoreWebView2StateChangedEventHandler>(
                        [lifetime, view_id, id, op](ICoreWebView2DownloadOperation*, IUnknown*) -> HRESULT {
                          if (!lifetime || !lifetime->alive.load()) return S_OK;
                          COREWEBVIEW2_DOWNLOAD_STATE state;
                          op->get_State(&state);
                          if (state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED) {
                            LPWSTR path_raw = nullptr; op->get_ResultFilePath(&path_raw);
                            std::string path = wideToUtf8(path_raw);
                            if (path_raw) CoTaskMemFree(path_raw);
                            std::string payload = "{\"kind\":\"completed\",\"id\":\"" + id +
                                                  "\",\"localPath\":\"" + escapeJsonString(path) + "\"}";
                            emitWebviewEvent(view_id, "download-event", payload);
                          } else if (state == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED) {
                            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON reason;
                            op->get_InterruptReason(&reason);
                            std::string payload = "{\"kind\":\"failed\",\"id\":\"" + id +
                                                  "\",\"reason\":\"interrupted-" + std::to_string(reason) + "\"}";
                            emitWebviewEvent(view_id, "download-event", payload);
                          }
                          return S_OK;
                        }).Get(),
                    &stok);
              }
              return S_OK;
            }).Get(),
        &tok);
  }

  if (view->pending_passthrough) applyInputPassthrough(view, true);
}

// Re-exported helper for ffi.cpp.
void setViewInputPassthrough(ViewHost* v, bool passthrough) {
  v->pending_passthrough = passthrough;
  if (v->ready.load()) applyInputPassthrough(v, passthrough);
}

}  // namespace bunite_webview2
