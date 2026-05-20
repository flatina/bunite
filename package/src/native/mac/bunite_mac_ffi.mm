// FFI entry points for the macOS adapter.

#import "bunite_mac_internal.h"

#import <QuartzCore/QuartzCore.h>

#include "webview_storage.h"

#include <CoreFoundation/CoreFoundation.h>

#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

using bunite_mac::g_runtime;
using bunite_mac::isOnMainThread;
using bunite_mac::runOnUiThreadSync;

namespace {

constexpr int32_t kBuniteAbiVersion = 7;

// warn-once — avoid log spam from tight JS call loops.
#define BUNITE_MAC_TODO(name)                                       \
  do {                                                              \
    static std::once_flag once;                                     \
    std::call_once(once, []() {                                     \
      BUNITE_WARN("%s not implemented on macOS.", (name));          \
    });                                                             \
  } while (0)

} // namespace

extern "C" BUNITE_EXPORT int32_t bunite_abi_version(void) {
  return kBuniteAbiVersion;
}

extern "C" BUNITE_EXPORT const char* bunite_engine_name(void) {
  return "wkwebview";
}

extern "C" BUNITE_EXPORT const char* bunite_engine_version(void) {
  // WebKit loads lazily on first WKWebView — re-check until cached value is non-OS fallback.
  static std::string cached;
  if (!cached.empty() && cached.compare(0, 9, "wkwebview") == 0) return cached.c_str();
  NSBundle* webkit = [NSBundle bundleWithIdentifier:@"com.apple.WebKit"];
  NSString* version = [webkit objectForInfoDictionaryKey:@"CFBundleVersion"];
  if (version.length > 0) {
    cached = std::string("wkwebview ") + [version UTF8String];
  } else if (cached.empty()) {
    NSString* os = [NSProcessInfo processInfo].operatingSystemVersionString;
    cached = std::string("macOS ") + (os.length > 0 ? [os UTF8String] : "unknown");
  }
  return cached.c_str();
}

extern "C" BUNITE_EXPORT void bunite_set_log_level(int32_t level) {
  buniteSetLogLevel(static_cast<BuniteLogLevel>(level));
}

extern "C" BUNITE_EXPORT bool bunite_init(
  const char* cef_dir,         // ignored — WKWebView is a system framework
  bool hide_console,              // ignored — no console concept on macOS
  bool popup_blocking,
  const char* engine_config_json  // reserved
) {
  (void)cef_dir;
  (void)hide_console;
  (void)engine_config_json;

  if (![NSThread isMainThread]) {
    BUNITE_ERROR("bunite_init must be called from the main thread on macOS.");
    return false;
  }

  if (g_runtime.initialized) return true;

  [NSApplication sharedApplication];
  [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
  // Without finishLaunching, WKWebView defers all navigation since we don't call [NSApp run].
  [NSApp finishLaunching];

  g_runtime.popup_blocking = popup_blocking;
  g_runtime.initialized = true;
  return true;
}

extern "C" BUNITE_EXPORT void bunite_run_loop(void) {
  // No-op — JS drives bunite_pump_once via setImmediate. Kept for ABI symmetry.
}

extern "C" BUNITE_EXPORT void bunite_pump_once(void) {
  if (!isOnMainThread()) {
    BUNITE_WARN("bunite_pump_once called off the main thread; ignoring.");
    return;
  }
  // Per-iter timeout lets WKWebView IPC deliver (0 polls too tight); wall cap keeps libuv lively.
  static constexpr CFAbsoluteTime kCap = 0.005;  // 5ms
  CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + kCap;
  do {
    CFRunLoopRunResult r = CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.0005, true);
    NSEvent* e = [NSApp nextEventMatchingMask:NSEventMaskAny
                                    untilDate:[NSDate distantPast]
                                       inMode:NSDefaultRunLoopMode
                                      dequeue:YES];
    if (e) [NSApp sendEvent:e];
    if (r != kCFRunLoopRunHandledSource && !e) break;  // empty
  } while (CFAbsoluteTimeGetCurrent() < deadline);
}

