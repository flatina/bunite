#pragma once

#include <cstdio>
#include <atomic>

enum class BuniteLogLevel : int { Debug = 0, Info = 1, Warn = 2, Error = 3, Silent = 4 };

inline std::atomic<BuniteLogLevel> g_bunite_log_level{BuniteLogLevel::Warn};

inline void buniteSetLogLevel(BuniteLogLevel level) {
  g_bunite_log_level.store(level, std::memory_order_relaxed);
}

inline bool buniteShouldLog(BuniteLogLevel level) {
  return static_cast<int>(level) >= static_cast<int>(g_bunite_log_level.load(std::memory_order_relaxed));
}

#define BUNITE_LOG(level, fmt, ...) \
  do { if (buniteShouldLog(level)) std::fprintf(stderr, "[bunite/native] " fmt "\n", ##__VA_ARGS__); } while (0)

#define BUNITE_DEBUG(fmt, ...) BUNITE_LOG(BuniteLogLevel::Debug, fmt, ##__VA_ARGS__)
#define BUNITE_INFO(fmt, ...)  BUNITE_LOG(BuniteLogLevel::Info, fmt, ##__VA_ARGS__)
#define BUNITE_WARN(fmt, ...)  BUNITE_LOG(BuniteLogLevel::Warn, fmt, ##__VA_ARGS__)
#define BUNITE_ERROR(fmt, ...) BUNITE_LOG(BuniteLogLevel::Error, fmt, ##__VA_ARGS__)
