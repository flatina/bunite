// appres://app.internal/* WKURLSchemeHandler.
// Precedence: stored HTML > dynamic route > static file under appres_root.

#import "bunite_mac_internal.h"

#include "webview_storage.h"

#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

using bunite_mac::g_runtime;
using bunite_mac::findView;
using bunite_mac::viewIdForWebView;

namespace {

NSString* mimeFor(NSString* path) {
  NSString* ext = path.pathExtension.lowercaseString;
  if (ext.length == 0) return @"text/html";
  // UTType lacks application/wasm on older macOS — hard-map.
  if ([ext isEqualToString:@"wasm"]) return @"application/wasm";
  UTType* type = [UTType typeWithFilenameExtension:ext];
  return type.preferredMIMEType ?: @"application/octet-stream";
}

// Reject unsafe segments early — dynamic-route handlers (JS) must never see `..` paths.
BOOL hasUnsafeSegment(NSString* rel) {
  for (NSString* seg in [rel componentsSeparatedByString:@"/"]) {
    if (seg.length == 0) continue;
    if ([seg isEqualToString:@"."]) return YES;
    if ([seg isEqualToString:@".."]) return YES;
    if ([seg containsString:@"\\"]) return YES;
    if ([seg containsString:@"\0"]) return YES;
  }
  return NO;
}

BOOL pathUnderRoot(NSString* root, NSString* path) {
  NSString* resolved = [[path stringByStandardizingPath] stringByResolvingSymlinksInPath];
  return [resolved hasPrefix:[root stringByAppendingString:@"/"]] || [resolved isEqualToString:root];
}

NSString* resolveUnderRoot(NSString* root, NSString* rel) {
  NSString* candidate = [[[root stringByAppendingPathComponent:rel]
                          stringByStandardizingPath] stringByResolvingSymlinksInPath];
  return pathUnderRoot(root, candidate) ? candidate : nil;
}

// Re-validate after appending index.html/.html — a symlink in the suffix could escape root.
NSString* withFallback(NSString* root, NSString* path) {
  NSFileManager* fm = NSFileManager.defaultManager;
  BOOL isDir = NO;
  if ([fm fileExistsAtPath:path isDirectory:&isDir]) {
    if (!isDir) return path;
    NSString* idx = [path stringByAppendingPathComponent:@"index.html"];
    if ([fm fileExistsAtPath:idx] && pathUnderRoot(root, idx)) return idx;
  }
  NSString* withExt = [path stringByAppendingPathExtension:@"html"];
  if ([fm fileExistsAtPath:withExt] && pathUnderRoot(root, withExt)) return withExt;
  return nil;
}

} // namespace

@interface BuniteAppresSchemeHandler : NSObject <WKURLSchemeHandler>
@end

@implementation BuniteAppresSchemeHandler

- (void)webView:(WKWebView*)wv startURLSchemeTask:(id<WKURLSchemeTask>)task {
  uint32_t view_id = viewIdForWebView(wv);
  NSURL* url = task.request.URL;

  if (![url.host isEqualToString:@"app.internal"]) {
    [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorBadURL userInfo:nil]];
    return;
  }

  NSString* rel = url.path;
  while ([rel hasPrefix:@"/"]) rel = [rel substringFromIndex:1];
  while ([rel hasSuffix:@"/"]) rel = [rel substringToIndex:rel.length - 1];
  if (rel.length == 0) rel = @"index.html";

  if (hasUnsafeSegment(rel)) {
    [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorBadURL userInfo:nil]];
    return;
  }

  std::string rel_utf8 = rel.UTF8String;

  // `has` (not `.empty()`) so an explicit load_html("") still intercepts.
  if ([rel isEqualToString:@"internal/index.html"] &&
      bunite::WebviewContentStorage::instance().has(view_id)) {
    std::string stored = bunite::WebviewContentStorage::instance().get(view_id);
    NSData* data = [NSData dataWithBytes:stored.data() length:stored.size()];
    NSURLResponse* response = [[NSURLResponse alloc]
      initWithURL:url MIMEType:@"text/html"
      expectedContentLength:data.length textEncodingName:nil];
    [task didReceiveResponse:response];
    [task didReceiveData:data];
    [task didFinish];
    return;
  }

  // 2. Dynamic route — async; JS replies via bunite_complete_route_request.
  if (bunite::AppResRouteStorage::instance().hasRoute(rel_utf8)) {
    if (!g_runtime.pending_route_tasks) {
      g_runtime.pending_route_tasks = [NSMutableDictionary dictionary];
    }
    uint32_t request_id = g_runtime.next_route_request_id++;
    BunitePendingRoute* entry = [[BunitePendingRoute alloc] init];
    entry.viewId = view_id;
    entry.task = task;
    g_runtime.pending_route_tasks[@(request_id)] = entry;
    std::string payload = "{\"requestId\":" + std::to_string(request_id) +
      ",\"path\":\"" + bunite_mac::escapeJsonString(rel_utf8) + "\"}";
    bunite_mac::emitWebviewEvent(view_id, "route-request", payload);
    return;
  }

  // 3. Static file under appres_root.
  bunite_mac::ViewState* state = findView(view_id);
  if (!state || state->appres_root.empty()) {
    [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorFileDoesNotExist userInfo:nil]];
    return;
  }
  NSString* rawRoot = [NSString stringWithUTF8String:state->appres_root.c_str()] ?: @"";
  NSString* root = [[rawRoot stringByStandardizingPath] stringByResolvingSymlinksInPath];
  NSString* candidate = resolveUnderRoot(root, rel);
  NSString* resolved = candidate ? withFallback(root, candidate) : nil;
  NSData* data = resolved ? [NSData dataWithContentsOfFile:resolved] : nil;
  if (!data) {
    [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorFileDoesNotExist userInfo:nil]];
    return;
  }
  NSURLResponse* response = [[NSURLResponse alloc]
    initWithURL:url MIMEType:mimeFor(resolved)
    expectedContentLength:data.length textEncodingName:nil];
  [task didReceiveResponse:response];
  [task didReceiveData:data];
  [task didFinish];
}

- (void)webView:(WKWebView*)wv stopURLSchemeTask:(id<WKURLSchemeTask>)task {
  (void)wv;
  // Drop pending entry — complete_route_request on a stopped task raises NSInternalInconsistencyException.
  if (g_runtime.pending_route_tasks.count == 0) return;
  NSNumber* hit = nil;
  for (NSNumber* key in g_runtime.pending_route_tasks) {
    if (g_runtime.pending_route_tasks[key].task == task) { hit = key; break; }
  }
  if (hit) [g_runtime.pending_route_tasks removeObjectForKey:hit];
}

@end

namespace bunite_mac {

id<WKURLSchemeHandler> sharedAppresSchemeHandler() {
  static __strong BuniteAppresSchemeHandler* handler = [[BuniteAppresSchemeHandler alloc] init];
  return handler;
}

} // namespace bunite_mac
