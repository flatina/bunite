#include "../shared/ffi_exports.h"

#include <windows.h>

#include <algorithm>
#include <atomic>
#include <chrono>
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
#include "include/cef_permission_handler.h"
#include "include/cef_resource_handler.h"
#include "include/cef_resource_request_handler.h"
#include "include/cef_scheme.h"
#include "include/cef_task.h"
#include "include/wrapper/cef_helpers.h"

#include "../shared/cef_response_filter.h"
#include "../shared/webview_storage.h"

namespace {

constexpr wchar_t kMessageWindowClass[] = L"BuniteMessageWindow";
constexpr wchar_t kWindowClass[] = L"BuniteWindowClass";
constexpr UINT kRunQueuedTaskMessage = WM_APP + 1;

struct WindowHost;
struct ViewHost;
class BuniteCefClient;

enum class PermissionRequestKind {
  Prompt,
  MediaAccess
};

struct PendingPermissionRequest {
  PermissionRequestKind kind;
  uint32_t permissions = 0;
  CefRefPtr<CefPermissionPromptCallback> prompt_callback;
  CefRefPtr<CefMediaAccessCallback> media_callback;
};

struct ViewHost {
  uint32_t id = 0;
  WindowHost* window = nullptr;
  RECT bounds{0, 0, 0, 0};
  std::string url;
  std::string html;
  std::string preload_script;
  std::string views_root;
  bool auto_resize = true;
  bool sandbox = false;
  std::atomic<bool> closing = false;
  CefRefPtr<CefBrowser> browser;
  CefRefPtr<BuniteCefClient> client;
};

struct WindowHost {
  uint32_t id = 0;
  HWND hwnd = nullptr;
  std::wstring title;
  std::wstring title_bar_style;
  RECT frame{0, 0, 0, 0};
  bool transparent = false;
  bool hidden = false;
  std::atomic<bool> closing = false;
  std::vector<ViewHost*> views;
};

struct RuntimeState {
  std::mutex lifecycle_mutex;
  std::condition_variable lifecycle_cv;
  bool init_finished = false;
  bool init_success = false;
  bool initialized = false;
  bool shutting_down = false;

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

  BuniteWebviewEventHandler webview_event_handler = nullptr;
  BuniteWindowEventHandler window_event_handler = nullptr;

  bool cef_initialized = false;
  std::string process_helper_path;
  std::string cef_dir;
  std::thread::id cef_owner_thread;
};

RuntimeState g_runtime;

std::wstring utf8ToWide(const std::string& value) {
  if (value.empty()) {
    return {};
  }

  const int required = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);
  if (required <= 0) {
    return {};
  }

  std::wstring converted(required - 1, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, converted.data(), required);
  return converted;
}

std::string escapeJsonString(const std::string& value) {
  std::string escaped;
  escaped.reserve(value.size());

  for (const unsigned char ch : value) {
    switch (ch) {
      case '\\':
        escaped += "\\\\";
        break;
      case '"':
        escaped += "\\\"";
        break;
      case '\n':
        escaped += "\\n";
        break;
      case '\r':
        escaped += "\\r";
        break;
      case '\t':
        escaped += "\\t";
        break;
      default:
        if (ch < 0x20) {
          char buffer[7];
          std::snprintf(buffer, sizeof(buffer), "\\u%04x", ch);
          escaped += buffer;
        } else {
          escaped.push_back(static_cast<char>(ch));
        }
        break;
    }
  }

  return escaped;
}

void emitWindowEvent(uint32_t window_id, const char* event_name, const std::string& payload = {}) {
  BuniteWindowEventHandler handler = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_runtime.lifecycle_mutex);
    handler = g_runtime.window_event_handler;
  }
  if (handler) {
    handler(window_id, _strdup(event_name ? event_name : ""), _strdup(payload.c_str()));
  }
}

void emitWebviewEvent(uint32_t view_id, const char* event_name, const std::string& payload = {}) {
  BuniteWebviewEventHandler handler = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_runtime.lifecycle_mutex);
    handler = g_runtime.webview_event_handler;
  }
  if (handler) {
    handler(view_id, _strdup(event_name ? event_name : ""), _strdup(payload.c_str()));
  }
}

class DeferredCefTask : public CefTask {
public:
  explicit DeferredCefTask(std::function<void()> task)
    : task_(std::move(task)) {}