extern "C" BUNITE_EXPORT void bunite_quit(void) {
  if (g_runtime.shutting_down.exchange(true)) return;

  runOnUiThreadSync([]() {
    // WindowState is non-copyable (atomic field) — snapshot the NSWindow* refs only.
    std::vector<NSWindow*> windows;
    {
      std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
      windows.reserve(g_runtime.windows.size());
      for (auto& [_, st] : g_runtime.windows) {
        if (st.window) windows.push_back(st.window);
      }
    }
    for (NSWindow* w : windows) {
      [w close];
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_free_cstring(const char* value) {
  std::free(const_cast<char*>(value));
}

extern "C" BUNITE_EXPORT void bunite_set_webview_event_handler(BuniteWebviewEventHandler handler) {
  g_runtime.webview_event_handler = handler;
}

extern "C" BUNITE_EXPORT void bunite_set_window_event_handler(BuniteWindowEventHandler handler) {
  g_runtime.window_event_handler = handler;
}

// ---------------------------------------------------------------------------
// Window FFI — real impls (delegate body lives in bunite_mac_window.mm).
// ---------------------------------------------------------------------------

extern "C" BUNITE_EXPORT bool bunite_window_create(
  uint32_t window_id,
  double x, double y, double width, double height,
  const char* title, const char* title_bar_style,
  bool transparent, bool hidden, bool minimized, bool maximized
) {
  NSString* t = bunite_mac::utf8ToNSString(title);
  NSString* tbs = bunite_mac::utf8ToNSString(title_bar_style);
  return runOnUiThreadSync([=]() -> bool {
    return bunite_mac::createWindow(window_id, x, y, width, height,
                                    t, tbs, transparent, hidden, minimized, maximized);
  });
}

extern "C" BUNITE_EXPORT void bunite_window_destroy(uint32_t window_id) {
  runOnUiThreadSync([=]() { bunite_mac::destroyWindow(window_id); });
}

extern "C" BUNITE_EXPORT void bunite_window_reset_close_pending(uint32_t window_id) {
  runOnUiThreadSync([=]() {
    if (auto* s = bunite_mac::findWindow(window_id)) s->close_pending.store(false);
  });
}

extern "C" BUNITE_EXPORT void bunite_window_show(uint32_t window_id) {
  runOnUiThreadSync([=]() {
    auto* s = bunite_mac::findWindow(window_id);
    if (!s) return;
    [s->window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
  });
}

extern "C" BUNITE_EXPORT void bunite_window_close(uint32_t window_id) {
  runOnUiThreadSync([=]() {
    auto* s = bunite_mac::findWindow(window_id);
    if (s) [s->window performClose:nil];
  });
}

extern "C" BUNITE_EXPORT void bunite_window_set_title(uint32_t window_id, const char* title) {
  NSString* t = bunite_mac::utf8ToNSString(title);
  runOnUiThreadSync([=]() {
    if (auto* s = bunite_mac::findWindow(window_id)) s->window.title = t;
  });
}

extern "C" BUNITE_EXPORT void bunite_window_minimize(uint32_t window_id) {
  runOnUiThreadSync([=]() {
    auto* s = bunite_mac::findWindow(window_id);
    if (s && !s->window.miniaturized) [s->window miniaturize:nil];
  });
}

extern "C" BUNITE_EXPORT void bunite_window_unminimize(uint32_t window_id) {
  runOnUiThreadSync([=]() {
    auto* s = bunite_mac::findWindow(window_id);
    if (s && s->window.miniaturized) [s->window deminiaturize:nil];
  });
}

extern "C" BUNITE_EXPORT bool bunite_window_is_minimized(uint32_t window_id) {
  return runOnUiThreadSync([=]() -> bool {
    auto* s = bunite_mac::findWindow(window_id);
    return s ? (bool)s->window.miniaturized : false;
  });
}

extern "C" BUNITE_EXPORT void bunite_window_maximize(uint32_t window_id) {
  runOnUiThreadSync([=]() {
    auto* s = bunite_mac::findWindow(window_id);
    if (s && !s->window.zoomed) [s->window zoom:nil];  // idempotent — zoom toggles
  });
}

extern "C" BUNITE_EXPORT void bunite_window_unmaximize(uint32_t window_id) {
  runOnUiThreadSync([=]() {
    auto* s = bunite_mac::findWindow(window_id);
    if (s && s->window.zoomed) [s->window zoom:nil];
  });
}

extern "C" BUNITE_EXPORT bool bunite_window_is_maximized(uint32_t window_id) {
  return runOnUiThreadSync([=]() -> bool {
    auto* s = bunite_mac::findWindow(window_id);
    return s ? (bool)s->window.zoomed : false;
  });
}

extern "C" BUNITE_EXPORT void bunite_window_set_frame(
  uint32_t window_id, double x, double y, double width, double height
) {
  runOnUiThreadSync([=]() {
    auto* s = bunite_mac::findWindow(window_id);
    if (s) [s->window setFrame:bunite_mac::topLeftToBottomLeft(x, y, width, height) display:YES];
  });
}

// ---------------------------------------------------------------------------
// View FFI.
// ---------------------------------------------------------------------------

extern "C" BUNITE_EXPORT bool bunite_view_create(
  uint32_t view_id, uint32_t window_id,
  const char* url, const char* html, const char* preload,
  const char* appres_root, const char* navigation_rules_json,
  double x, double y, double width, double height,
  bool auto_resize, bool sandbox, const char* preload_origins_json
) {
  (void)sandbox;
  NSString* u = bunite_mac::utf8ToNSString(url);
  NSString* h = bunite_mac::utf8ToNSString(html);
  NSString* p = bunite_mac::utf8ToNSString(preload);
  NSString* ar = bunite_mac::utf8ToNSString(appres_root);
  NSString* nav = bunite_mac::utf8ToNSString(navigation_rules_json);
  NSString* origins = bunite_mac::utf8ToNSString(preload_origins_json);
  return runOnUiThreadSync([=]() -> bool {
    return bunite_mac::createView(view_id, window_id, u, h, p, ar, nav, origins, x, y, width, height, auto_resize);
  });
}

extern "C" BUNITE_EXPORT void bunite_view_execute_javascript(uint32_t view_id, const char* script) {
  NSString* s = bunite_mac::utf8ToNSString(script);
  runOnUiThreadSync([=]() {
    if (auto* v = bunite_mac::findView(view_id)) [v->webview evaluateJavaScript:s completionHandler:nil];
  });
}

extern "C" BUNITE_EXPORT void bunite_view_evaluate(uint32_t view_id, uint32_t request_id, const char* script) {
  // Wrapper matches WebView2/CEF: try/catch returns JSON envelope string.
  // WKWebView's `evaluateJavaScript:` delivers the string directly (no outer
  // re-stringify), so the inner envelope is the completion result.
  if (!script) {
    std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                          ",\"ok\":false,\"code\":\"runtime_error\","
                          "\"message\":\"null script\"}";
    bunite_mac::emitWebviewEvent(view_id, "evaluate-result", payload);
    return;
  }
  std::string wrapped =
      "(function(){try{return JSON.stringify({__bunite_ok:true,value:("
      + std::string(script) +
      ")})}catch(e){var c=(e&&e.name===\"SecurityError\")?\"cross_origin\":\"runtime_error\";"
      "return JSON.stringify({__bunite_ok:false,code:c,"
      "message:(e&&e.message)?e.message:String(e),"
      "name:(e&&e.name)||\"\"})}})()";
  NSString* nsScript = [NSString stringWithUTF8String:wrapped.c_str()];
  runOnUiThreadSync([=]() {
    auto* v = bunite_mac::findView(view_id);
    if (!v || !v->webview) {
      std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                            ",\"ok\":false,\"code\":\"not_supported\","
                            "\"message\":\"view not ready\"}";
      bunite_mac::emitWebviewEvent(view_id, "evaluate-result", payload);
      return;
    }
    [v->webview evaluateJavaScript:nsScript completionHandler:^(id result, NSError* error) {
      std::string payload = "{\"requestId\":" + std::to_string(request_id);
      if (error) {
        std::string msg = error.localizedDescription.UTF8String ?: "evaluate failed";
        payload += ",\"ok\":false,\"code\":\"runtime_error\","
                   "\"message\":\"" + bunite_mac::escapeJsonString(msg) + "\"}";
      } else if (![result isKindOfClass:[NSString class]]) {
        payload += ",\"ok\":false,\"code\":\"runtime_error\","
                   "\"message\":\"wrapper returned non-string\"}";
      } else {
        std::string inner = ((NSString*)result).UTF8String ?: "";
        if (inner.find("\"__bunite_ok\":true") != std::string::npos) {
          static const std::string prefix = "{\"__bunite_ok\":true,\"value\":";
          std::string value_json = "null";
          if (inner.compare(0, prefix.size(), prefix) == 0 &&
              inner.size() > prefix.size() + 1) {
            value_json = inner.substr(prefix.size(), inner.size() - prefix.size() - 1);
          }
          payload += ",\"ok\":true,\"value\":\"" + bunite_mac::escapeJsonString(value_json) + "\"}";
        } else {
          // Anchor extraction at the fixed envelope prefix — user-controlled
          // e.message could otherwise inject a fake "code" via substring match.
          static const std::string codePrefix = "{\"__bunite_ok\":false,\"code\":\"";
          std::string code = "runtime_error";
          std::string msg = "script threw";
          if (inner.compare(0, codePrefix.size(), codePrefix) == 0) {
            size_t start = codePrefix.size();
            size_t end = start;
            while (end < inner.size() && inner[end] != '"') ++end;
            if (end > start) code = inner.substr(start, end - start);
            static const std::string msgKey = "\",\"message\":\"";
            if (end + msgKey.size() <= inner.size() &&
                inner.compare(end, msgKey.size(), msgKey) == 0) {
              size_t mstart = end + msgKey.size();
              size_t mend = mstart;
              while (mend < inner.size()) {
                if (inner[mend] == '"' && (mend == mstart || inner[mend - 1] != '\\')) break;
                ++mend;
              }
              if (mend > mstart) msg = inner.substr(mstart, mend - mstart);
            }
          }
          payload += ",\"ok\":false,\"code\":\"" + bunite_mac::escapeJsonString(code) + "\","
                     "\"message\":\"" + bunite_mac::escapeJsonString(msg) + "\"}";
        }
      }
      bunite_mac::emitWebviewEvent(view_id, "evaluate-result", payload);
    }];
  });
}

extern "C" BUNITE_EXPORT void bunite_view_load_url(uint32_t view_id, const char* url) {
  // Drop stored HTML so a later nav to internal/index.html doesn't resurrect it.
  bunite::WebviewContentStorage::instance().remove(view_id);
  NSString* s = bunite_mac::utf8ToNSString(url);
  runOnUiThreadSync([=]() {
    auto* v = bunite_mac::findView(view_id);
    if (!v) return;
    NSURL* u = [NSURL URLWithString:s];
    if (u) [v->webview loadRequest:[NSURLRequest requestWithURL:u]];
  });
}

extern "C" BUNITE_EXPORT void bunite_view_load_html(uint32_t view_id, const char* html) {
  // Nav to internal/index.html so origin = appres://app.internal — preload/RPC/CSP/CORS match static pages.
  std::string content = html ? html : "";
  bunite::WebviewContentStorage::instance().set(view_id, content);
  runOnUiThreadSync([=]() {
    auto* v = bunite_mac::findView(view_id);
    if (!v) return;
    NSURL* u = [NSURL URLWithString:@"appres://app.internal/internal/index.html"];
    [v->webview loadRequest:[NSURLRequest requestWithURL:u]];
  });
}

extern "C" BUNITE_EXPORT void bunite_register_appres_route(const char* path) {
  bunite::AppResRouteStorage::instance().registerRoute(path ? path : "");
}

extern "C" BUNITE_EXPORT void bunite_unregister_appres_route(const char* path) {
  bunite::AppResRouteStorage::instance().unregisterRoute(path ? path : "");
}

extern "C" BUNITE_EXPORT void bunite_complete_route_request(uint32_t request_id, const char* html) {
  std::string body = html ? html : "";
  dispatch_async(dispatch_get_main_queue(), ^{
    BunitePendingRoute* entry = bunite_mac::g_runtime.pending_route_tasks[@(request_id)];
    if (!entry) return;  // already stopped (view destroyed) or unknown id
    [bunite_mac::g_runtime.pending_route_tasks removeObjectForKey:@(request_id)];
    id<WKURLSchemeTask> task = entry.task;
    NSData* data = [NSData dataWithBytes:body.data() length:body.size()];
    NSURLResponse* response = [[NSURLResponse alloc]
      initWithURL:task.request.URL MIMEType:@"text/html"
      expectedContentLength:data.length textEncodingName:nil];
    // Race: WebKit can stop the task between lookup and didFinish — swallow.
    @try {
      [task didReceiveResponse:response];
      [task didReceiveData:data];
      [task didFinish];
    } @catch (NSException* e) {
      // task stopped — silent
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_set_visible(uint32_t view_id, bool visible) {
  runOnUiThreadSync([=]() {
    if (auto* v = bunite_mac::findView(view_id)) v->container.hidden = !visible;
  });
}

extern "C" BUNITE_EXPORT void bunite_view_set_input_passthrough(uint32_t view_id, bool passthrough) {
  runOnUiThreadSync([=]() {
    if (auto* v = bunite_mac::findView(view_id)) v->container.passthrough = passthrough;
  });
}

extern "C" BUNITE_EXPORT void bunite_view_set_mask_region(uint32_t view_id, const double* rects, uint32_t count) {
  std::vector<NSRect> physical(count);
  for (uint32_t i = 0; i < count; i++) {
    const double* r = rects + i * 4;
    physical[i] = NSMakeRect(r[0], r[1], r[2], r[3]);
  }
  runOnUiThreadSync([view_id, physical = std::move(physical)]() {
    auto* v = bunite_mac::findView(view_id);
    if (!v || !v->container) return;
    BunitePassthroughContainer* container = v->container;
    if (physical.empty()) {
      container.layer.mask = nil;
      container.maskHoles = nil;
      return;
    }
    CGFloat dpr = container.window.backingScaleFactor ?: 1.0;
    NSPoint origin = container.frame.origin;  // window-local, points
    CGMutablePathRef path = CGPathCreateMutable();
    CGPathAddRect(path, NULL, container.bounds);  // outer
    NSMutableArray<NSValue*>* holes = [NSMutableArray arrayWithCapacity:physical.size()];
    for (const NSRect& rp : physical) {
      // physical pixels in window coords → points → container-local.
      NSRect local = NSMakeRect(
        rp.origin.x / dpr - origin.x,
        rp.origin.y / dpr - origin.y,
        rp.size.width / dpr,
        rp.size.height / dpr);
      CGPathAddRect(path, NULL, local);
      [holes addObject:[NSValue valueWithRect:local]];
    }
    // kCAFillRuleEvenOdd: overlapping holes XOR (unlike win RGN_DIFF). Hit-test uses raw rects.
    CAShapeLayer* mask = [CAShapeLayer layer];
    mask.path = path;
    mask.fillRule = kCAFillRuleEvenOdd;
    container.layer.mask = mask;
    container.maskHoles = holes;
    CGPathRelease(path);
  });
}

extern "C" BUNITE_EXPORT void bunite_view_bring_to_front(uint32_t view_id) {
  runOnUiThreadSync([=]() {
    auto* v = bunite_mac::findView(view_id);
    if (!v || !v->container) return;
    NSView* parent = v->container.superview;
    if (!parent) return;
    [v->container removeFromSuperview];
    [parent addSubview:v->container];  // last subview = top of z-order
  });
}

// set_bounds: physical pixels (JS pre-multiplies DPR). createView: logical points (main view only, never re-bounded).
extern "C" BUNITE_EXPORT void bunite_view_set_bounds(
  uint32_t view_id, double x, double y, double width, double height
) {
  runOnUiThreadSync([=]() {
    auto* v = bunite_mac::findView(view_id);
    if (!v || !v->container) return;
    CGFloat dpr = v->container.window.backingScaleFactor ?: 1.0;
    v->container.frame = NSMakeRect(x / dpr, y / dpr, width / dpr, height / dpr);
  });
}

extern "C" BUNITE_EXPORT void bunite_view_set_bounds_async(
  uint32_t view_id, double x, double y, double width, double height
) {
  dispatch_async(dispatch_get_main_queue(), ^{
    auto* v = bunite_mac::findView(view_id);
    if (!v || !v->container) return;
    CGFloat dpr = v->container.window.backingScaleFactor ?: 1.0;
    v->container.frame = NSMakeRect(x / dpr, y / dpr, width / dpr, height / dpr);
  });
}

extern "C" BUNITE_EXPORT void bunite_view_set_anchor(uint32_t view_id, int mode, double inset) {
  (void)view_id; (void)mode; (void)inset;
  BUNITE_MAC_TODO("bunite_view_set_anchor");
}

extern "C" BUNITE_EXPORT void bunite_view_go_back(uint32_t view_id) {
  runOnUiThreadSync([=]() {
    if (auto* v = bunite_mac::findView(view_id)) [v->webview goBack];
  });
}

extern "C" BUNITE_EXPORT void bunite_view_reload(uint32_t view_id) {
  runOnUiThreadSync([=]() {
    if (auto* v = bunite_mac::findView(view_id)) [v->webview reload];
  });
}

extern "C" BUNITE_EXPORT void bunite_view_remove(uint32_t view_id) {
  runOnUiThreadSync([=]() { bunite_mac::removeView(view_id); });
}

// Input dispatch — synthesized NSEvent + window sendEvent: (full responder chain).
// `isTrusted` is false (synthetic), so `nativeInputTrusted` capability stays false.
namespace {

NSEventModifierFlags macModifiers(uint32_t bits) {
  NSEventModifierFlags m = 0;
  if (bits & 8) m |= NSEventModifierFlagShift;
  if (bits & 2) m |= NSEventModifierFlagControl;
  if (bits & 1) m |= NSEventModifierFlagOption;
  if (bits & 4) m |= NSEventModifierFlagCommand;
  return m;
}

NSEventType macMouseDownType(int32_t button) {
  switch (button) {
    case 1: return NSEventTypeOtherMouseDown;
    case 2: return NSEventTypeRightMouseDown;
    default: return NSEventTypeLeftMouseDown;
  }
}
NSEventType macMouseUpType(int32_t button) {
  switch (button) {
    case 1: return NSEventTypeOtherMouseUp;
    case 2: return NSEventTypeRightMouseUp;
    default: return NSEventTypeLeftMouseUp;
  }
}

// FFI x/y is CSS px in top-left view space; convert to AppKit window coords.
// WKWebView is non-flipped, so y flips against bounds.height.
NSPoint viewPointToWindow(NSView* view, double x, double y) {
  NSRect bounds = view.bounds;
  NSPoint local = view.isFlipped ? NSMakePoint(x, y) : NSMakePoint(x, bounds.size.height - y);
  return [view convertPoint:local toView:nil];
}

}  // namespace

extern "C" BUNITE_EXPORT void bunite_view_click(uint32_t view_id, double x, double y,
                                                  int32_t button, int32_t click_count, uint32_t modifiers) {
  if (click_count < 1) click_count = 1;
  runOnUiThreadSync([=]() {
    auto* v = bunite_mac::findView(view_id);
    if (!v || !v->webview || !v->webview.window) return;
    NSWindow* win = v->webview.window;
    NSPoint loc = viewPointToWindow(v->webview, x, y);
    // Strip the Control bit from mouse-event modifierFlags: AppKit converts
    // Ctrl+leftMouseDown into a secondary click (context-menu modal),
    // deadlocking the cooperative pump. Page-side `ctrlKey` will read false
    // for ctrl-click on mac as a result — callers needing ctrl-click should
    // wrap with explicit `press("Control")` keydown/keyup.
    NSEventModifierFlags flags = macModifiers(modifiers) & ~NSEventModifierFlagControl;
    // dblclick parity: ascending clickCount per pair. Dispatch directly to
    // the WKWebView — `[win sendEvent:]` enters AppKit's modal mouse-tracking
    // loop and deadlocks the cooperative pump.
    for (int i = 1; i <= click_count; ++i) {
      NSEvent* down = [NSEvent mouseEventWithType:macMouseDownType(button)
                                         location:loc modifierFlags:flags
                                        timestamp:[[NSProcessInfo processInfo] systemUptime]
                                     windowNumber:win.windowNumber context:nil
                                      eventNumber:0 clickCount:i pressure:1.0];
      NSEvent* up = [NSEvent mouseEventWithType:macMouseUpType(button)
                                       location:loc modifierFlags:flags
                                      timestamp:[[NSProcessInfo processInfo] systemUptime]
                                   windowNumber:win.windowNumber context:nil
                                    eventNumber:0 clickCount:i pressure:0.0];
      // Dispatch directly to WKWebView — `[NSApp sendEvent:]` would translate
      // Ctrl+leftMouseDown into rightMouseDown (AppKit's emulated secondary
      // click), entering the context-menu modal run-loop mode and stalling
      // the cooperative pump indefinitely.
      if (down) {
        if (button == 0)      [v->webview mouseDown:down];
        else if (button == 2) [v->webview rightMouseDown:down];
        else                  [v->webview otherMouseDown:down];
      }
      if (up) {
        if (button == 0)      [v->webview mouseUp:up];
        else if (button == 2) [v->webview rightMouseUp:up];
        else                  [v->webview otherMouseUp:up];
      }
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_type(uint32_t view_id, const char* text) {
  std::string s = text ? text : "";
  runOnUiThreadSync([=]() {
    auto* v = bunite_mac::findView(view_id);
    if (!v || !v->webview) return;
    NSString* ns = [NSString stringWithUTF8String:s.c_str()];
    if (!ns.length) return;
    // WKWebView conforms to NSTextInputClient — insertText: routes through
    // its IME chain so DOM input events fire on focused editable elements.
    if ([v->webview respondsToSelector:@selector(insertText:)]) {
      [(id)v->webview insertText:ns];
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_press(uint32_t view_id, int32_t /*windows_vk_code*/,
                                                  int32_t mac_key_code, const char* /*key*/, const char* /*code*/,
                                                  const char* character, uint32_t modifiers) {
  std::string char_str = character ? character : "";
  runOnUiThreadSync([=]() {
    auto* v = bunite_mac::findView(view_id);
    if (!v || !v->webview || !v->webview.window) return;
    NSString* chars = char_str.empty() ? @"" : [NSString stringWithUTF8String:char_str.c_str()];
    NSEventModifierFlags flags = macModifiers(modifiers);
    NSWindow* win = v->webview.window;
    NSEvent* down = [NSEvent keyEventWithType:NSEventTypeKeyDown
                                     location:NSZeroPoint modifierFlags:flags
                                    timestamp:[[NSProcessInfo processInfo] systemUptime]
                                 windowNumber:win.windowNumber context:nil
                                   characters:chars charactersIgnoringModifiers:chars
                                    isARepeat:NO keyCode:(unsigned short)mac_key_code];
    NSEvent* up = [NSEvent keyEventWithType:NSEventTypeKeyUp
                                   location:NSZeroPoint modifierFlags:flags
                                  timestamp:[[NSProcessInfo processInfo] systemUptime]
                               windowNumber:win.windowNumber context:nil
                                 characters:chars charactersIgnoringModifiers:chars
                                  isARepeat:NO keyCode:(unsigned short)mac_key_code];
    // Direct WKWebView dispatch — same translation/modal concerns as click.
    if (down) [v->webview keyDown:down];
    if (up)   [v->webview keyUp:up];
  });
}

extern "C" BUNITE_EXPORT void bunite_view_scroll(uint32_t view_id, double dx, double dy,
                                                   double x, double y, uint32_t modifiers) {
  runOnUiThreadSync([=]() {
    auto* v = bunite_mac::findView(view_id);
    if (!v || !v->webview || !v->webview.window) return;
    CGEventRef cg = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 2,
                                                  static_cast<int32_t>(-dy),
                                                  static_cast<int32_t>(-dx));
    if (!cg) return;
    // CGEvent location is screen coords; CSS px → window → screen.
    NSPoint inWin = viewPointToWindow(v->webview, x, y);
    NSPoint onScreen = [v->webview.window convertPointToScreen:inWin];
    CGEventSetLocation(cg, CGPointMake(onScreen.x, onScreen.y));
    CGEventSetFlags(cg, (CGEventFlags)macModifiers(modifiers));
    NSEvent* ev = [NSEvent eventWithCGEvent:cg];
    CFRelease(cg);
    if (ev) [v->webview scrollWheel:ev];
  });
}

// Screenshot — WKWebView.takeSnapshotWithConfiguration: + NSBitmapImageRep PNG/JPEG.
namespace {

void emitMacScreenshotError(uint32_t view_id, uint32_t request_id, const char* code, NSString* msg) {
  std::string m = msg ? (msg.UTF8String ?: "") : "";
  std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                        ",\"ok\":false,\"code\":\"" + code + "\","
                        "\"message\":\"" + bunite_mac::escapeJsonString(m) + "\"}";
  bunite_mac::emitWebviewEvent(view_id, "screenshot-result", payload);
}

}  // namespace

extern "C" BUNITE_EXPORT uint32_t bunite_view_capabilities(uint32_t view_id) {
  // WKWebView — synthetic NSEvent dispatched directly to the view. Empirically
  // WebKit marks these events `isTrusted=true` on the page (the synthesis bit
  // matters for AppKit responder routing, not for the DOM trust flag).
  auto* v = bunite_mac::findView(view_id);
  if (!v) return 0;
  return BUNITE_CAP_EVALUATE | BUNITE_CAP_TITLE_CHANGED |
         BUNITE_CAP_NATIVE_INPUT_TRUSTED |
         BUNITE_CAP_CLICK | BUNITE_CAP_TYPE | BUNITE_CAP_PRESS | BUNITE_CAP_SCROLL |
         BUNITE_CAP_SCREENSHOT | BUNITE_CAP_FORMAT_PNG | BUNITE_CAP_FORMAT_JPEG;
}

extern "C" BUNITE_EXPORT void bunite_view_screenshot(uint32_t view_id, uint32_t request_id,
                                                       const char* format, int32_t quality) {
  std::string fmt = format ? format : "png";
  runOnUiThreadSync([=]() {
    auto* v = bunite_mac::findView(view_id);
    if (!v || !v->webview) {
      emitMacScreenshotError(view_id, request_id, "not_supported", @"view not ready");
      return;
    }
    WKSnapshotConfiguration* cfg = [[WKSnapshotConfiguration alloc] init];
    cfg.afterScreenUpdates = YES;
    const bool jpeg = (fmt == "jpeg" || fmt == "jpg");
    NSString* outFmt = jpeg ? @"jpeg" : @"png";
    NSString* mime = jpeg ? @"image/jpeg" : @"image/png";
    [v->webview takeSnapshotWithConfiguration:cfg
                            completionHandler:^(NSImage* img, NSError* err) {
      if (err || !img) {
        emitMacScreenshotError(view_id, request_id, "runtime_error", err ? err.localizedDescription : @"takeSnapshot returned nil");
        return;
      }
      CGImageRef cgImg = [img CGImageForProposedRect:nullptr context:nil hints:nil];
      if (!cgImg) {
        emitMacScreenshotError(view_id, request_id, "runtime_error", @"CGImageForProposedRect failed");
        return;
      }
      NSBitmapImageRep* rep = [[NSBitmapImageRep alloc] initWithCGImage:cgImg];
      NSDictionary* props = jpeg
        ? @{ NSImageCompressionFactor: @((quality < 0 ? 0.9 : std::min(quality, 100) / 100.0)) }
        : @{};
      NSData* data = [rep representationUsingType:(jpeg ? NSBitmapImageFileTypeJPEG : NSBitmapImageFileTypePNG)
                                       properties:props];
      if (!data || data.length == 0) {
        emitMacScreenshotError(view_id, request_id, "runtime_error", @"encode failed");
        return;
      }
      NSString* b64 = [data base64EncodedStringWithOptions:0];
      std::string payload = "{\"requestId\":" + std::to_string(request_id) +
                            ",\"ok\":true,\"format\":\"" + outFmt.UTF8String +
                            "\",\"mime\":\"" + mime.UTF8String +
                            "\",\"dataBase64\":\"" + (b64.UTF8String ?: "") + "\"}";
      bunite_mac::emitWebviewEvent(view_id, "screenshot-result", payload);
    }];
  });
}

extern "C" BUNITE_EXPORT void bunite_view_open_devtools(uint32_t view_id) {
  runOnUiThreadSync([=]() {
    if (@available(macOS 13.3, *)) {
      if (auto* v = bunite_mac::findView(view_id)) v->webview.inspectable = YES;
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_close_devtools(uint32_t view_id) {
  runOnUiThreadSync([=]() {
    if (@available(macOS 13.3, *)) {
      if (auto* v = bunite_mac::findView(view_id)) v->webview.inspectable = NO;
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_view_toggle_devtools(uint32_t view_id) {
  runOnUiThreadSync([=]() {
    if (@available(macOS 13.3, *)) {
      if (auto* v = bunite_mac::findView(view_id)) v->webview.inspectable = !v->webview.inspectable;
    }
  });
}

extern "C" BUNITE_EXPORT void bunite_complete_permission_request(uint32_t request_id, uint32_t state) {
  dispatch_async(dispatch_get_main_queue(), ^{
    BunitePendingPermission* entry = bunite_mac::g_runtime.pending_permissions[@(request_id)];
    if (!entry) return;  // unknown id, or already resolved (e.g. view destroyed)
    [bunite_mac::g_runtime.pending_permissions removeObjectForKey:@(request_id)];
    if (@available(macOS 12.0, *)) {
      entry.handler(state == 0 ? WKPermissionDecisionDeny : WKPermissionDecisionGrant);
    }
  });
}
