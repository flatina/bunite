#include "native_host_internal.h"

namespace {

class BuniteCefApp : public CefApp, public CefBrowserProcessHandler {
public:
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override {
    return this;
  }

  void OnBeforeCommandLineProcessing(const CefString&, CefRefPtr<CefCommandLine> command_line) override {
    if (!g_runtime.popup_blocking) {
      command_line->AppendSwitch("disable-popup-blocking");
    }

    // --- Bunite defaults ---
    if (g_runtime.chromium_flags.find("in-process-gpu") == g_runtime.chromium_flags.end()) {
      g_runtime.chromium_flags["in-process-gpu"] = "true";
    }

    if (g_runtime.chromium_flags.find("enable-features") == g_runtime.chromium_flags.end()) {
      g_runtime.chromium_flags["enable-features"] = "NetworkServiceInProcess";
    } else {
      std::string& existing = g_runtime.chromium_flags["enable-features"];
      if (existing.find("NetworkServiceInProcess") == std::string::npos && existing != "false") {
        if (existing.empty()) {
          existing = "NetworkServiceInProcess";
        } else {
          existing += ",NetworkServiceInProcess";
        }
      }
    }

    // --- Apply all flags ---
    for (const auto& [key, value] : g_runtime.chromium_flags) {
      if (value == "false") {
        continue;
      }
      if (value.empty() || value == "true") {
        command_line->AppendSwitch(key);
      } else {
        command_line->AppendSwitchWithValue(key, value);
      }
    }
  }

  void OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) override {
    registrar->AddCustomScheme(
      "appres",
      CEF_SCHEME_OPTION_STANDARD |
        CEF_SCHEME_OPTION_CORS_ENABLED |
        CEF_SCHEME_OPTION_SECURE |
        CEF_SCHEME_OPTION_CSP_BYPASSING |
        CEF_SCHEME_OPTION_FETCH_ENABLED
    );
  }

private:
  IMPLEMENT_REFCOUNTING(BuniteCefApp);
};

class BuniteDevToolsClient : public CefClient, public CefLifeSpanHandler {
public:
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }

  void OnAfterCreated(CefRefPtr<CefBrowser>) override {
    CEF_REQUIRE_UI_THREAD();
    g_runtime.devtools_browser_count.fetch_add(1);
  }

  void OnBeforeClose(CefRefPtr<CefBrowser>) override {
    CEF_REQUIRE_UI_THREAD();
    g_runtime.devtools_browser_count.fetch_sub(1);
    bunite_win::maybeCompleteShutdownOnUiThread();
  }

private:
  IMPLEMENT_REFCOUNTING(BuniteDevToolsClient);
};