  void Execute() override {
    task_();
  }

private:
  std::function<void()> task_;

  IMPLEMENT_REFCOUNTING(DeferredCefTask);
};

void postTask(std::function<void()> task) {
  CefPostTask(TID_UI, new DeferredCefTask(std::move(task)));
}

template <typename Result>
Result runOnUiThreadSync(std::function<Result()> task) {
  if (CefCurrentlyOn(TID_UI)) {
    return task();
  }

  auto packaged = std::make_shared<std::packaged_task<Result()>>(std::move(task));
  auto future = packaged->get_future();
  postTask([packaged]() { (*packaged)(); });
  return future.get();
}

template <>
void runOnUiThreadSync<void>(std::function<void()> task) {
  if (CefCurrentlyOn(TID_UI)) {
    task();
    return;
  }

  auto packaged = std::make_shared<std::packaged_task<void()>>(std::move(task));
  auto future = packaged->get_future();
  postTask([packaged]() { (*packaged)(); });
  future.get();
}

std::string normalizeViewsPath(const std::string& url) {
  std::string path = url;
  if (path.rfind("views://", 0) == 0) {
    path = path.substr(8);
  }

  const auto query_pos = path.find_first_of("?#");
  if (query_pos != std::string::npos) {
    path = path.substr(0, query_pos);
  }

  while (!path.empty() && (path.front() == '/' || path.front() == '\\')) {
    path.erase(path.begin());
  }

  return path.empty() ? "index.html" : path;
}

std::string getMimeType(const std::filesystem::path& file_path) {
  const auto extension = file_path.extension().string();
  if (extension == ".html" || extension == ".htm") return "text/html";
  if (extension == ".js" || extension == ".mjs") return "text/javascript";
  if (extension == ".css") return "text/css";
  if (extension == ".json") return "application/json";
  if (extension == ".svg") return "image/svg+xml";
  if (extension == ".png") return "image/png";
  if (extension == ".jpg" || extension == ".jpeg") return "image/jpeg";
  if (extension == ".woff2") return "font/woff2";
  if (extension == ".woff") return "font/woff";
  if (extension == ".ttf") return "font/ttf";
  return "application/octet-stream";
}

std::optional<std::string> loadViewsResource(uint32_t view_id, const std::string& url, std::string& mime_type) {
  std::string views_root;
  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    const auto it = g_runtime.views_by_id.find(view_id);
    if (it != g_runtime.views_by_id.end()) {
      views_root = it->second->views_root;
    }
  }

  const std::string path = normalizeViewsPath(url);
  if (path == "internal/index.html") {
    mime_type = "text/html";
    return bunite::WebviewContentStorage::instance().get(view_id);
  }

  if (views_root.empty()) {
    return std::nullopt;
  }

  if (!std::filesystem::exists(views_root)) {
    return std::nullopt;
  }

  const std::filesystem::path root = std::filesystem::weakly_canonical(std::filesystem::path(views_root));
  const std::filesystem::path candidate = std::filesystem::weakly_canonical(root / std::filesystem::path(path));
  const auto root_string = root.native();
  const auto candidate_string = candidate.native();
  const bool in_root = candidate_string == root_string ||
    (candidate_string.size() > root_string.size() &&
      candidate_string.rfind(root_string, 0) == 0 &&
      (candidate_string[root_string.size()] == L'\\' || candidate_string[root_string.size()] == L'/'));

  if (!in_root || !std::filesystem::exists(candidate) || std::filesystem::is_directory(candidate)) {
    return std::nullopt;
  }

  std::ifstream stream(candidate, std::ios::binary);
  if (!stream) {
    return std::nullopt;
  }

  std::ostringstream contents;
  contents << stream.rdbuf();
  mime_type = getMimeType(candidate);
  return contents.str();
}

void removeBrowserMapping(int browser_id) {
  std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
  g_runtime.browser_to_view_id.erase(browser_id);
}

void resizeViewToFit(ViewHost* view) {
  if (!view || !view->browser || !view->window || !view->window->hwnd) {
    return;
  }

  HWND browser_hwnd = view->browser->GetHost()->GetWindowHandle();
  if (!browser_hwnd) {
    return;
  }

  RECT bounds = view->bounds;
  if (view->auto_resize) {
    GetClientRect(view->window->hwnd, &bounds);
    view->bounds = bounds;
  }

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

  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    g_runtime.views_by_id.erase(view->id);
    if (view->window) {
      auto& views = view->window->views;
      views.erase(std::remove(views.begin(), views.end(), view), views.end());
    }
  }

  delete view;
}

