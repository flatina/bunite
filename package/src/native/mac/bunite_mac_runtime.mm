// Process-wide singletons + thread helpers + NSApp lifecycle for the macOS adapter.

#import "bunite_mac_internal.h"

#include <CoreFoundation/CoreFoundation.h>

namespace bunite_mac {

RuntimeState g_runtime;

bool isOnMainThread() {
  return [NSThread isMainThread] == YES;
}

} // namespace bunite_mac