class BuniteCefClient
  : public CefClient,
    public CefLifeSpanHandler,
    public CefLoadHandler,
    public CefRequestHandler,
    public CefResourceRequestHandler,
    public CefPermissionHandler {
public:
  explicit BuniteCefClient(ViewHost* view)
    : view_(view) {}

  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefRequestHandler> GetRequestHandler() override { return this; }
  CefRefPtr<CefPermissionHandler> GetPermissionHandler() override { return this; }

  void OnBeforeDevToolsPopup(
    CefRefPtr<CefBrowser>,
    CefWindowInfo&,
    CefRefPtr<CefClient>& client,
    CefBrowserSettings&,
    CefRefPtr<CefDictionaryValue>&,
    bool*
  ) override {
    // Inject our tracked client so F12, Ctrl+Shift+I, and Inspect Element
    // all go through BuniteDevToolsClient for proper shutdown sequencing.
    client = new BuniteDevToolsClient();
  }

  CefRefPtr<CefResourceRequestHandler> GetResourceRequestHandler(
    CefRefPtr<CefBrowser>,
    CefRefPtr<CefFrame>,
    CefRefPtr<CefRequest>,
    bool,
    bool,
    const CefString&,
    bool&
  ) override {
    return this;
  }

  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    view_->browser = browser;
    {
      std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
      g_runtime.browser_to_view_id[browser->GetIdentifier()] = view_->id;
    }

    // View was marked for closing while browser was being created async
    if (view_->closing.load()) {
      browser->GetHost()->CloseBrowser(true);
      return;
    }

    bunite_win::resizeViewToFit(view_);

    // Apply pending state queued before HWND was available
    HWND browser_hwnd = browser->GetHost()->GetWindowHandle();
    if (browser_hwnd) {
      if (view_->has_pending_bounds) {
        view_->has_pending_bounds = false;
        view_->bounds = view_->pending_bounds;
        SetWindowPos(browser_hwnd, nullptr,
          view_->bounds.left, view_->bounds.top,
          view_->bounds.right - view_->bounds.left,
          view_->bounds.bottom - view_->bounds.top,
          SWP_NOZORDER | SWP_NOACTIVATE);
      }
      if (!view_->pending_visible) {
        ShowWindow(browser_hwnd, SW_HIDE);
      }
      if (view_->pending_bring_to_front) {
        view_->pending_bring_to_front = false;
        SetWindowPos(browser_hwnd, HWND_TOP, 0, 0, 0, 0,
          SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
      }
      if (view_->pending_passthrough) {
        EnableWindow(browser_hwnd, FALSE);
      }
    }

    bunite_win::emitWebviewEvent(view_->id, "view-ready");
  }

  bool DoClose(CefRefPtr<CefBrowser>) override {
    CEF_REQUIRE_UI_THREAD();
    return false;
  }

  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    bunite_win::removeBrowserMapping(browser->GetIdentifier());
    view_->browser = nullptr;
    if (view_->closing.load()) {
      bunite_win::finalizeViewHost(view_);
    }
  }

  bool OnBeforeBrowse(
    CefRefPtr<CefBrowser>,
    CefRefPtr<CefFrame> frame,
    CefRefPtr<CefRequest> request,
    bool,
    bool
  ) override {
    CEF_REQUIRE_UI_THREAD();
    const bool is_main_frame = frame && frame->IsMain();
    const std::string url = request ? request->GetURL().ToString() : "";
    const bool should_allow = !is_main_frame || bunite_win::shouldAllowNavigation(view_, url);

    if (is_main_frame) {
      bunite_win::emitWebviewEvent(view_->id, "will-navigate", url);
    }

    return !should_allow;
  }

  bool OnOpenURLFromTab(
    CefRefPtr<CefBrowser>,
    CefRefPtr<CefFrame>,
    const CefString& target_url,
    CefRequestHandler::WindowOpenDisposition target_disposition,
    bool
  ) override {
    CEF_REQUIRE_UI_THREAD();
    if (target_disposition != CEF_WOD_CURRENT_TAB) {
      bunite_win::emitWebviewEvent(
        view_->id,
        "new-window-open",
        "{\"url\":\"" + bunite_win::escapeJsonString(target_url.ToString()) + "\"}"
      );
      return true;
    }
    return false;
  }

  bool OnBeforePopup(
    CefRefPtr<CefBrowser>,
    CefRefPtr<CefFrame>,
    int,
    const CefString& target_url,
    const CefString&,
    CefLifeSpanHandler::WindowOpenDisposition,
    bool,
    const CefPopupFeatures&,
    CefWindowInfo&,
    CefRefPtr<CefClient>&,
    CefBrowserSettings&,
    CefRefPtr<CefDictionaryValue>&,
    bool*
  ) override {
    CEF_REQUIRE_UI_THREAD();
    bunite_win::emitWebviewEvent(
      view_->id,
      "new-window-open",
      "{\"url\":\"" + bunite_win::escapeJsonString(target_url.ToString()) + "\"}"
    );
    return true;
  }

  void OnLoadEnd(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, int) override {
    CEF_REQUIRE_UI_THREAD();
    if (!frame->IsMain()) {
      return;
    }

    const std::string url = frame->GetURL().ToString();
    bunite_win::emitWebviewEvent(view_->id, "did-navigate", url);
    bunite_win::emitWebviewEvent(view_->id, "dom-ready", url);
  }

  bool OnShowPermissionPrompt(
    CefRefPtr<CefBrowser>,
    uint64_t,
    const CefString& requesting_origin,
    uint32_t requested_permissions,
    CefRefPtr<CefPermissionPromptCallback> callback
  ) override {
    CEF_REQUIRE_UI_THREAD();

    uint32_t request_id = 0;
    {
      std::lock_guard<std::mutex> lock(g_runtime.permission_mutex);
      request_id = g_runtime.next_permission_request_id++;
      g_runtime.pending_permissions.emplace(
        request_id,
        PendingPermissionRequest{ PermissionRequestKind::Prompt, requested_permissions, callback, nullptr }
      );
    }

    bunite_win::emitWebviewEvent(
      view_->id,
      "permission-requested",
      "{\"requestId\":" + std::to_string(request_id) +
        ",\"kind\":" + std::to_string(requested_permissions) +
        ",\"url\":\"" + bunite_win::escapeJsonString(requesting_origin.ToString()) + "\"}"
    );
    return true;
  }

  bool OnRequestMediaAccessPermission(
    CefRefPtr<CefBrowser>,
    CefRefPtr<CefFrame>,
    const CefString& requesting_origin,
    uint32_t requested_permissions,
    CefRefPtr<CefMediaAccessCallback> callback
  ) override {
    CEF_REQUIRE_UI_THREAD();

    uint32_t request_id = 0;
    {
      std::lock_guard<std::mutex> lock(g_runtime.permission_mutex);
      request_id = g_runtime.next_permission_request_id++;
      g_runtime.pending_permissions.emplace(
        request_id,
        PendingPermissionRequest{ PermissionRequestKind::MediaAccess, requested_permissions, nullptr, callback }
      );
    }

    bunite_win::emitWebviewEvent(
      view_->id,
      "permission-requested",
      "{\"requestId\":" + std::to_string(request_id) +
        ",\"kind\":" + std::to_string(requested_permissions) +
        ",\"url\":\"" + bunite_win::escapeJsonString(requesting_origin.ToString()) + "\"}"
    );
    return true;
  }

