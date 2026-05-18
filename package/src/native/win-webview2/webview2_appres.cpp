#include "webview2_internal.h"

#include <algorithm>
#include <shlwapi.h>
#pragma comment(lib, "shlwapi.lib")

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Make;

namespace bunite_webview2 {

void configureSchemes(ICoreWebView2EnvironmentOptions* base_opts) {
  ComPtr<ICoreWebView2EnvironmentOptions4> opts4;
  if (!base_opts) return;
  if (FAILED(base_opts->QueryInterface(IID_PPV_ARGS(&opts4))) || !opts4) {
    BUNITE_WARN("webview2: ICoreWebView2EnvironmentOptions4 unavailable — appres scheme will fall back to WebResourceRequested-only");
    return;
  }

  auto reg = Make<CoreWebView2CustomSchemeRegistration>(L"appres");
  reg->put_TreatAsSecure(TRUE);
  reg->put_HasAuthorityComponent(TRUE);
  // Allow injected preload + appres origin to issue cross-origin fetches.
  const WCHAR* allowed[] = { L"*" };
  reg->SetAllowedOrigins(1, allowed);

  ICoreWebView2CustomSchemeRegistration* regs[] = { reg.Get() };
  if (FAILED(opts4->SetCustomSchemeRegistrations(1, regs))) {
    BUNITE_WARN("webview2: SetCustomSchemeRegistrations failed");
  }
}

// Builds a WebResourceResponse from in-memory bytes.
static ComPtr<ICoreWebView2WebResourceResponse> makeResponse(
    const std::string& body, const std::string& mime, int status, const std::wstring& reason) {
  ComPtr<ICoreWebView2WebResourceResponse> resp;
  if (!g_runtime.env) return resp;

  ComPtr<IStream> stream;
  if (!body.empty()) {
    stream.Attach(SHCreateMemStream(reinterpret_cast<const BYTE*>(body.data()),
                                    static_cast<UINT>(body.size())));
  }

  // Restrict to the bunite scheme; the preload-injected runtime expects same-origin
  // semantics here, and CEF's scheme handler is same-origin by default. Wider
  // CORS surface is opt-in via the (future) scheme registration policy.
  std::wstring headers = L"Content-Type: " + utf8ToWide(mime) + L"\r\n";
  headers += L"Access-Control-Allow-Origin: appres://app.internal\r\n";
  headers += L"Cache-Control: no-store\r\n";

  g_runtime.env->CreateWebResourceResponse(stream.Get(), status, reason.c_str(),
                                            headers.c_str(), &resp);
  return resp;
}

static std::string fileSlurp(const std::filesystem::path& p) {
  std::ifstream f(p, std::ios::binary);
  if (!f) return {};
  std::string out((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  return out;
}

// Returns true if a static file under the view's appres_root could be served.
static bool tryServeStatic(ViewHost* view, const std::string& path,
                           ICoreWebView2WebResourceRequestedEventArgs* args) {
  if (!view || view->appres_root.empty()) return false;
  std::error_code ec;
  std::filesystem::path root = std::filesystem::weakly_canonical(
      std::filesystem::path(utf8ToWide(view->appres_root)), ec);
  if (ec) return false;

  std::string rel = path;
  if (!rel.empty() && rel[0] == '/') rel.erase(0, 1);
  std::filesystem::path full = root;
  if (!rel.empty()) full /= utf8ToWide(rel);
  if (!full.has_extension()) {
    auto with_html = full;
    with_html.replace_extension(".html");
    if (std::filesystem::exists(with_html, ec)) full = with_html;
  }
  full = std::filesystem::weakly_canonical(full, ec);
  if (ec) return false;

  // Containment check — resolved path must live under appres_root.
  auto rel_check = std::filesystem::relative(full, root, ec);
  if (ec || rel_check.empty() || rel_check.native()[0] == L'.') return false;

  if (!std::filesystem::is_regular_file(full, ec)) return false;
  std::string body = fileSlurp(full);
  std::string mime = getMimeType(full);
  auto resp = makeResponse(body, mime, 200, L"OK");
  if (!resp) return false;
  args->put_Response(resp.Get());
  return true;
}

void attachAppResFilter(ViewHost* view) {
  if (!view || !view->webview) return;
  auto lifetime = g_runtime.lifetime;

  view->webview->AddWebResourceRequestedFilter(L"appres://*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);

  EventRegistrationToken tok;
  view->webview->add_WebResourceRequested(
      Callback<ICoreWebView2WebResourceRequestedEventHandler>(
          [lifetime, view_id = view->id](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
            if (!lifetime || !lifetime->alive.load()) return S_OK;
            ViewHost* v = getView(view_id);
            if (!v) return S_OK;

            ComPtr<ICoreWebView2WebResourceRequest> req;
            args->get_Request(&req);

            LPWSTR uri_raw = nullptr;
            req->get_Uri(&uri_raw);
            std::string url = wideToUtf8(uri_raw);
            if (uri_raw) CoTaskMemFree(uri_raw);

            std::string path = normalizeAppResPath(url);
            if (path.empty()) return S_OK;

            if (tryServeStatic(v, path, args)) return S_OK;

            bool route_match = false;
            {
              std::lock_guard<std::mutex> g(g_runtime.route_mutex);
              for (auto& p : g_runtime.registered_routes) {
                if (globMatchCaseInsensitive(p, path)) { route_match = true; break; }
              }
            }
            if (!route_match) {
              auto resp = makeResponse("", "text/plain", 404, L"Not Found");
              if (resp) args->put_Response(resp.Get());
              return S_OK;
            }

            ComPtr<ICoreWebView2Deferral> deferral;
            args->GetDeferral(&deferral);

            uint32_t req_id;
            {
              std::lock_guard<std::mutex> g(g_runtime.route_mutex);
              req_id = g_runtime.next_route_request_id++;
              PendingRouteRequest p;
              p.view_id = v->id;
              p.uri = utf8ToWide(url);
              p.path = path;
              p.args = args;
              p.deferral = deferral;
              g_runtime.pending_routes[req_id] = std::move(p);
            }

            std::string payload = "{\"requestId\":" + std::to_string(req_id) +
                                  ",\"path\":\"" + escapeJsonString(path) +
                                  "\",\"url\":\"" + escapeJsonString(url) + "\"}";
            emitWebviewEvent(v->id, "route-request", payload);
            return S_OK;
          }).Get(),
      &tok);
}

void registerAppResRoute(const char* path) {
  if (!path) return;
  std::lock_guard<std::mutex> g(g_runtime.route_mutex);
  g_runtime.registered_routes.emplace_back(path);
}

void unregisterAppResRoute(const char* path) {
  if (!path) return;
  std::lock_guard<std::mutex> g(g_runtime.route_mutex);
  auto& v = g_runtime.registered_routes;
  v.erase(std::remove(v.begin(), v.end(), std::string(path)), v.end());
}

void completeRouteRequest(uint32_t request_id, const char* html) {
  PendingRouteRequest p;
  {
    std::lock_guard<std::mutex> g(g_runtime.route_mutex);
    auto it = g_runtime.pending_routes.find(request_id);
    if (it == g_runtime.pending_routes.end()) return;
    p = std::move(it->second);
    g_runtime.pending_routes.erase(it);
  }

  postUiTask([p = std::move(p), body = std::string(html ? html : "")]() mutable {
    if (!p.args || !p.deferral) return;
    auto resp = makeResponse(body, "text/html; charset=utf-8", 200, L"OK");
    if (resp) p.args->put_Response(resp.Get());
    p.deferral->Complete();
  });
}

void cancelAllRouteRequests() {
  std::map<uint32_t, PendingRouteRequest> drained;
  {
    std::lock_guard<std::mutex> g(g_runtime.route_mutex);
    drained.swap(g_runtime.pending_routes);
  }
  for (auto& [_, p] : drained) {
    if (p.args) {
      auto resp = makeResponse("", "text/plain", 503, L"Shutting Down");
      if (resp) p.args->put_Response(resp.Get());
    }
    if (p.deferral) p.deferral->Complete();
  }
}

}  // namespace bunite_webview2
