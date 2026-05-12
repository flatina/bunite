#include "bunite_linux_internal.h"
#include "webview_storage.h"

#include <gio/gio.h>

#include <atomic>
#include <filesystem>
#include <optional>
#include <string>

namespace bunite_linux {

namespace {

std::atomic<bool> g_scheme_registered{false};

void fail(WebKitURISchemeRequest* req, GIOErrorEnum code, const char* msg) {
  GError* err = g_error_new_literal(G_IO_ERROR, code, msg);
  webkit_uri_scheme_request_finish_error(req, err);
  g_error_free(err);
}

// Reject escapes via symlinks or `..`.
std::optional<std::filesystem::path> resolveUnderRoot(
  const std::filesystem::path& root, const std::string& rel
) {
  std::error_code ec;
  auto resolved = std::filesystem::weakly_canonical(root / rel, ec);
  if (ec) return std::nullopt;
  auto root_str = root.string();
  auto resolved_str = resolved.string();
  if (resolved_str == root_str) return resolved;
  if (resolved_str.rfind(root_str + "/", 0) != 0) return std::nullopt;
  return resolved;
}

// dir → /index.html; missing → +".html". Each fallback re-validated under root.
std::optional<std::filesystem::path> withFallback(
  const std::filesystem::path& root, const std::filesystem::path& candidate
) {
  std::error_code ec;
  if (std::filesystem::is_regular_file(candidate, ec)) return candidate;
  if (std::filesystem::is_directory(candidate, ec)) {
    auto rel = std::filesystem::relative(candidate, root).string();
    auto idx = resolveUnderRoot(root, rel + "/index.html");
    if (idx && std::filesystem::is_regular_file(*idx, ec)) return idx;
  }
  auto rel = std::filesystem::relative(candidate, root).string();
  auto withExt = resolveUnderRoot(root, rel + ".html");
  if (withExt && std::filesystem::is_regular_file(*withExt, ec)) return withExt;
  return std::nullopt;
}

bool hasUnsafeSegment(const std::string& path) {
  size_t pos = 0;
  while (pos <= path.size()) {
    size_t next = path.find('/', pos);
    std::string seg = path.substr(pos, next == std::string::npos ? std::string::npos : next - pos);
    if (seg == "." || seg == "..") return true;
    if (seg.find('\\') != std::string::npos) return true;
    if (next == std::string::npos) break;
    pos = next + 1;
  }
  return false;
}

std::string mimeFor(const std::filesystem::path& path) {
  gchar* content_type = g_content_type_guess(path.string().c_str(), nullptr, 0, nullptr);
  if (!content_type) return "application/octet-stream";
  gchar* mime = g_content_type_get_mime_type(content_type);
  std::string out = mime ? mime : "application/octet-stream";
  g_free(content_type);
  g_free(mime);
  return out;
}

void on_appres_request(WebKitURISchemeRequest* req, gpointer user_data) {
  (void)user_data;
  WebKitWebView* wv = webkit_uri_scheme_request_get_web_view(req);
  const uint32_t view_id = viewIdForWebView(wv);
  const char* uri_c = webkit_uri_scheme_request_get_uri(req);
  if (!uri_c) { fail(req, G_IO_ERROR_INVALID_FILENAME, "Empty URI"); return; }

  std::string uri = uri_c;
  auto prefix_end = uri.find("://");
  if (prefix_end == std::string::npos) {
    fail(req, G_IO_ERROR_INVALID_FILENAME, "Invalid URI"); return;
  }
  auto rest = uri.substr(prefix_end + 3);
  auto first_slash = rest.find('/');
  std::string host = (first_slash == std::string::npos) ? rest : rest.substr(0, first_slash);
  std::string path = (first_slash == std::string::npos) ? "" : rest.substr(first_slash + 1);

  if (host != "app.internal") {
    fail(req, G_IO_ERROR_INVALID_ARGUMENT, "Invalid appres host"); return;
  }

  for (char c : {'?', '#'}) {
    auto pos = path.find(c);
    if (pos != std::string::npos) path = path.substr(0, pos);
  }
  if (gchar* decoded = g_uri_unescape_string(path.c_str(), nullptr)) {
    path = decoded;
    g_free(decoded);
  } else {
    fail(req, G_IO_ERROR_INVALID_FILENAME, "Invalid percent-encoding"); return;
  }
  if (path.find('\0') != std::string::npos) {
    fail(req, G_IO_ERROR_INVALID_FILENAME, "NUL in path"); return;
  }
  while (!path.empty() && path.back() == '/') path.pop_back();
  if (path.empty()) path = "index.html";

  if (hasUnsafeSegment(path)) {
    fail(req, G_IO_ERROR_INVALID_FILENAME, "Unsafe path segment"); return;
  }

  if (path == "internal/index.html" && bunite::WebviewContentStorage::instance().has(view_id)) {
    std::string stored = bunite::WebviewContentStorage::instance().get(view_id);
    GInputStream* stream = g_memory_input_stream_new_from_data(
      g_memdup2(stored.data(), stored.size()), (gssize)stored.size(), g_free);
    webkit_uri_scheme_request_finish(req, stream, (gint64)stored.size(), "text/html");
    g_object_unref(stream);
    return;
  }

  if (bunite::AppResRouteStorage::instance().hasRoute(path)) {
    uint32_t request_id = g_runtime.next_route_request_id++;
    g_object_ref(req);
    g_runtime.pending_route_tasks[request_id] = { view_id, req };
    std::string payload = "{\"requestId\":" + std::to_string(request_id) +
      ",\"path\":\"" + escapeJsonString(path) + "\"}";
    emitWebviewEvent(view_id, "route-request", payload);
    return;
  }

  auto* state = findView(view_id);
  if (!state || state->appres_root.empty()) {
    fail(req, G_IO_ERROR_NOT_FOUND, "appres root not configured"); return;
  }

  std::error_code ec;
  auto root = std::filesystem::weakly_canonical(std::filesystem::path(state->appres_root), ec);
  if (ec) { fail(req, G_IO_ERROR_NOT_FOUND, "Bad appres root"); return; }

  auto candidate = resolveUnderRoot(root, path);
  if (!candidate) { fail(req, G_IO_ERROR_NOT_FOUND, "Path escapes root"); return; }
  auto resolved = withFallback(root, *candidate);
  if (!resolved) { fail(req, G_IO_ERROR_NOT_FOUND, "File not found"); return; }

  gchar* contents = nullptr;
  gsize length = 0;
  GError* err = nullptr;
  if (!g_file_get_contents(resolved->string().c_str(), &contents, &length, &err)) {
    webkit_uri_scheme_request_finish_error(req, err);
    g_error_free(err);
    return;
  }

  GInputStream* stream = g_memory_input_stream_new_from_data(contents, (gssize)length, g_free);
  std::string mime = mimeFor(*resolved);
  webkit_uri_scheme_request_finish(req, stream, (gint64)length, mime.c_str());
  g_object_unref(stream);
}

}  // namespace

void registerAppresScheme(WebKitWebContext* ctx) {
  if (g_scheme_registered.exchange(true)) return;
  webkit_web_context_register_uri_scheme(ctx, "appres", on_appres_request, nullptr, nullptr);
}

}  // namespace bunite_linux