private:
  ViewHost* view_;

  IMPLEMENT_REFCOUNTING(BuniteCefClient);
};


} // namespace

namespace bunite_win {

// ---------------------------------------------------------------------------
// Browser / view / window management
// ---------------------------------------------------------------------------

void removeBrowserMapping(int browser_id) {
  std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
  g_runtime.browser_to_view_id.erase(browser_id);
}

void syncWindowFrame(WindowHost* window) {
  if (!window || !window->hwnd) {
    return;
  }

  RECT rect{};
  GetWindowRect(window->hwnd, &rect);
  window->frame = rect;
  window->minimized = IsIconic(window->hwnd) != 0;
  window->maximized = IsZoomed(window->hwnd) != 0;
  if (!window->minimized) {
    window->restore_maximized_after_minimize = false;
  }
}

void resizeViewToFit(ViewHost* view) {
  if (!view || !view->window || !view->window->hwnd) {
    return;
  }
  if (view->closing.load()) {
    return;
  }

  auto browser = view->browser;  // CefRefPtr copy — atomic refcount
  if (!browser) {
    return;
  }

  HWND browser_hwnd = browser->GetHost()->GetWindowHandle();
  if (!browser_hwnd) {
    return;
  }

  RECT bounds = view->bounds;
  switch (view->anchor_mode) {
    case static_cast<int>(ViewAnchorMode::Fill): {
      GetClientRect(view->window->hwnd, &bounds);
      break;
    }
    case static_cast<int>(ViewAnchorMode::Top): {
      RECT client;
      GetClientRect(view->window->hwnd, &client);
      bounds = { 0, 0, client.right, static_cast<LONG>(view->anchor_inset) };
      break;
    }
    case static_cast<int>(ViewAnchorMode::BelowTop): {
      RECT client;
      GetClientRect(view->window->hwnd, &client);
      LONG inset = static_cast<LONG>(view->anchor_inset);
      LONG h = client.bottom - inset;
      if (h < 0) h = 0;
      bounds = { 0, inset, client.right, inset + h };
      break;
    }
    default: // ViewAnchorMode::None - use stored bounds
      break;
  }
  view->bounds = bounds;

  SetWindowPos(
    browser_hwnd,
    nullptr,
    bounds.left,
    bounds.top,
    bounds.right - bounds.left,
    bounds.bottom - bounds.top,
    SWP_NOZORDER | SWP_NOACTIVATE
  );
}

void finalizeViewHost(ViewHost* view) {
  if (!view) {
    return;
  }

  bunite::WebviewContentStorage::instance().remove(view->id);

  WindowHost* window = nullptr;
  bool window_views_empty = false;
  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    g_runtime.views_by_id.erase(view->id);
    if (view->window) {
      window = view->window;
      auto& views = window->views;
      views.erase(std::remove(views.begin(), views.end(), view), views.end());
      window_views_empty = views.empty();
    }
  }

