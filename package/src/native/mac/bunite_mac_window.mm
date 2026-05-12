// NSWindow lifecycle + delegate. Mirrors win/native_host_runtime.cpp window proc.

#import "bunite_mac_internal.h"

#include <sstream>
#include <vector>

using bunite_mac::g_runtime;
using bunite_mac::utf8ToNSString;
using bunite_mac::bottomLeftToTopLeft;

namespace {

NSString* kHiddenStyle = @"hidden";
NSString* kHiddenInsetStyle = @"hiddenInset";

NSUInteger styleMaskFor(NSString* tbs) {
  NSUInteger base = NSWindowStyleMaskClosable | NSWindowStyleMaskResizable | NSWindowStyleMaskMiniaturizable;
  if ([tbs isEqualToString:kHiddenStyle]) {
    return base | NSWindowStyleMaskFullSizeContentView;  // no titled
  }
  return base | NSWindowStyleMaskTitled;
}

std::string movePayload(NSWindow* w) {
  double x, y, ww, hh;
  bottomLeftToTopLeft(w.frame, &x, &y, &ww, &hh);
  (void)ww; (void)hh;
  std::ostringstream o;
  o << "{\"x\":" << x << ",\"y\":" << y
    << ",\"maximized\":" << (w.zoomed ? "true" : "false")
    << ",\"minimized\":" << (w.miniaturized ? "true" : "false") << "}";
  return o.str();
}

std::string resizePayload(NSWindow* w) {
  double x, y, ww, hh;
  bottomLeftToTopLeft(w.frame, &x, &y, &ww, &hh);
  std::ostringstream o;
  o << "{\"x\":" << x << ",\"y\":" << y
    << ",\"width\":" << ww << ",\"height\":" << hh
    << ",\"maximized\":" << (w.zoomed ? "true" : "false")
    << ",\"minimized\":" << (w.miniaturized ? "true" : "false") << "}";
  return o.str();
}

} // namespace

// Flipped container so child NSViews use top-left coordinates (matches surface IPC).
@interface BuniteFlippedView : NSView
@end
@implementation BuniteFlippedView
- (BOOL)isFlipped { return YES; }
@end

@interface BuniteWindowDelegate : NSObject <NSWindowDelegate>
@property (nonatomic, assign) uint32_t window_id;
@end

@implementation BuniteWindowDelegate

- (BOOL)windowShouldClose:(NSWindow*)w {
  (void)w;
  bunite_mac::WindowState* state = bunite_mac::findWindow(self.window_id);
  if (!state) return YES;
  if (state->close_pending.exchange(true)) return NO;  // already pending
  bunite_mac::emitWindowEvent(self.window_id, "close-requested");
  return NO;  // JS responds with bunite_window_destroy or reset_close_pending
}

- (void)windowWillClose:(NSNotification*)n {
  (void)n;
  uint32_t id = self.window_id;
  bunite_mac::emitWindowEvent(id, "close");

  // Tear down child views before erasing the window so WKWebViews don't outlive their host.
  std::vector<uint32_t> orphaned;
  bool windows_empty = false;
  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    for (auto& [vid, vst] : g_runtime.views) {
      if (vst.window_id == id) orphaned.push_back(vid);
    }
    g_runtime.windows.erase(id);
    windows_empty = g_runtime.windows.empty();
  }
  for (uint32_t vid : orphaned) bunite_mac::removeView(vid);
  if (windows_empty && !g_runtime.shutting_down.load()) {
    bunite_mac::emitWindowEvent(0, "all-windows-closed");
  }
}

- (void)windowDidBecomeKey:(NSNotification*)n {
  (void)n;
  bunite_mac::emitWindowEvent(self.window_id, "focus");
}

- (void)windowDidResignKey:(NSNotification*)n {
  (void)n;
  bunite_mac::emitWindowEvent(self.window_id, "blur");
}

- (void)windowDidMove:(NSNotification*)n {
  bunite_mac::WindowState* state = bunite_mac::findWindow(self.window_id);
  if (!state) return;
  bunite_mac::emitWindowEvent(self.window_id, "move", movePayload(state->window));
}

- (void)windowDidResize:(NSNotification*)n {
  bunite_mac::WindowState* state = bunite_mac::findWindow(self.window_id);
  if (!state) return;
  bunite_mac::emitWindowEvent(self.window_id, "resize", resizePayload(state->window));
}

@end

namespace bunite_mac {

WindowState* findWindow(uint32_t window_id) {
  std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
  auto it = g_runtime.windows.find(window_id);
  return it == g_runtime.windows.end() ? nullptr : &it->second;
}

bool createWindow(uint32_t window_id, double x, double y, double width, double height,
                  NSString* title, NSString* title_bar_style,
                  bool transparent, bool hidden, bool minimized, bool maximized) {
  if (findWindow(window_id)) {
    BUNITE_WARN("bunite_window_create: id %u already exists.", window_id);
    return false;
  }

  NSRect frame = topLeftToBottomLeft(x, y, width, height);
  NSUInteger style = styleMaskFor(title_bar_style);

  NSWindow* window = [[NSWindow alloc] initWithContentRect:frame
                                                 styleMask:style
                                                   backing:NSBackingStoreBuffered
                                                     defer:NO];
  window.releasedWhenClosed = NO;  // ARC __strong holds it; AppKit self-release would over-release.
  window.title = title ?: @"";
  window.contentView = [[BuniteFlippedView alloc] initWithFrame:frame];

  if ([title_bar_style isEqualToString:kHiddenInsetStyle]) {
    window.titlebarAppearsTransparent = YES;
    window.titleVisibility = NSWindowTitleHidden;
  }
  if (transparent) {
    window.opaque = NO;
    window.backgroundColor = [NSColor clearColor];
    window.hasShadow = NO;
  }

  BuniteWindowDelegate* delegate = [[BuniteWindowDelegate alloc] init];
  delegate.window_id = window_id;
  window.delegate = delegate;

  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    auto& state = g_runtime.windows[window_id];
    state.window = window;
    state.delegate = delegate;
  }

  if (!hidden) {
    [window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
  }
  if (minimized) [window miniaturize:nil];
  if (maximized && !window.zoomed) [window zoom:nil];

  return true;
}

void destroyWindow(uint32_t window_id) {
  __strong NSWindow* window = nil;
  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    auto it = g_runtime.windows.find(window_id);
    if (it == g_runtime.windows.end()) return;
    window = it->second.window;
    // Don't erase here — windowWillClose: does it after emitting "close".
  }
  if (window) [window close];
}

} // namespace bunite_mac