void closeViewHost(ViewHost* view) {
  if (!view || view->closing.exchange(true)) {
    return;
  }

  if (view->browser) {
    view->browser->GetHost()->CloseBrowser(true);
    return;
  }

  finalizeViewHost(view);
}

void finalizeWindowHost(WindowHost* window) {
  if (!window) {
    return;
  }

  for (auto* view : window->views) {
    if (view) {
      view->window = nullptr;
    }
  }
  window->views.clear();

  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    g_runtime.windows_by_id.erase(window->id);
  }

  delete window;
}

class BuniteSchemeHandler : public CefResourceHandler {
public:
  explicit BuniteSchemeHandler(uint32_t view_id)
    : view_id_(view_id) {}

  bool Open(CefRefPtr<CefRequest> request, bool& handle_request, CefRefPtr<CefCallback>) override {
    CEF_REQUIRE_IO_THREAD();
    handle_request = true;

    std::string mime_type;
    const auto content = loadViewsResource(view_id_, request->GetURL().ToString(), mime_type);
    if (!content) {
      status_code_ = 404;
      status_text_ = "Not Found";
      mime_type_ = "text/plain";
      data_ = "bunite could not resolve the requested views:// resource.";
      return true;
    }

    status_code_ = 200;
    status_text_ = "OK";
    mime_type_ = mime_type;
    data_ = *content;
    return true;
  }

  void GetResponseHeaders(CefRefPtr<CefResponse> response, int64_t& response_length, CefString&) override {
    response->SetStatus(status_code_);
    response->SetStatusText(status_text_);
    response->SetMimeType(mime_type_);
    response_length = static_cast<int64_t>(data_.size());
  }

  bool Read(void* data_out, int bytes_to_read, int& bytes_read, CefRefPtr<CefResourceReadCallback>) override {
    CEF_REQUIRE_IO_THREAD();
    bytes_read = 0;
    if (offset_ >= data_.size()) {
      return false;
    }

    const size_t remaining = data_.size() - offset_;
    const size_t count = std::min<size_t>(remaining, static_cast<size_t>(bytes_to_read));
    std::memcpy(data_out, data_.data() + offset_, count);
    offset_ += count;
    bytes_read = static_cast<int>(count);
    return true;
  }

  void Cancel() override {
    CEF_REQUIRE_IO_THREAD();
  }

private:
  uint32_t view_id_;
  std::string data_;
  std::string mime_type_ = "text/plain";
  std::string status_text_ = "OK";
  size_t offset_ = 0;
  int status_code_ = 200;

  IMPLEMENT_REFCOUNTING(BuniteSchemeHandler);
};

class BuniteSchemeHandlerFactory : public CefSchemeHandlerFactory {
public:
  CefRefPtr<CefResourceHandler> Create(
    CefRefPtr<CefBrowser> browser,
    CefRefPtr<CefFrame>,
    const CefString&,
    CefRefPtr<CefRequest>
  ) override {
    uint32_t view_id = 0;
    if (browser) {
      std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
      const auto it = g_runtime.browser_to_view_id.find(browser->GetIdentifier());
      if (it != g_runtime.browser_to_view_id.end()) {
        view_id = it->second;
      }
    }
    return new BuniteSchemeHandler(view_id);
  }

private:
  IMPLEMENT_REFCOUNTING(BuniteSchemeHandlerFactory);
};

class BuniteCefApp : public CefApp, public CefBrowserProcessHandler {
public:
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override {
    return this;
  }

  void OnBeforeCommandLineProcessing(const CefString&, CefRefPtr<CefCommandLine> command_line) override {
    // Bunite cancels popup creation in OnBeforePopup and surfaces it as a Bun event.
    // Disable Chromium's popup blocker so scripted window.open() attempts still reach that hook.
    command_line->AppendSwitch("disable-popup-blocking");
  }