  delete view;

  // All views finalized — destroy parent HWND on Win32 thread
  if (window && window->closing.load() && window_views_empty) {
    postUiTask([window]() {
      if (window->hwnd) {
        DestroyWindow(window->hwnd);
      }
    });
  }

  maybeCompleteShutdownOnUiThread();
}

void closeViewHost(ViewHost* view) {
  if (!view || view->closing.exchange(true)) {
    return;
  }

  if (view->browser) {
    postCefUiTask([view]() {
      if (!view->browser) {
        return;
      }
      // closeDevToolsForView() bails on closing views — call CloseDevTools directly.
      view->browser->GetHost()->CloseDevTools();
      view->browser->GetHost()->CloseBrowser(true);
    });
    return;
  }

  // Browser not yet created — OnAfterCreated will check closing flag.
  // Safety net: if CreateBrowser failed entirely, clean up on CEF thread.
  postCefUiTask([view]() {
    if (view->browser) {
      view->browser->GetHost()->CloseBrowser(true);
    } else {
      finalizeViewHost(view);
    }
  });
}

void destroyWindowHost(WindowHost* window) {
  if (!window || !window->hwnd) {
    return;
  }
  if (!window->closing.exchange(true)) {
    emitWindowEvent(window->id, "close");
    std::vector<ViewHost*> views_copy;
    {
      std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
      views_copy = window->views;
    }
    if (views_copy.empty()) {
      // No views — destroy HWND immediately
      DestroyWindow(window->hwnd);
    } else {
      for (auto* view : views_copy) {
        closeViewHost(view);
      }
      // DestroyWindow deferred — finalizeViewHost posts it when last view is gone
    }
  }
}

void finalizeWindowHost(WindowHost* window) {
  if (!window) {
    return;
  }

  bool all_closed = false;
  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    for (auto* view : window->views) {
      if (view) {
        view->window = nullptr;
      }
    }
    window->views.clear();
    g_runtime.windows_by_id.erase(window->id);
    all_closed = g_runtime.windows_by_id.empty();
  }

  delete window;

  if (all_closed && !g_runtime.shutting_down.load()) {
    emitWindowEvent(0, "all-windows-closed");
  }
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

WindowHost* getWindowHostById(uint32_t window_id) {
  std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
  auto it = g_runtime.windows_by_id.find(window_id);
  return it != g_runtime.windows_by_id.end() ? it->second : nullptr;
}

ViewHost* getViewHostById(uint32_t view_id) {
  std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
  auto it = g_runtime.views_by_id.find(view_id);
  return it != g_runtime.views_by_id.end() ? it->second : nullptr;
}

DWORD makeWindowStyle(const std::wstring& title_bar_style) {
  DWORD style = WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN;
  if (title_bar_style == L"hidden" || title_bar_style == L"hiddenInset") {
    style &= ~WS_CAPTION;
  }
  return style;
}

// ---------------------------------------------------------------------------
// DevTools
// ---------------------------------------------------------------------------

void openDevToolsForView(ViewHost* view) {
  if (!view || view->closing.load() || !view->browser) {
    return;
  }

  CefWindowInfo window_info;
  window_info.SetAsPopup(nullptr, "Bunite DevTools");

  CefBrowserSettings settings;
  view->browser->GetHost()->ShowDevTools(window_info, new BuniteDevToolsClient(), settings, CefPoint());
}

void closeDevToolsForView(ViewHost* view) {
  if (!view || view->closing.load() || !view->browser) {
    return;
  }

  view->browser->GetHost()->CloseDevTools();
}

void toggleDevToolsForView(ViewHost* view) {
  if (!view || view->closing.load() || !view->browser) {
    return;
  }

  if (view->browser->GetHost()->HasDevTools()) {
    closeDevToolsForView(view);
    return;
  }

  openDevToolsForView(view);
}

// ---------------------------------------------------------------------------
// CEF initialization / shutdown
// ---------------------------------------------------------------------------

