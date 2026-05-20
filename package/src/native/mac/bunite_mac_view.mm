// WKWebView lifecycle + navigation/UI delegates.

#import "bunite_mac_internal.h"

#include "webview_storage.h"

@implementation BunitePendingPermission
@end

@implementation BunitePendingRoute
@end

@implementation BunitePassthroughContainer
- (BOOL)isFlipped { return YES; }
- (NSView*)hitTest:(NSPoint)point {
  if (self.passthrough) return nil;
  if (self.maskHoles.count > 0) {
    NSPoint local = [self convertPoint:point fromView:self.superview];
    for (NSValue* v in self.maskHoles) {
      if (NSPointInRect(local, v.rectValue)) return nil;
    }
  }
  return [super hitTest:point];
}
@end

using bunite_mac::g_runtime;
using bunite_mac::utf8ToNSString;

@interface BuniteNavigationDelegate : NSObject <WKNavigationDelegate>
@end

@implementation BuniteNavigationDelegate

- (void)webView:(WKWebView*)wv
decidePolicyForNavigationAction:(WKNavigationAction*)action
       decisionHandler:(void(^)(WKNavigationActionPolicy))decisionHandler
{
  // nil targetFrame = popup (window.open, target=_blank, ctrl-click); apply main-frame rules.
  if (action.targetFrame && !action.targetFrame.mainFrame) {
    decisionHandler(WKNavigationActionPolicyAllow);
    return;
  }
  uint32_t view_id = bunite_mac::viewIdForWebView(wv);
  const std::string url_str = (action.request.URL.absoluteString ?: @"").UTF8String;
  // Evaluate before will-navigate — a synchronous handler could destroy the view.
  const bool allow = bunite_mac::shouldAllowNavigation(bunite_mac::findView(view_id), url_str);
  bunite_mac::emitWebviewEvent(view_id, "will-navigate", url_str);
  decisionHandler(allow ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}

- (void)webView:(WKWebView*)wv didStartProvisionalNavigation:(WKNavigation*)nav {
  (void)nav;
  uint32_t view_id = bunite_mac::viewIdForWebView(wv);
  NSString* url = wv.URL.absoluteString ?: @"";
  bunite_mac::emitWebviewEvent(view_id, "load-start", url.UTF8String);
}

- (void)webView:(WKWebView*)wv didCommitNavigation:(WKNavigation*)nav {
  (void)nav;
  uint32_t view_id = bunite_mac::viewIdForWebView(wv);
  NSString* url = wv.URL.absoluteString ?: @"";
  // URL commit point — surfaceEvents `navigate` arm. WKWebView fires this
  // when the document begins loading after server response (post-redirect).
  bunite_mac::emitWebviewEvent(view_id, "did-navigate", url.UTF8String);
}

- (void)webView:(WKWebView*)wv didFinishNavigation:(WKNavigation*)nav {
  (void)nav;
  uint32_t view_id = bunite_mac::viewIdForWebView(wv);
  NSString* url = wv.URL.absoluteString ?: @"";
  bunite_mac::emitWebviewEvent(view_id, "load-finish", url.UTF8String);
  bunite_mac::emitWebviewEvent(view_id, "dom-ready", url.UTF8String);
}

- (void)webView:(WKWebView*)wv didFailNavigation:(WKNavigation*)nav withError:(NSError*)error {
  (void)nav;
  uint32_t view_id = bunite_mac::viewIdForWebView(wv);
  NSString* url = wv.URL.absoluteString ?: @"";
  std::string payload = "{\"url\":\"" + bunite_mac::escapeJsonString(url.UTF8String ?: "") +
                        "\",\"reason\":\"" + bunite_mac::escapeJsonString(error.localizedDescription.UTF8String ?: "") + "\"}";
  bunite_mac::emitWebviewEvent(view_id, "load-fail", payload);
}

- (void)webView:(WKWebView*)wv didFailProvisionalNavigation:(WKNavigation*)nav withError:(NSError*)error {
  (void)nav;
  uint32_t view_id = bunite_mac::viewIdForWebView(wv);
  NSString* failingUrl = ((NSURL*)error.userInfo[NSURLErrorFailingURLErrorKey]).absoluteString
                       ?: (wv.URL.absoluteString ?: @"");
  std::string payload = "{\"url\":\"" + bunite_mac::escapeJsonString(failingUrl.UTF8String ?: "") +
                        "\",\"reason\":\"" + bunite_mac::escapeJsonString(error.localizedDescription.UTF8String ?: "") + "\"}";
  bunite_mac::emitWebviewEvent(view_id, "load-fail", payload);
}

@end

@interface BuniteTitleObserver : NSObject
+ (instancetype)shared;
@end

@implementation BuniteTitleObserver
+ (instancetype)shared {
  static BuniteTitleObserver* o = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ o = [[BuniteTitleObserver alloc] init]; });
  return o;
}
- (void)observeValueForKeyPath:(NSString*)keyPath
                      ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey, id>*)change
                       context:(void*)context
{
  (void)change; (void)context;
  if (![keyPath isEqualToString:@"title"]) return;
  WKWebView* wv = (WKWebView*)object;
  uint32_t view_id = bunite_mac::viewIdForWebView(wv);
  if (!view_id) return;
  NSString* title = wv.title ?: @"";
  std::string payload = "{\"title\":\"" +
    bunite_mac::escapeJsonString(title.UTF8String ?: "") + "\"}";
  bunite_mac::emitWebviewEvent(view_id, "title-changed", payload);
}
@end