  void OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) override {
    registrar->AddCustomScheme(
      "views",
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

class BuniteCefClient
  : public CefClient,
    public CefLifeSpanHandler,
    public CefLoadHandler,
    public CefRequestHandler,
    public CefResourceRequestHandler,
    public CefPermissionHandler {
public:
  explicit BuniteCefClient(ViewHost* view)
    : view_(view),
      preload_script_(view ? view->preload_script : "") {}

  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefRequestHandler> GetRequestHandler() override { return this; }
  CefRefPtr<CefPermissionHandler> GetPermissionHandler() override { return this; }

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

  CefRefPtr<CefResponseFilter> GetResourceResponseFilter(
    CefRefPtr<CefBrowser>,
    CefRefPtr<CefFrame> frame,
    CefRefPtr<CefRequest> request,
    CefRefPtr<CefResponse> response
  ) override {
    if (!frame->IsMain() || !response) {
      return nullptr;
    }

    const std::string mime_type = response->GetMimeType().ToString();
    const std::string url = request ? request->GetURL().ToString() : "";
    if (
      mime_type.find("html") == std::string::npos ||
      preload_script_.empty() ||
      url.rfind("views://", 0) != 0
    ) {
      return nullptr;
    }

    return new BuniteResponseFilter(preload_script_);
  }

  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    view_->browser = browser;
    {
      std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
      g_runtime.browser_to_view_id[browser->GetIdentifier()] = view_->id;
    }
    resizeViewToFit(view_);
  }

  bool DoClose(CefRefPtr<CefBrowser>) override {
    CEF_REQUIRE_UI_THREAD();
    return false;
  }

  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    removeBrowserMapping(browser->GetIdentifier());
    view_->browser = nullptr;
    if (view_->closing.load()) {
      finalizeViewHost(view_);
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
    if (frame->IsMain()) {
      emitWebviewEvent(view_->id, "will-navigate", request->GetURL().ToString());
    }
    return false;
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
      emitWebviewEvent(
        view_->id,
        "new-window-open",
        "{\"url\":\"" + escapeJsonString(target_url.ToString()) + "\"}"
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
    emitWebviewEvent(
      view_->id,
      "new-window-open",
      "{\"url\":\"" + escapeJsonString(target_url.ToString()) + "\"}"
    );
    return true;
  }

  void OnLoadEnd(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, int) override {
    CEF_REQUIRE_UI_THREAD();
    if (!frame->IsMain()) {
      return;
    }

    const std::string url = frame->GetURL().ToString();
    emitWebviewEvent(view_->id, "did-navigate", url);
    emitWebviewEvent(view_->id, "dom-ready", url);
  }

  bool OnShowPermissionPrompt(
    CefRefPtr<CefBrowser>,
    uint64_t,
    const CefString& requesting_origin,
    uint32_t requested_permissions,
    CefRefPtr<CefPermissionPromptCallback> callback
  ) override;

  bool OnRequestMediaAccessPermission(
    CefRefPtr<CefBrowser>,
    CefRefPtr<CefFrame>,
    const CefString& requesting_origin,
    uint32_t requested_permissions,
    CefRefPtr<CefMediaAccessCallback> callback
  ) override;

private:
  ViewHost* view_;
  std::string preload_script_;

  IMPLEMENT_REFCOUNTING(BuniteCefClient);
};

bool BuniteCefClient::OnShowPermissionPrompt(
  CefRefPtr<CefBrowser>,
  uint64_t,
  const CefString& requesting_origin,
  uint32_t requested_permissions,
  CefRefPtr<CefPermissionPromptCallback> callback
) {
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

  emitWebviewEvent(
    view_->id,
    "permission-requested",
    "{\"requestId\":" + std::to_string(request_id) +
      ",\"kind\":" + std::to_string(requested_permissions) +
      ",\"url\":\"" + escapeJsonString(requesting_origin.ToString()) + "\"}"
  );
  return true;
}

bool BuniteCefClient::OnRequestMediaAccessPermission(
  CefRefPtr<CefBrowser>,
  CefRefPtr<CefFrame>,
  const CefString& requesting_origin,
  uint32_t requested_permissions,
  CefRefPtr<CefMediaAccessCallback> callback
) {
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

  emitWebviewEvent(
    view_->id,
    "permission-requested",
    "{\"requestId\":" + std::to_string(request_id) +
      ",\"kind\":" + std::to_string(requested_permissions) +
      ",\"url\":\"" + escapeJsonString(requesting_origin.ToString()) + "\"}"
  );
  return true;
}

LRESULT CALLBACK messageWindowProc(HWND hwnd, UINT message, WPARAM, LPARAM) {
  return DefWindowProcW(hwnd, message, 0, 0);
}

LRESULT CALLBACK buniteWindowProc(HWND hwnd, UINT message, WPARAM w_param, LPARAM l_param) {
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
        RECT rect{};
        GetWindowRect(hwnd, &rect);
        window->frame = rect;
        emitWindowEvent(
          window->id,
          "move",
          "{\"x\":" + std::to_string(rect.left) + ",\"y\":" + std::to_string(rect.top) + "}"
        );
      }
      break;

    case WM_SIZE:
      if (window) {
        RECT rect{};
        GetWindowRect(hwnd, &rect);
        window->frame = rect;

        for (auto* view : window->views) {
          resizeViewToFit(view);
        }

        emitWindowEvent(
          window->id,
          "resize",
          "{\"x\":" + std::to_string(rect.left) +
            ",\"y\":" + std::to_string(rect.top) +
            ",\"width\":" + std::to_string(rect.right - rect.left) +
            ",\"height\":" + std::to_string(rect.bottom - rect.top) + "}"
        );
      }
      break;

    case WM_CLOSE:
      if (window && !window->closing.exchange(true)) {
        emitWindowEvent(window->id, "close");
        const auto views = window->views;
        for (auto* view : views) {
          closeViewHost(view);
        }
      }
      DestroyWindow(hwnd);
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

bool registerWindowClasses() {
  static std::once_flag once;
  static bool registered = false;

  std::call_once(once, []() {
    WNDCLASSW window_class{};
    window_class.lpfnWndProc = buniteWindowProc;
    window_class.hInstance = GetModuleHandleW(nullptr);
    window_class.lpszClassName = kWindowClass;
    window_class.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    window_class.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);

    registered = RegisterClassW(&window_class) != 0;
  });

  return registered;
}

bool initializeCefOnUiThread() {
  if (g_runtime.process_helper_path.empty() || g_runtime.cef_dir.empty()) {
    std::fprintf(stderr, "[bunite/native] Missing process helper or CEF directory.\n");
    return false;
  }
  if (!registerWindowClasses()) {
    std::fprintf(stderr, "[bunite/native] Failed to register window classes.\n");
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

  SetDllDirectoryW(dll_dir.native().c_str());

  CefMainArgs main_args(GetModuleHandleW(nullptr));
  CefRefPtr<BuniteCefApp> app = new BuniteCefApp();
  const int execute_result = CefExecuteProcess(main_args, app, nullptr);
  if (execute_result >= 0) {
    std::fprintf(stderr, "[bunite/native] CefExecuteProcess exited early with code %d.\n", execute_result);
    return false;
  }

  CefSettings settings{};
  settings.no_sandbox = true;
  settings.multi_threaded_message_loop = true;
  settings.external_message_pump = false;

  CefString(&settings.browser_subprocess_path) = g_runtime.process_helper_path;
  CefString(&settings.resources_dir_path) = resource_dir.wstring();
  CefString(&settings.locales_dir_path) = locales_dir.wstring();
  if (const char* user_data_dir = std::getenv("BUNITE_USER_DATA_DIR")) {
    CefString(&settings.cache_path) = user_data_dir;
  }

  settings.log_severity = LOGSEVERITY_ERROR;
  CefString(&settings.log_file) = "";

  if (!CefInitialize(main_args, settings, app, nullptr)) {
    std::fprintf(stderr, "[bunite/native] CefInitialize returned false.\n");
    return false;
  }

  g_runtime.cef_initialized = true;
  CefRegisterSchemeHandlerFactory("views", "", new BuniteSchemeHandlerFactory());
  return true;
}

void shutdownCefOnUiThread() {
  if (g_runtime.cef_initialized) {
    CefClearSchemeHandlerFactories();
    CefShutdown();
    g_runtime.cef_initialized = false;
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
    if (window && window->hwnd) {
      SendMessageW(window->hwnd, WM_CLOSE, 0, 0);
    }
  }

  for (auto* view : orphan_views) {
    closeViewHost(view);
  }
}

bool waitForAllViewsToClose(int timeout_ms) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  while (std::chrono::steady_clock::now() < deadline) {
    {
      std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
      if (g_runtime.views_by_id.empty()) {
        return true;
      }
    }
    Sleep(10);
  }

  return false;
}

WindowHost* getWindowHost(void* window_ptr) {
  return static_cast<WindowHost*>(window_ptr);
}

ViewHost* getViewHost(void* view_ptr) {
  return static_cast<ViewHost*>(view_ptr);
}

DWORD makeWindowStyle(const std::wstring& title_bar_style) {
  DWORD style = WS_OVERLAPPEDWINDOW;
  if (title_bar_style == L"hidden" || title_bar_style == L"hiddenInset") {
    style &= ~WS_CAPTION;
  }
  return style;
}

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
    ? "views://internal/index.html"
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
  CefRefPtr<CefBrowser> browser = CefBrowserHost::CreateBrowserSync(
    window_info,
    view->client,
    initial_url,
    browser_settings,
    nullptr,
    nullptr
  );

  view->browser = browser;
  return browser != nullptr;
}

} // namespace

