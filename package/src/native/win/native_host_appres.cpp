#include "native_host_internal.h"

namespace {

class BuniteSchemeHandler : public CefResourceHandler {
public:
  explicit BuniteSchemeHandler(uint32_t view_id)
    : view_id_(view_id) {}

  bool Open(CefRefPtr<CefRequest> request, bool& handle_request, CefRefPtr<CefCallback> callback) override {
    CEF_REQUIRE_IO_THREAD();
    handle_request = true;

    const std::string url = request ? request->GetURL().ToString() : "";

    CefURLParts url_parts;
    if (CefParseURL(url, url_parts)) {
      const std::string host = CefString(&url_parts.host).ToString();
      if (host != "app.internal") {
        status_code_ = 403;
        status_text_ = "Forbidden";
        mime_type_ = "text/plain";
        data_ = "Invalid appres host: " + host;
        return true;
      }
    }

    const std::string normalized_path = bunite_win::normalizeAppResPath(url);

    // Dynamic route: handler lives on the Bun side, request is async
    if (bunite::AppResRouteStorage::instance().hasRoute(normalized_path)) {
      handle_request = false; // async - we'll call callback->Continue() later
      uint32_t request_id;
      {
        std::lock_guard<std::mutex> lock(g_runtime.route_mutex);
        request_id = g_runtime.next_route_request_id++;
        g_runtime.pending_routes[request_id] = { normalized_path, callback, request };
      }
      pending_route_request_id_ = request_id;
      bunite_win::emitWebviewEvent(
        view_id_,
        "route-request",
        "{\"requestId\":" + std::to_string(request_id) +
          ",\"path\":\"" + bunite_win::escapeJsonString(normalized_path) + "\"}"
      );
      return true;
    }

    std::string mime_type;
    const auto content = bunite_win::loadAppResResource(view_id_, url, mime_type);
    if (!content) {
      const std::string appres_root = bunite_win::getAppResRootForView(view_id_);
      BUNITE_WARN("appres:// resource not found (view=%u, url=%s, normalized=%s, root=%s)",
        view_id_, url.c_str(), normalized_path.c_str(), appres_root.c_str());
      status_code_ = 404;
      status_text_ = "Not Found";
      mime_type_ = "text/plain";
      data_ =
        "bunite could not resolve the requested appres:// resource.\n"
        "url: " + url + "\n" +
        "normalized: " + normalized_path;
      return true;
    }

    status_code_ = 200;
    status_text_ = "OK";
    mime_type_ = mime_type;
    data_ = *content;
    return true;
  }

  void GetResponseHeaders(CefRefPtr<CefResponse> response, int64_t& response_length, CefString&) override {
    if (pending_route_request_id_ != 0) {
      auto content = bunite::AppResRouteStorage::instance().takeResponse(pending_route_request_id_);
      pending_route_request_id_ = 0;
      if (content) {
        status_code_ = 200;
        status_text_ = "OK";
        mime_type_ = "text/html";
        data_ = std::move(*content);
      } else {
        status_code_ = 500;
        status_text_ = "Handler Error";
        mime_type_ = "text/plain";
        data_ = "Route handler did not produce a response.";
      }
    }
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
  uint32_t pending_route_request_id_ = 0;
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

} // namespace

namespace bunite_win {

std::string normalizeAppResPath(const std::string& url) {
  CefURLParts parts;
  if (CefParseURL(url, parts)) {
    std::string path = CefString(&parts.path).ToString();
    while (!path.empty() && (path.front() == '/' || path.front() == '\\')) {
      path.erase(path.begin());
    }
    while (!path.empty() && (path.back() == '/' || path.back() == '\\')) {
      path.pop_back();
    }
    return path.empty() ? "index.html" : path;
  }

  std::string path = url;
  if (path.rfind("appres://", 0) == 0) {
    path = path.substr(9); // "appres://" is 9 chars
    const auto slash_pos = path.find('/');
    path = (slash_pos != std::string::npos) ? path.substr(slash_pos + 1) : "";
  }

  const auto query_pos = path.find_first_of("?#");
  if (query_pos != std::string::npos) {
    path = path.substr(0, query_pos);
  }

  while (!path.empty() && (path.back() == '/' || path.back() == '\\')) {
    path.pop_back();
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

std::string getAppResRootForView(uint32_t view_id) {
  std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
  const auto it = g_runtime.views_by_id.find(view_id);
  if (it == g_runtime.views_by_id.end() || !it->second) {
    return {};
  }
  return it->second->appres_root;
}

std::optional<std::string> loadAppResResource(uint32_t view_id, const std::string& url, std::string& mime_type) {
  const std::string appres_root = getAppResRootForView(view_id);

  const std::string path = normalizeAppResPath(url);
  if (path == "internal/index.html") {
    mime_type = "text/html";
    return bunite::WebviewContentStorage::instance().get(view_id);
  }

  if (appres_root.empty()) {
    return std::nullopt;
  }

  if (!std::filesystem::exists(appres_root)) {
    return std::nullopt;
  }

  const std::filesystem::path root = std::filesystem::weakly_canonical(std::filesystem::path(appres_root));
  std::filesystem::path candidate = std::filesystem::weakly_canonical(root / std::filesystem::path(path));
  if (std::filesystem::exists(candidate) && std::filesystem::is_directory(candidate)) {
    candidate = std::filesystem::weakly_canonical(candidate / "index.html");
  } else if (!std::filesystem::exists(candidate) && !candidate.has_extension()) {
    candidate = std::filesystem::weakly_canonical(std::filesystem::path(candidate.native() + L".html"));
  }
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

void registerAppResSchemeHandlers() {
  CefRegisterSchemeHandlerFactory("appres", "", new BuniteSchemeHandlerFactory());
}

} // namespace bunite_win