@interface BuniteUIDelegate : NSObject <WKUIDelegate>
@end

@implementation BuniteUIDelegate

- (WKWebView*)webView:(WKWebView*)wv
createWebViewWithConfiguration:(WKWebViewConfiguration*)config
              forNavigationAction:(WKNavigationAction*)action
                   windowFeatures:(WKWindowFeatures*)features
{
  (void)config; (void)features;
  uint32_t view_id = bunite_mac::viewIdForWebView(wv);
  NSString* url = action.request.URL.absoluteString ?: @"";
  // Match win OnBeforePopup/OnOpenURLFromTab: emit, cancel; JS decides via load_url.
  std::string payload = "{\"url\":\"" +
    bunite_mac::escapeJsonString(url.UTF8String ?: "") + "\"}";
  bunite_mac::emitWebviewEvent(view_id, "new-window-open", payload);
  return nil;
}

- (void)webView:(WKWebView*)wv
requestMediaCapturePermissionForOrigin:(WKSecurityOrigin*)origin
              initiatedByFrame:(WKFrameInfo*)frame
                          type:(WKMediaCaptureType)type
              decisionHandler:(void(^)(WKPermissionDecision))decisionHandler
              API_AVAILABLE(macos(12.0))
{
  (void)frame;
  uint32_t view_id = bunite_mac::viewIdForWebView(wv);
  uint32_t kind = 0;
  switch (type) {
    case WKMediaCaptureTypeCamera:
      kind = BUNITE_PERMISSION_CAMERA; break;
    case WKMediaCaptureTypeMicrophone:
      kind = BUNITE_PERMISSION_MICROPHONE; break;
    case WKMediaCaptureTypeCameraAndMicrophone:
      kind = BUNITE_PERMISSION_CAMERA | BUNITE_PERMISSION_MICROPHONE; break;
  }

  if (!bunite_mac::g_runtime.pending_permissions) {
    bunite_mac::g_runtime.pending_permissions = [NSMutableDictionary dictionary];
  }
  uint32_t request_id = bunite_mac::g_runtime.next_permission_request_id++;
  BunitePendingPermission* entry = [[BunitePendingPermission alloc] init];
  entry.viewId = view_id;
  entry.handler = decisionHandler;
  bunite_mac::g_runtime.pending_permissions[@(request_id)] = entry;

  NSString* origin_str = origin.port != 0
    ? [NSString stringWithFormat:@"%@://%@:%ld", origin.protocol, origin.host, (long)origin.port]
    : [NSString stringWithFormat:@"%@://%@", origin.protocol, origin.host];
  std::string payload = "{\"requestId\":" + std::to_string(request_id) +
    ",\"kind\":" + std::to_string(kind) +
    ",\"url\":\"" + bunite_mac::escapeJsonString(origin_str.UTF8String ?: "") + "\"}";
  bunite_mac::emitWebviewEvent(view_id, "permission-requested", payload);
}