extern "C" BUNITE_EXPORT bool bunite_init(
  const char* process_helper_path,
  const char* cef_dir,
  bool hide_console
) {
  std::lock_guard<std::mutex> lock(g_runtime.lifecycle_mutex);
  if (g_runtime.initialized) {
    return true;
  }
  g_runtime.shutting_down = false;
  g_runtime.process_helper_path = process_helper_path ? process_helper_path : "";
  g_runtime.cef_dir = cef_dir ? cef_dir : "";
  g_runtime.cef_owner_thread = std::this_thread::get_id();

  if (hide_console) {
    if (HWND console = GetConsoleWindow()) {
      ShowWindow(console, SW_HIDE);
    }
  }

  g_runtime.init_success = initializeCefOnUiThread();
  g_runtime.init_finished = true;
  g_runtime.initialized = g_runtime.init_success;
  return g_runtime.init_success;
}

extern "C" BUNITE_EXPORT void bunite_run_loop(void) {
  // The native UI thread owns the Win32 + CEF loop as soon as bunite_init succeeds.
}

extern "C" BUNITE_EXPORT void bunite_free_cstring(const char* value) {
  std::free(const_cast<char*>(value));
}

extern "C" BUNITE_EXPORT void bunite_quit(void) {
  bool should_shutdown = false;
  {
    std::lock_guard<std::mutex> lock(g_runtime.lifecycle_mutex);
    if (!g_runtime.initialized) {
      return;
    }
    if (g_runtime.cef_owner_thread != std::this_thread::get_id()) {
      std::fprintf(stderr, "[bunite/native] bunite_quit must run on the same thread as bunite_init.\n");
      return;
    }
    g_runtime.shutting_down = true;
    g_runtime.initialized = false;
    g_runtime.init_finished = false;
    g_runtime.init_success = false;
    should_shutdown = g_runtime.cef_initialized;
  }

  if (!should_shutdown) {
    return;
  }

  runOnUiThreadSync<void>([]() { closeAllWindowsForShutdown(); });
  if (!waitForAllViewsToClose(2000)) {
    std::fprintf(stderr, "[bunite/native] Skipping CefShutdown because browsers are still closing.\n");
    return;
  }
  shutdownCefOnUiThread();
}

