// macOS adapter — shared internal declarations.
//
// ARC: Obj-C objects in C++ aggregates need explicit __strong/__weak (else UB).
// Threading: NSWindow / WKWebView APIs are main-thread-only — cross-thread via runOnUiThreadSync.

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

// Stable host for passthrough + mask (WKWebView's internal subviews are fragile).
// Layer-backed (CAShapeLayer mask), isFlipped (coords match BuniteFlippedView).
// `maskHoles` gates hitTest alongside the visual mask — clicks pass through (matches win SetWindowRgn).
@interface BunitePassthroughContainer : NSView
@property (nonatomic, assign) BOOL passthrough;
@property (nonatomic, copy) NSArray<NSValue*>* maskHoles;  // NSValue.rectValue
@end

namespace bunite_mac {

// --- Per-object state ---

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
  // HTML stashed by load_html; appres handler serves at internal/index.html.
  std::string stored_html;
  std::vector<std::string> navigation_rules;

  // Page-initiated dialogs awaiting host response (alert/confirm/prompt).
  // WKUIDelegate completion handlers are held in `__strong` blocks until
  // respondToDialog invokes them; the page execution is paused meanwhile.
  std::unordered_map<uint32_t, void(^)(bool /*accept*/, const std::string& /*text*/)> pending_dialogs;
  uint32_t next_dialog_request_id = 1;
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

  // Pending permission decisions (request_id → entry). Main-thread only, no mutex.
  __strong NSMutableDictionary<NSNumber*, BunitePendingPermission*>* pending_permissions = nil;
  uint32_t next_permission_request_id = 1;

  // In-flight dynamic-route tasks (request_id → entry). view_id lets removeView clean up without WebKit stop. Main-thread only.
  __strong NSMutableDictionary<NSNumber*, BunitePendingRoute*>* pending_route_tasks = nil;
  uint32_t next_route_request_id = 1;

  BuniteWebviewEventHandler webview_event_handler = nullptr;
  BuniteWindowEventHandler window_event_handler = nullptr;
};

extern RuntimeState g_runtime;

// --- Thread helpers (main-thread fast path; cross-thread = dispatch_sync) ---

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

std::string escapeJsonString(const std::string& value);

// Cocoa screen is bottom-left, Win semantics (and FFI) are top-left.
NSRect topLeftToBottomLeft(double x, double y, double width, double height);
void bottomLeftToTopLeft(NSRect frame, double* out_x, double* out_y, double* out_w, double* out_h);

// Payload must be valid UTF-8 JSON.
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

// Glob patterns, last-match-wins, default-allow.
bool globMatchCaseInsensitive(const std::string& pattern, const std::string& value);
std::vector<std::string> parseNavigationRulesJson(NSString* json);
bool shouldAlwaysAllowNavigationUrl(const std::string& url);
bool shouldAllowNavigation(const ViewState* view, const std::string& url);

// Defined in bunite_mac_appres.mm.
id<WKURLSchemeHandler> sharedAppresSchemeHandler();

} // namespace bunite_mac
