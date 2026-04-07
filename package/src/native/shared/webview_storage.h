#pragma once

#include <cstdint>
#include <map>
#include <mutex>
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

} // namespace bunite
