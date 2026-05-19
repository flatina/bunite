#pragma once

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <atomic>

enum class BuniteLogLevel : int { Debug = 0, Info = 1, Warn = 2, Error = 3, Silent = 4 };

inline std::atomic<BuniteLogLevel> g_bunite_log_level{BuniteLogLevel::Warn};

inline void buniteSetLogLevel(BuniteLogLevel level) {
  g_bunite_log_level.store(level, std::memory_order_relaxed);
}

/** Read BUNITE_LOG_LEVEL env once and apply it. Call early in bunite_init so
 *  init-time logs land before the TS side's setNativeLogLevel arrives. */
inline void buniteApplyEnvLogLevel() {
  const char* v = std::getenv("BUNITE_LOG_LEVEL");
  if (!v || !*v) return;
  if (std::strcmp(v, "debug") == 0) buniteSetLogLevel(BuniteLogLevel::Debug);
  else if (std::strcmp(v, "info") == 0) buniteSetLogLevel(BuniteLogLevel::Info);
  else if (std::strcmp(v, "warn") == 0) buniteSetLogLevel(BuniteLogLevel::Warn);
  else if (std::strcmp(v, "error") == 0) buniteSetLogLevel(BuniteLogLevel::Error);
  else if (std::strcmp(v, "silent") == 0) buniteSetLogLevel(BuniteLogLevel::Silent);
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