@end

namespace {

// __weak NSMapTable so we don't retain WKWebViews via the lookup table.
NSMapTable<WKWebView*, NSNumber*>* webviewIdTable() {
  static NSMapTable* t = [NSMapTable mapTableWithKeyOptions:NSPointerFunctionsWeakMemory
                                               valueOptions:NSPointerFunctionsStrongMemory];
  return t;
}

} // namespace

namespace bunite_mac {

ViewState* findView(uint32_t view_id) {
  std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
  auto it = g_runtime.views.find(view_id);
  return it == g_runtime.views.end() ? nullptr : &it->second;
}

uint32_t viewIdForWebView(WKWebView* wv) {
  NSNumber* id = [webviewIdTable() objectForKey:wv];
  return id ? id.unsignedIntValue : 0;
}

bool createView(uint32_t view_id, uint32_t window_id,
                NSString* url, NSString* html, NSString* preload, NSString* appres_root,
                NSString* navigation_rules_json, NSString* preload_origins_json,
                double x, double y, double width, double height, bool auto_resize) {
  WindowState* window_state = findWindow(window_id);
  if (!window_state) {
    BUNITE_WARN("bunite_view_create: window %u not found.", window_id);
    return false;
  }
  if (findView(view_id)) {
    BUNITE_WARN("bunite_view_create: view %u already exists.", view_id);
    return false;
  }

  WKWebViewConfiguration* config = [[WKWebViewConfiguration alloc] init];
  [config setURLSchemeHandler:sharedAppresSchemeHandler() forURLScheme:@"appres"];
  // popup_blocking=true → block popups without user gesture (default).
  config.preferences.javaScriptCanOpenWindowsAutomatically = !g_runtime.popup_blocking;

  if (preload.length > 0) {
    // WKUserScript has no per-origin filter — gate in-script so remote pages don't inherit RPC bridge + secret.
    NSString* origins = preload_origins_json.length > 0 ? preload_origins_json : @"[]";
    NSString* gated = [NSString stringWithFormat:
      @"(function(){"
      @"  var _o=%@;_o.push('appres://app.internal');"
      @"  if(_o.indexOf(location.origin)<0)return;"
      @"  %@"
      @"})();", origins, preload];
    WKUserScript* script = [[WKUserScript alloc] initWithSource:gated
                                                  injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                               forMainFrameOnly:YES];
    [config.userContentController addUserScript:script];
  }

  // auto_resize=true: logical points (main view). auto_resize=false: physical pixels (surface, JS × DPR).
  NSRect frame;
  if (auto_resize) {
    frame = NSMakeRect(x, y, width, height);
  } else {
    CGFloat dpr = window_state->window.backingScaleFactor ?: 1.0;
    frame = NSMakeRect(x / dpr, y / dpr, width / dpr, height / dpr);
  }
  BunitePassthroughContainer* container = [[BunitePassthroughContainer alloc] initWithFrame:frame];
  container.wantsLayer = YES;  // enable CAShapeLayer mask (set_mask_region)

  WKWebView* wv = [[WKWebView alloc] initWithFrame:container.bounds configuration:config];
  wv.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  // DevTools off by default — bunite_view_open_devtools toggles via setInspectable.
  if (@available(macOS 13.3, *)) wv.inspectable = NO;

  static __strong BuniteNavigationDelegate* navDelegate = [[BuniteNavigationDelegate alloc] init];
  static __strong BuniteUIDelegate* uiDelegate = [[BuniteUIDelegate alloc] init];
  wv.navigationDelegate = navDelegate;
  wv.UIDelegate = uiDelegate;
  [wv addObserver:[BuniteTitleObserver shared] forKeyPath:@"title" options:NSKeyValueObservingOptionNew context:NULL];

  [container addSubview:wv];
  [window_state->window.contentView addSubview:container];
  if (auto_resize) container.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    auto& st = g_runtime.views[view_id];
    st.container = container;
    st.webview = wv;
    st.nav_delegate = navDelegate;
    st.ui_delegate = uiDelegate;
    st.window_id = window_id;
    st.appres_root = appres_root.length > 0 ? appres_root.UTF8String : "";
    st.preload_script = preload.length > 0 ? preload.UTF8String : "";
    st.navigation_rules = parseNavigationRulesJson(navigation_rules_json);
  }
  [webviewIdTable() setObject:@(view_id) forKey:wv];

