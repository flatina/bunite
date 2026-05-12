// bunite-native macOS adapter — shared internal declarations.
//
// ARC + C++ struct interop rule: any Obj-C object stored in a C++ aggregate
// must carry an explicit ownership qualifier (__strong / __weak), otherwise
// ARC behaviour is undefined for that field. All globals/structures in this
// header follow that rule consistently.
//
// Threading: every NSWindow / WKWebView API must run on the main thread.
// FFI entry points marshal cross-thread calls through runOnUiThreadSync.

#pragma once

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "callbacks.h"
#include "ffi_exports.h"
#include "log.h"
#include "permissions.h"

@interface BunitePendingPermission : NSObject
@property (nonatomic, assign) uint32_t viewId;
@property (nonatomic, copy) void (^handler)(WKPermissionDecision);
@end

@interface BunitePendingRoute : NSObject
@property (nonatomic, assign) uint32_t viewId;
@property (nonatomic, strong) id<WKURLSchemeTask> task;
@end

// Wraps every WKWebView so input passthrough + region mask have a stable
// host (WKWebView's internal subviews make those primitives fragile when
// applied directly). Layer-backed for CAShapeLayer mask, isFlipped so the
// container's local coords match window.contentView (BuniteFlippedView).
// `maskHoles` (container-local points) gate hitTest in addition to the visual
// CALayer mask so clicks in masked regions pass through (mirroring win's
// SetWindowRgn which couples visual + hit-test).
@interface BunitePassthroughContainer : NSView
@property (nonatomic, assign) BOOL passthrough;
@property (nonatomic, copy) NSArray<NSValue*>* maskHoles;  // NSValue.rectValue
@end

namespace bunite_mac {

// ---------------------------------------------------------------------------
// Per-object state. Populated by bunite_window_create / bunite_view_create
// once those are implemented; empty during the initial skeleton.
// ---------------------------------------------------------------------------

struct WindowState {
  __strong NSWindow* window = nil;
  __strong NSObject<NSWindowDelegate>* delegate = nil;
  std::atomic<bool> close_pending{false};
};

struct ViewState {
  __strong BunitePassthroughContainer* container = nil;  // window.contentView 자식
  __strong WKWebView* webview = nil;                     // container 자식 (autoresize 채움)
  __strong NSObject<WKNavigationDelegate>* nav_delegate = nil;
  __strong NSObject<WKUIDelegate>* ui_delegate = nil;
  uint32_t window_id = 0;
  std::string appres_root;
  std::string preload_script;
  // Stored HTML for `bunite_view_load_html` — appres scheme handler serves
  // it back when the page requests appres://app.internal/internal/index.html.
  std::string stored_html;
  std::vector<std::string> navigation_rules;
};

// ---------------------------------------------------------------------------
// Runtime singleton.
// ---------------------------------------------------------------------------

struct RuntimeState {
  std::mutex object_mutex;
  std::unordered_map<uint32_t, WindowState> windows;
  std::unordered_map<uint32_t, ViewState> views;

  bool initialized = false;
  bool popup_blocking = false;
  std::atomic<bool> shutting_down{false};

  // Pending permission decisions awaiting a JS reply (request_id → entry).
  // Main-thread only — WKUIDelegate writes, bunite_complete_permission_request
  // and removeView read/erase, both serialized on the main queue. No mutex.
  __strong NSMutableDictionary<NSNumber*, BunitePendingPermission*>* pending_permissions = nil;
  uint32_t next_permission_request_id = 1;

  // In-flight WKURLSchemeTask for dynamic appres routes, keyed by request_id.
  // BunitePendingRoute carries view_id so removeView can deny + clean entries
  // tied to a destroyed webview without depending on WebKit calling stop.
  // Main-thread only — start/stop/complete/removeView funnel through main.
  __strong NSMutableDictionary<NSNumber*, BunitePendingRoute*>* pending_route_tasks = nil;
  uint32_t next_route_request_id = 1;

  BuniteWebviewEventHandler webview_event_handler = nullptr;
  BuniteWindowEventHandler window_event_handler = nullptr;
};

extern RuntimeState g_runtime;

// ---------------------------------------------------------------------------
// Thread helpers — main-thread fast path; cross-thread calls hop via
// dispatch_sync on the main queue.
// ---------------------------------------------------------------------------

bool isOnMainThread();

template <typename Block>
auto runOnUiThreadSync(Block block) -> decltype(block()) {
  using R = decltype(block());
  if (isOnMainThread()) return block();
  if constexpr (std::is_void_v<R>) {
    dispatch_sync(dispatch_get_main_queue(), ^{ block(); });
  } else {
    __block R result{};
    dispatch_sync(dispatch_get_main_queue(), ^{ result = block(); });
    return result;
  }
}

// ---------------------------------------------------------------------------
// Utilities (defined in bunite_mac_utils.mm).
// ---------------------------------------------------------------------------

NSString* utf8ToNSString(const char* value);

// Escape a UTF-8 string for embedding inside a JSON string literal — handles
// `"`, `\`, and control chars (\b \f \n \r \t + generic \u00XX).
std::string escapeJsonString(const std::string& value);

// Cocoa screen is bottom-left, Win semantics (and FFI) are top-left.
NSRect topLeftToBottomLeft(double x, double y, double width, double height);
void bottomLeftToTopLeft(NSRect frame, double* out_x, double* out_y, double* out_w, double* out_h);

// Emit window/view events to the registered JS callbacks (no-op when no
// handler is registered yet). Payload must be valid UTF-8 JSON.
void emitWindowEvent(uint32_t window_id, const char* event_name, const std::string& payload = {});
void emitWebviewEvent(uint32_t view_id, const char* event_name, const std::string& payload = {});

// Defined in bunite_mac_window.mm.
WindowState* findWindow(uint32_t window_id);  // returns nullptr if missing
bool createWindow(uint32_t window_id, double x, double y, double width, double height,
                  NSString* title, NSString* title_bar_style,
                  bool transparent, bool hidden, bool minimized, bool maximized);
void destroyWindow(uint32_t window_id);

// Defined in bunite_mac_view.mm.
ViewState* findView(uint32_t view_id);
uint32_t viewIdForWebView(WKWebView* wv);  // returns 0 if not tracked
bool createView(uint32_t view_id, uint32_t window_id,
                NSString* url, NSString* html, NSString* preload, NSString* appres_root,
                NSString* navigation_rules_json, NSString* preload_origins_json,
                double x, double y, double width, double height, bool auto_resize);
void removeView(uint32_t view_id);

// Navigation rules. Mirror of `package/src/native/win/native_host_utils.cpp`
// (pattern syntax + last-match-wins, default-allow). Defined in bunite_mac_utils.mm.
bool globMatchCaseInsensitive(const std::string& pattern, const std::string& value);
std::vector<std::string> parseNavigationRulesJson(NSString* json);
bool shouldAlwaysAllowNavigationUrl(const std::string& url);
bool shouldAllowNavigation(const ViewState* view, const std::string& url);

// Defined in bunite_mac_appres.mm.
id<WKURLSchemeHandler> sharedAppresSchemeHandler();

} // namespace bunite_mac
