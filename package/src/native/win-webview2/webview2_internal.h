#pragma once

#include "../shared/ffi_exports.h"
#include "../shared/log.h"
#include "../shared/permissions.h"

#include <windows.h>
#include <wrl.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <unordered_map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include "WebView2.h"
#include "WebView2EnvironmentOptions.h"

namespace bunite_webview2 {

constexpr wchar_t kWindowClass[] = L"BuniteWebView2WindowClass";
constexpr wchar_t kViewContainerClass[] = L"BuniteWebView2ViewContainer";
constexpr UINT kRunQueuedTaskMessage = WM_APP + 1;

using Microsoft::WRL::ComPtr;

struct WindowHost;
struct ViewHost;

// Resolved synchronously by user-facing API; the COM completion handlers
// receive a weak_ptr<HostLifetime> guarding `state` so they can be torn down
// before WebView2 fires their last callback.
struct HostLifetime {
  std::atomic<bool> alive{true};
};

struct PendingRouteRequest {
  uint32_t view_id = 0;
  std::wstring uri;
  std::string path;             // normalized path component
  ComPtr<ICoreWebView2WebResourceRequestedEventArgs> args;
  ComPtr<ICoreWebView2Deferral> deferral;
};

struct PendingPermissionRequest {
  uint32_t view_id = 0;
  uint32_t bunite_kind = 0;       // BUNITE_PERMISSION_*
  ComPtr<ICoreWebView2PermissionRequestedEventArgs> args;
  ComPtr<ICoreWebView2Deferral> deferral;
};

struct ViewHost {
  uint32_t id = 0;
  WindowHost* window = nullptr;

  // Pending state — applied either on bootstrap or via setters before the
  // controller is ready.
  std::string url;
  std::string html;
  std::string preload_script;
  std::string appres_root;
  std::vector<std::string> navigation_rules;
  std::vector<std::string> preload_origins;
  bool sandbox = false;
  bool auto_resize = true;
  RECT bounds{0, 0, 0, 0};
  bool pending_visible = true;
  bool pending_passthrough = false;

  HWND container_hwnd = nullptr;  // our own child HWND that hosts the controller
  ComPtr<ICoreWebView2Controller> controller;
  ComPtr<ICoreWebView2> webview;
  ComPtr<ICoreWebView2Controller2> controller2;
  ComPtr<ICoreWebView2_2> webview2;
  std::wstring add_script_id;     // returned by AddScriptToExecuteOnDocumentCreated

  std::atomic<bool> ready{false};
  std::atomic<bool> closing{false};

  // Download policy: 0=auto, 1=ask, 2=block. Default block (current behavior).
  std::atomic<int32_t> download_policy{2};
  std::string download_dir;  // optional; falls back to backend default temp dir.

  // Pending page-initiated dialogs (alert/confirm/prompt/beforeunload).
  // ScriptDialogOpening hands us a `Deferral` we Complete() on host response.
  struct PendingDialog {
    ComPtr<ICoreWebView2ScriptDialogOpeningEventArgs> args;
    ComPtr<ICoreWebView2Deferral> deferral;
  };
  std::unordered_map<uint32_t, PendingDialog> pending_dialogs;
  uint32_t next_dialog_request_id = 1;

  // OOPIF input dispatch — populated by Target.attachedToTarget events after
  // lazy Target.setAutoAttach. frameId → sessionId for flatten:true routing.
  std::atomic<bool> oopif_autoattach_armed{false};
  std::mutex oopif_sessions_mutex;
  std::unordered_map<std::string, std::string> oopif_sessions;
  EventRegistrationToken target_attached_token{};
  EventRegistrationToken target_detached_token{};
  bool oopif_event_tokens_registered = false;
};

struct WindowHost {
  uint32_t id = 0;
  HWND hwnd = nullptr;
  std::wstring title;
  std::wstring title_bar_style;
  bool transparent = false;
  bool hidden = false;
  bool minimized = false;
  bool maximized = false;
  std::atomic<bool> close_pending{false};
  std::atomic<bool> closing{false};
  std::vector<ViewHost*> views;
  // Capture-based move-drag (no WM_NCLBUTTONDOWN modal loop — see
  // bunite_window_begin_move_drag + windowProc).
  bool drag_active = false;
  POINT drag_anchor_cursor{};   // screen cursor at drag start
  POINT drag_anchor_origin{};   // window top-left at drag start
};

struct RuntimeState {
  std::atomic<bool> initialized{false};
  std::atomic<bool> shutting_down{false};
  HWND message_window = nullptr;
  HWND popup_parent = nullptr;  // hidden top-level parking parent for popup-minted controllers.