  if (url.length > 0) {
    NSURL* u = [NSURL URLWithString:url];
    if (u) [wv loadRequest:[NSURLRequest requestWithURL:u]];
  } else if (html.length > 0) {
    [wv loadHTMLString:html baseURL:nil];
  }

  emitWebviewEvent(view_id, "view-ready", "");
  return true;
}

void removeView(uint32_t view_id) {
  __strong WKWebView* wv = nil;
  __strong NSView* container = nil;
  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    auto it = g_runtime.views.find(view_id);
    if (it == g_runtime.views.end()) return;
    wv = it->second.webview;
    container = it->second.container;
    g_runtime.views.erase(it);
  }
  bunite::WebviewContentStorage::instance().remove(view_id);

  // WebKit may not call stopURLSchemeTask during teardown — fail in-flight tasks here.
  if (g_runtime.pending_route_tasks.count > 0) {
    NSMutableArray<NSNumber*>* keys = [NSMutableArray array];
    NSMutableArray<id<WKURLSchemeTask>>* victims = [NSMutableArray array];
    for (NSNumber* key in g_runtime.pending_route_tasks) {
      BunitePendingRoute* p = g_runtime.pending_route_tasks[key];
      if (p.viewId == view_id) { [keys addObject:key]; [victims addObject:p.task]; }
    }
    [g_runtime.pending_route_tasks removeObjectsForKeys:keys];
    NSError* err = [NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorCancelled userInfo:nil];
    @try {
      for (id<WKURLSchemeTask> t in victims) [t didFailWithError:err];
    } @catch (NSException* e) {
      // Race: WebKit may stop the task between snapshot and failure — swallow.
    }
  }

  // Deny pending permissions — releases the handler block, unblocks JS waiters.
  NSArray<BunitePendingPermission*>* to_deny = nil;
  if (g_runtime.pending_permissions.count > 0) {
    NSMutableArray<NSNumber*>* keys = [NSMutableArray array];
    NSMutableArray<BunitePendingPermission*>* victims = [NSMutableArray array];
    for (NSNumber* key in g_runtime.pending_permissions) {
      BunitePendingPermission* p = g_runtime.pending_permissions[key];
      if (p.viewId == view_id) { [keys addObject:key]; [victims addObject:p]; }
    }
    [g_runtime.pending_permissions removeObjectsForKeys:keys];
    to_deny = victims;
  }
  if (@available(macOS 12.0, *)) {
    for (BunitePendingPermission* p in to_deny) p.handler(WKPermissionDecisionDeny);
  }

  if (wv) {
    @try { [wv removeObserver:[BuniteTitleObserver shared] forKeyPath:@"title"]; }
    @catch (NSException*) { /* never registered (race) */ }
    [webviewIdTable() removeObjectForKey:wv];
  }
  if (container) [container removeFromSuperview];
}

} // namespace bunite_mac