bool initializeCefOnUiThread() {
  if (g_runtime.process_helper_path.empty() || g_runtime.cef_dir.empty()) {
    BUNITE_ERROR("Missing process helper or CEF directory.");
    return false;
  }
  if (!registerWindowClasses()) {
    BUNITE_ERROR("Failed to register window classes.");
    return false;
  }

  const std::filesystem::path cef_root(g_runtime.cef_dir);
  const std::filesystem::path dll_dir = std::filesystem::exists(cef_root / "Release" / "libcef.dll")
    ? cef_root / "Release"
    : cef_root;
  const std::filesystem::path resource_dir = std::filesystem::exists(cef_root / "Resources" / "resources.pak")
    ? cef_root / "Resources"
    : cef_root;
  const std::filesystem::path locales_dir = std::filesystem::exists(resource_dir / "locales")
    ? resource_dir / "locales"
    : (std::filesystem::exists(cef_root / "Resources" / "locales")
        ? cef_root / "Resources" / "locales"
        : (std::filesystem::exists(cef_root / "locales") ? cef_root / "locales" : resource_dir / "locales"));

  // Pre-flight: verify critical CEF files exist
  const std::filesystem::path libcef_path = dll_dir / "libcef.dll";
  const std::filesystem::path icudtl_path = resource_dir / "icudtl.dat";
  const std::filesystem::path resources_pak_path = resource_dir / "resources.pak";
  if (!std::filesystem::exists(libcef_path)) {
    BUNITE_ERROR("libcef.dll not found at: %s", libcef_path.string().c_str());
    return false;
  }
  if (!std::filesystem::exists(icudtl_path)) {
    BUNITE_ERROR("icudtl.dat not found at: %s", icudtl_path.string().c_str());
    return false;
  }
  if (!std::filesystem::exists(resources_pak_path)) {
    BUNITE_ERROR("resources.pak not found at: %s", resources_pak_path.string().c_str());
    return false;
  }

  // Pre-flight: check for cache lock from another instance
  const char* user_data_dir = std::getenv("BUNITE_USER_DATA_DIR");
  if (user_data_dir) {
    const std::filesystem::path lock_path = std::filesystem::path(user_data_dir) / "lockfile";
    if (std::filesystem::exists(lock_path)) {
      BUNITE_WARN("Cache directory may be locked by another process: %s", user_data_dir);
    }
  }

  SetDllDirectoryW(dll_dir.native().c_str());

  CefMainArgs main_args(GetModuleHandleW(nullptr));
  CefRefPtr<BuniteCefApp> app = new BuniteCefApp();
  const int execute_result = CefExecuteProcess(main_args, app, nullptr);
  if (execute_result >= 0) {
    BUNITE_ERROR("CefExecuteProcess exited early with code %d.", execute_result);
    return false;
  }

  CefSettings settings{};
  settings.no_sandbox = true;
  settings.multi_threaded_message_loop = true;
  settings.external_message_pump = false;

  CefString(&settings.browser_subprocess_path) = g_runtime.process_helper_path;
  CefString(&settings.resources_dir_path) = resource_dir.wstring();
  CefString(&settings.locales_dir_path) = locales_dir.wstring();
  if (user_data_dir) {
    CefString(&settings.cache_path) = user_data_dir;
  }
  if (const char* remote_debug_port = std::getenv("BUNITE_REMOTE_DEBUGGING_PORT")) {
    const int parsed_port = std::atoi(remote_debug_port);
    if (parsed_port > 0 && parsed_port <= 65535) {
      settings.remote_debugging_port = parsed_port;
    }
  }

  settings.log_severity = LOGSEVERITY_ERROR;
  CefString(&settings.log_file) = "";

  if (!CefInitialize(main_args, settings, app, nullptr)) {
    const int exit_code = CefGetExitCode();
    switch (exit_code) {
      case CEF_RESULT_CODE_NORMAL_EXIT_PROCESS_NOTIFIED:
        BUNITE_ERROR("CefInitialize failed: another instance is using the cache directory (%s).",
                     user_data_dir ? user_data_dir : "<default>");
        break;
      case CEF_RESULT_CODE_PROFILE_IN_USE:
        BUNITE_ERROR("CefInitialize failed: cache profile is in use (%s).",
                     user_data_dir ? user_data_dir : "<default>");
        break;
      case CEF_RESULT_CODE_MISSING_DATA:
        BUNITE_ERROR("CefInitialize failed: critical data files missing (resources_dir=%s).",
                     resource_dir.string().c_str());
        break;
      default:
        BUNITE_ERROR("CefInitialize failed with exit code %d.", exit_code);
        break;
    }
    return false;
  }

  g_runtime.cef_initialized = true;
  registerAppResSchemeHandlers();
  return true;
}

