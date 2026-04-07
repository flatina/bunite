#pragma once

#include <algorithm>
#include <cctype>
#include <cstring>
#include <string>

class BuniteResponseFilter : public CefResponseFilter {
public:
  explicit BuniteResponseFilter(std::string script)
    : script_(std::move(script)) {}

  bool InitFilter() override {
    buffer_.clear();
    output_offset_ = 0;
    injected_ = false;
    return true;
  }

  FilterStatus Filter(
    void* data_in,
    size_t data_in_size,
    size_t& data_in_read,
    void* data_out,
    size_t data_out_size,
    size_t& data_out_written
  ) override {
    if (data_in_size > 0) {
      buffer_.append(static_cast<const char*>(data_in), data_in_size);
      data_in_read = data_in_size;
    } else {
      data_in_read = 0;
    }

    if (!injected_) {
      tryInject();
      if (!injected_ && data_in_size == 0 && !script_.empty() && output_offset_ == 0) {
        buffer_.insert(0, "<script>\n" + escapeInlineScript(script_) + "\n</script>\n");
        injected_ = true;
      }
    }

    const size_t remaining = buffer_.size() - output_offset_;
    const size_t copy_size = std::min(remaining, data_out_size);
    if (copy_size > 0) {
      std::memcpy(data_out, buffer_.data() + output_offset_, copy_size);
      output_offset_ += copy_size;
    }
    data_out_written = copy_size;

    if (data_in_size == 0 && output_offset_ >= buffer_.size()) {
      return RESPONSE_FILTER_DONE;
    }
    return RESPONSE_FILTER_NEED_MORE_DATA;
  }

private:
  static std::string lowercase(std::string value) {
    std::transform(
      value.begin(),
      value.end(),
      value.begin(),
      [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); }
    );
    return value;
  }

  static std::string escapeInlineScript(const std::string& script) {
    std::string escaped = script;
    std::string::size_type offset = 0;
    while ((offset = escaped.find("</script", offset)) != std::string::npos) {
      escaped.replace(offset, 8, "<\\/script");
      offset += 9;
    }
    return escaped;
  }

  void tryInject() {
    if (injected_ || script_.empty()) {
      return;
    }

    const std::string lowered = lowercase(buffer_);
    std::string tag = "<script>\n" + escapeInlineScript(script_) + "\n</script>\n";

    auto inject_after = [&](const std::string& token) -> bool {
      const auto start = lowered.find(token);
      if (start == std::string::npos) {
        return false;
      }
      const auto end = buffer_.find('>', start);
      if (end == std::string::npos) {
        return false;
      }
      buffer_.insert(end + 1, tag);
      injected_ = true;
      return true;
    };

    if (inject_after("<head") || inject_after("<html")) {
      return;
    }

    if (buffer_.size() > 1024 && output_offset_ == 0) {
      buffer_.insert(0, tag);
      injected_ = true;
    }
  }

  std::string script_;
  std::string buffer_;
  size_t output_offset_ = 0;
  bool injected_ = false;

  IMPLEMENT_REFCOUNTING(BuniteResponseFilter);
};