  std::mutex task_mutex;
  std::deque<std::function<void()>> queued_tasks;

  std::mutex object_mutex;
  std::map<uint32_t, WindowHost*> windows_by_id;
  std::map<uint32_t, ViewHost*> views_by_id;

  std::mutex route_mutex;
  std::map<uint32_t, PendingRouteRequest> pending_routes;
  uint32_t next_route_request_id = 1;
  std::vector<std::string> registered_routes;  // paths

  std::mutex permission_mutex;
  std::map<uint32_t, PendingPermissionRequest> pending_permissions;
  uint32_t next_permission_request_id = 1;

  BuniteWebviewEventHandler webview_event_handler = nullptr;
  BuniteWindowEventHandler window_event_handler = nullptr;

  std::shared_ptr<HostLifetime> lifetime;
  ComPtr<ICoreWebView2Environment> env;
  bool env_pending = false;
  bool env_ready = false;
  std::vector<std::function<void()>> env_waiters;

  // engine_config_json values
  std::wstring user_data_folder;
  std::wstring additional_browser_arguments;
  std::wstring language;
  bool popup_blocking = false;
};

extern RuntimeState g_runtime;

// --- runtime.cpp -----------------------------------------------------------

bool initRuntime(const char* engine_dir, bool hide_console,
                 bool popup_blocking, const char* engine_config_json);
void shutdownRuntime();
void pumpOnce();
void postUiTask(std::function<void()> task);
void executeQueuedUiTasks();
HINSTANCE getCurrentModuleHandle();
bool registerWindowClasses();

bool createWindow(uint32_t window_id, double x, double y, double w, double h,
                  const char* title, const char* title_bar_style,
                  bool transparent, bool hidden, bool minimized, bool maximized);
void destroyWindow(uint32_t window_id);
WindowHost* getWindow(uint32_t id);

bool createView(uint32_t view_id, uint32_t window_id,
                const char* url, const char* html,
                const char* preload, const char* appres_root,
                const char* navigation_rules_json,
                double x, double y, double w, double h,
                bool auto_resize, bool sandbox,
                const char* preload_origins_json);
ViewHost* getView(uint32_t id);
void destroyView(uint32_t id);

void emitWindowEvent(uint32_t window_id, const char* name, const std::string& payload = {});
void emitWebviewEvent(uint32_t view_id, const char* name, const std::string& payload = {});

// --- appres.cpp ------------------------------------------------------------

// Configures the env (created in runtime.cpp) with appres:// scheme + global
// WebResourceRequested handler. Called once from `ensureEnvironment()`.
void configureSchemes(ICoreWebView2EnvironmentOptions* opts);
void attachAppResFilter(ViewHost* view);
void registerAppResRoute(const char* path);
void unregisterAppResRoute(const char* path);
void completeRouteRequest(uint32_t request_id, const char* html);
void cancelAllRouteRequests();

// --- utils.cpp -------------------------------------------------------------

std::wstring utf8ToWide(const std::string& s);
std::string wideToUtf8(const std::wstring& s);
std::string wideToUtf8(LPCWSTR s);
std::string escapeJsonString(const std::string& s);

bool globMatchCaseInsensitive(const std::string& pattern, const std::string& value);
std::vector<std::string> parseNavigationRulesJson(const std::string& json);
std::vector<std::string> parsePreloadOriginsJson(const std::string& json);

// engine_config_json shape:  { "userDataFolder": "...", "additionalBrowserArguments": "...", "language": "..." }
void parseEngineConfig(const std::string& json, std::wstring& user_data,
                       std::wstring& browser_args, std::wstring& language);

std::string normalizeAppResPath(const std::string& url);
std::string getMimeType(const std::filesystem::path& p);
std::string defaultUserDataFolder();          // %LOCALAPPDATA%\Bunite\WebView2
std::wstring exeDir();

uint32_t permissionKindToBuniteBit(COREWEBVIEW2_PERMISSION_KIND kind);
COREWEBVIEW2_PERMISSION_STATE buniteStateToWebView2(uint32_t state);

bool shouldAlwaysAllowNavigationUrl(const std::string& url);
bool shouldAllowNavigation(const ViewHost* view, const std::string& url);

}  // namespace bunite_webview2
