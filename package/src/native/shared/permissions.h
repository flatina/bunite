#pragma once

#include <stdint.h>

// Engine-agnostic permission bitmask. Adapters translate to native types.

#define BUNITE_PERMISSION_MICROPHONE      ((uint32_t)(1u << 0))
#define BUNITE_PERMISSION_CAMERA          ((uint32_t)(1u << 1))
#define BUNITE_PERMISSION_GEOLOCATION     ((uint32_t)(1u << 2))
#define BUNITE_PERMISSION_NOTIFICATIONS   ((uint32_t)(1u << 3))
#define BUNITE_PERMISSION_CLIPBOARD       ((uint32_t)(1u << 4))
#define BUNITE_PERMISSION_SCREEN_CAPTURE  ((uint32_t)(1u << 5))
#define BUNITE_PERMISSION_POINTER_LOCK    ((uint32_t)(1u << 6))
#define BUNITE_PERMISSION_MIDI_SYSEX      ((uint32_t)(1u << 7))