void shutdownCefOnUiThread() {
  if (g_runtime.cef_initialized) {
    CefClearSchemeHandlerFactories();
    CefShutdown();
    g_runtime.cef_initialized = false;
  }
}

void cancelPendingPermissionRequestsOnUiThread() {
  std::vector<PendingPermissionRequest> pending;
  {
    std::lock_guard<std::mutex> lock(g_runtime.permission_mutex);
    for (auto& [_, request] : g_runtime.pending_permissions) {
      pending.push_back(request);
    }
    g_runtime.pending_permissions.clear();
  }

  for (const auto& request : pending) {
    if (request.kind == PermissionRequestKind::Prompt && request.prompt_callback) {
      request.prompt_callback->Continue(CEF_PERMISSION_RESULT_DENY);
      continue;
    }
    if (request.kind == PermissionRequestKind::MediaAccess && request.media_callback) {
      request.media_callback->Cancel();
    }
  }
}

void cancelPendingRouteRequestsOnUiThread() {
  std::vector<RuntimeState::PendingRouteRequest> pending;
  {
    std::lock_guard<std::mutex> lock(g_runtime.route_mutex);
    for (auto& [_, request] : g_runtime.pending_routes) {
      pending.push_back(std::move(request));
    }
    g_runtime.pending_routes.clear();
  }

  for (auto& request : pending) {
    if (request.callback) {
      request.callback->Cancel();
    }
  }
}

void maybeCompleteShutdownOnUiThread() {
  if (!g_runtime.shutting_down.load()) {
    return;
  }

  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    if (!g_runtime.views_by_id.empty()) {
      return;
    }
  }

  if (g_runtime.devtools_browser_count.load() > 0) {
    return;
  }

  if (g_runtime.shutdown_finalize_posted.exchange(true)) {
    return;
  }
  if (g_runtime.message_window) {
    PostMessageW(g_runtime.message_window, kFinalizeShutdownMessage, 0, 0);
  }
}

void closeAllWindowsForShutdown() {
  std::vector<WindowHost*> windows;
  std::vector<ViewHost*> orphan_views;
  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    for (const auto& [_, window] : g_runtime.windows_by_id) {
      windows.push_back(window);
    }
    for (const auto& [_, view] : g_runtime.views_by_id) {
      if (!view->window) {
        orphan_views.push_back(view);
      }
    }
  }

  for (auto* window : windows) {
    destroyWindowHost(window);
  }

  for (auto* view : orphan_views) {
    closeViewHost(view);
  }
}

// ---------------------------------------------------------------------------
// Browser creation
// ---------------------------------------------------------------------------

bool createBrowserForView(ViewHost* view) {
  auto* window = view->window;
  if (!window || !window->hwnd) {
    return false;
  }

  view->client = new BuniteCefClient(view);
  if (!view->html.empty()) {
    bunite::WebviewContentStorage::instance().set(view->id, view->html);
  }

  const std::string initial_url = !view->html.empty()
    ? "appres://app.internal/internal/index.html"
    : (!view->url.empty() ? view->url : "about:blank");

  CefWindowInfo window_info;
  CefRect child_bounds(
    view->bounds.left,
    view->bounds.top,
    view->bounds.right - view->bounds.left,
    view->bounds.bottom - view->bounds.top
  );
  window_info.SetAsChild(window->hwnd, child_bounds);

  CefBrowserSettings browser_settings;

  CefRefPtr<CefDictionaryValue> extra_info;
  if (!view->preload_script.empty() || !view->preload_origins.empty()) {
    extra_info = CefDictionaryValue::Create();
    if (!view->preload_script.empty()) {
      extra_info->SetString("preloadScript", view->preload_script);
    }
    if (!view->preload_origins.empty()) {
      auto list = CefListValue::Create();
      for (size_t i = 0; i < view->preload_origins.size(); ++i) {
        list->SetString(i, view->preload_origins[i]);
      }
      extra_info->SetList("preloadOrigins", list);
    }
  }

  // CreateBrowser (async) — can be called from any browser process thread.
  // Browser instance will be available in OnAfterCreated callback.
  return CefBrowserHost::CreateBrowser(
    window_info,
    view->client,
    initial_url,
    browser_settings,
    extra_info,
    nullptr
  );
}

} // namespace bunite_win
