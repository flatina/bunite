#pragma once

#include <cstdint>

typedef void (*BuniteWebviewEventHandler)(uint32_t view_id, const char* event_name, const char* payload);
typedef void (*BuniteWindowEventHandler)(uint32_t window_id, const char* event_name, const char* payload);