extern "C" BUNITE_EXPORT void bunite_set_webview_event_handler(BuniteWebviewEventHandler handler) {
  std::lock_guard<std::mutex> lock(g_runtime.lifecycle_mutex);
  g_runtime.webview_event_handler = handler;
}

extern "C" BUNITE_EXPORT void bunite_set_window_event_handler(BuniteWindowEventHandler handler) {
  std::lock_guard<std::mutex> lock(g_runtime.lifecycle_mutex);
  g_runtime.window_event_handler = handler;
}

extern "C" BUNITE_EXPORT void* bunite_window_create(
  uint32_t window_id,
  double x,
  double y,
  double width,
  double height,
  const char* title,
  const char* title_bar_style,
  bool transparent,
  bool hidden
) {
  return runOnUiThreadSync<void*>([=]() -> void* {
    auto* window = new WindowHost{
      window_id,
      nullptr,
      utf8ToWide(title ? title : ""),
      utf8ToWide(title_bar_style ? title_bar_style : ""),
      RECT{
        static_cast<LONG>(x),
        static_cast<LONG>(y),
        static_cast<LONG>(x + width),
        static_cast<LONG>(y + height)
      },
      transparent,
      hidden
    };

    window->hwnd = CreateWindowExW(
      0,
      kWindowClass,
      window->title.c_str(),
      makeWindowStyle(window->title_bar_style),
      static_cast<int>(x),
      static_cast<int>(y),
      static_cast<int>(std::max(width, 100.0)),
      static_cast<int>(std::max(height, 100.0)),
      nullptr,
      nullptr,
      GetModuleHandleW(nullptr),
      window
    );

    if (!window->hwnd) {
      delete window;
      return nullptr;
    }

    {
      std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
      g_runtime.windows_by_id[window_id] = window;
    }

    if (!hidden) {
      ShowWindow(window->hwnd, SW_SHOW);
      UpdateWindow(window->hwnd);
    }

    return window;
  });
}

