#pragma once

#include <cstdint>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <string>

namespace bunite {

class WebviewContentStorage {
public:
  static WebviewContentStorage& instance() {
    static WebviewContentStorage storage;
    return storage;
  }

  void set(uint32_t webview_id, std::string content) {
    std::lock_guard<std::mutex> lock(mutex_);
    content_[webview_id] = std::move(content);
  }

  std::string get(uint32_t webview_id) const {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = content_.find(webview_id);
    return it == content_.end() ? std::string{} : it->second;
  }

  void remove(uint32_t webview_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    content_.erase(webview_id);
  }

private:
  WebviewContentStorage() = default;

  mutable std::mutex mutex_;
  std::map<uint32_t, std::string> content_;
};

// Tracks which appres:// paths have registered dynamic handlers on the Bun side.
// The actual handler function lives in JS; this only stores the set of registered paths
// and completed route responses.
class AppResRouteStorage {
public:
  static AppResRouteStorage& instance() {
    static AppResRouteStorage storage;
    return storage;
  }

  void registerRoute(const std::string& path) {
    std::lock_guard<std::mutex> lock(mutex_);
    registered_.insert(path);
  }

  void unregisterRoute(const std::string& path) {
    std::lock_guard<std::mutex> lock(mutex_);
    registered_.erase(path);
  }

  bool hasRoute(const std::string& path) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return registered_.count(path) > 0;
  }

  void setResponse(uint32_t request_id, std::string content) {
    std::lock_guard<std::mutex> lock(mutex_);
    responses_[request_id] = std::move(content);
  }

  std::optional<std::string> takeResponse(uint32_t request_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = responses_.find(request_id);
    if (it == responses_.end()) return std::nullopt;
    auto result = std::move(it->second);
    responses_.erase(it);
    return result;
  }

private:
  AppResRouteStorage() = default;

  mutable std::mutex mutex_;
  std::set<std::string> registered_;
  std::map<uint32_t, std::string> responses_;
};

} // namespace bunite