extern "C" BUNITE_EXPORT void bunite_window_show(void* window_ptr) {
  runOnUiThreadSync<void>([window = getWindowHost(window_ptr)]() {
    if (!window || !window->hwnd) {
      return;
    }
    window->hidden = false;
    ShowWindow(window->hwnd, SW_SHOW);
    SetForegroundWindow(window->hwnd);
  });
}

extern "C" BUNITE_EXPORT void bunite_window_close(void* window_ptr) {
  runOnUiThreadSync<void>([window = getWindowHost(window_ptr)]() {
    if (!window || !window->hwnd) {
      return;
    }
    SendMessageW(window->hwnd, WM_CLOSE, 0, 0);
  });
}

extern "C" BUNITE_EXPORT void bunite_window_set_title(void* window_ptr, const char* title) {
  runOnUiThreadSync<void>([window = getWindowHost(window_ptr), value = std::string(title ? title : "")]() {
    if (!window || !window->hwnd) {
      return;
    }
    window->title = utf8ToWide(value);
    SetWindowTextW(window->hwnd, window->title.c_str());
  });
}

extern "C" BUNITE_EXPORT void bunite_window_set_frame(
  void* window_ptr,
  double x,
  double y,
  double width,
  double height
) {
  runOnUiThreadSync<void>([window = getWindowHost(window_ptr), x, y, width, height]() {
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

extern "C" BUNITE_EXPORT void* bunite_view_create(
  uint32_t view_id,
  void* window_ptr,
  const char* url,
  const char* html,
  const char* preload,
  const char* views_root,
  double x,
  double y,
  double width,
  double height,
  bool auto_resize,
  bool sandbox
) {
  return runOnUiThreadSync<void*>([=]() -> void* {
    auto* window = getWindowHost(window_ptr);
    if (!window || !window->hwnd) {
      return nullptr;
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
      views_root ? views_root : "",
      auto_resize,
      sandbox
    };

    {
      std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
      g_runtime.views_by_id[view_id] = view;
      window->views.push_back(view);
    }

    if (!createBrowserForView(view)) {
      {
        std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
        g_runtime.views_by_id.erase(view_id);
        window->views.erase(std::remove(window->views.begin(), window->views.end(), view), window->views.end());
      }
      delete view;
      return nullptr;
    }

    return view;
  });
}

extern "C" BUNITE_EXPORT void bunite_view_load_url(void* view_ptr, const char* url) {
  runOnUiThreadSync<void>([view = getViewHost(view_ptr), next_url = std::string(url ? url : "")]() {
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

extern "C" BUNITE_EXPORT void bunite_view_load_html(void* view_ptr, const char* html) {
  runOnUiThreadSync<void>([view = getViewHost(view_ptr), content = std::string(html ? html : "")]() {
    if (!view) {
      return;
    }

    view->html = content;
    bunite::WebviewContentStorage::instance().set(view->id, content);
    if (view->browser && view->browser->GetMainFrame()) {
      view->browser->GetMainFrame()->LoadURL("views://internal/index.html");
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_remove(void* view_ptr) {
  runOnUiThreadSync<void>([view = getViewHost(view_ptr)]() { closeViewHost(view); });
}

extern "C" BUNITE_EXPORT void bunite_complete_permission_request(uint32_t request_id, uint32_t state) {
  runOnUiThreadSync<void>([=]() {
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
