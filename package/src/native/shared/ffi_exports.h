#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "callbacks.h"

#if defined(_WIN32)
#define BUNITE_EXPORT __declspec(dllexport)
#else
#define BUNITE_EXPORT __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

/** ABI version. Bump on any breaking change to symbol set / signatures.
 *  v7 (2026-05): adds `bunite_view_screenshot` + `bunite_view_capabilities`
 *                + capability bitset (`BuniteCapBit`).
 *  v6 (2026-05): adds input dispatch — `bunite_view_click/type/press/scroll`.
 *  v5 (2026-05): adds `bunite_view_evaluate` + `evaluate-result` webview event. */
BUNITE_EXPORT int32_t bunite_abi_version(void);
BUNITE_EXPORT void bunite_set_log_level(int32_t level);
BUNITE_EXPORT bool bunite_init(
	const char* cef_dir,
	bool hide_console,
	bool popup_blocking,
	const char* engine_config_json
);
BUNITE_EXPORT const char* bunite_engine_name(void);
BUNITE_EXPORT const char* bunite_engine_version(void);
BUNITE_EXPORT void bunite_run_loop(void);
/**
 * Drive one non-blocking iteration of the engine's UI event queue. Required on
 * engines where the UI loop must share the main thread with Bun's libuv loop
 * (macOS WKWebView, Linux WebKitGTK). On engines that own a dedicated UI thread
 * (Windows CEF), this is a no-op.
 */
BUNITE_EXPORT void bunite_pump_once(void);
BUNITE_EXPORT void bunite_quit(void);
BUNITE_EXPORT void bunite_free_cstring(const char* value);
BUNITE_EXPORT void bunite_set_webview_event_handler(BuniteWebviewEventHandler handler);
BUNITE_EXPORT void bunite_set_window_event_handler(BuniteWindowEventHandler handler);

BUNITE_EXPORT bool bunite_window_create(
	uint32_t window_id,
	double x,
	double y,
	double width,
	double height,
	const char* title,
	const char* title_bar_style,
	bool transparent,
	bool hidden,
	bool minimized,
	bool maximized
);
BUNITE_EXPORT void bunite_window_destroy(uint32_t window_id);
BUNITE_EXPORT void bunite_window_reset_close_pending(uint32_t window_id);
BUNITE_EXPORT void bunite_window_show(uint32_t window_id);
BUNITE_EXPORT void bunite_window_close(uint32_t window_id);
BUNITE_EXPORT void bunite_window_set_title(uint32_t window_id, const char* title);
BUNITE_EXPORT void bunite_window_minimize(uint32_t window_id);
BUNITE_EXPORT void bunite_window_unminimize(uint32_t window_id);
BUNITE_EXPORT bool bunite_window_is_minimized(uint32_t window_id);
BUNITE_EXPORT void bunite_window_maximize(uint32_t window_id);
BUNITE_EXPORT void bunite_window_unmaximize(uint32_t window_id);
BUNITE_EXPORT bool bunite_window_is_maximized(uint32_t window_id);
BUNITE_EXPORT void bunite_window_set_frame(
	uint32_t window_id,
	double x,
	double y,
	double width,
	double height
);

BUNITE_EXPORT bool bunite_view_create(
	uint32_t view_id,
	uint32_t window_id,
	const char* url,
	const char* html,
	const char* preload,
	const char* appres_root,
	const char* navigation_rules_json,
	double x,
	double y,
	double width,
	double height,
	bool auto_resize,
	bool sandbox,
	const char* preload_origins_json
);
BUNITE_EXPORT void bunite_view_execute_javascript(uint32_t view_id, const char* script);
/**
 * Evaluate `script` in the view's main frame and report the result via the
 * webview event handler as `evaluate-result` with payload
 *   { requestId, ok: true, value }            // value is the raw JSON string
 *   { requestId, ok: false, code, message }   // code: cross_origin / runtime_error / not_supported / ...
 * Backends that don't implement evaluation report not_supported synchronously.
 */
BUNITE_EXPORT void bunite_view_evaluate(uint32_t view_id, uint32_t request_id, const char* script);
BUNITE_EXPORT void bunite_view_load_url(uint32_t view_id, const char* url);
BUNITE_EXPORT void bunite_view_load_html(uint32_t view_id, const char* html);
BUNITE_EXPORT void bunite_register_appres_route(const char* path);
BUNITE_EXPORT void bunite_unregister_appres_route(const char* path);
BUNITE_EXPORT void bunite_complete_route_request(uint32_t request_id, const char* html);
BUNITE_EXPORT void bunite_view_set_visible(uint32_t view_id, bool visible);
BUNITE_EXPORT void bunite_view_set_input_passthrough(uint32_t view_id, bool passthrough);
BUNITE_EXPORT void bunite_view_set_mask_region(uint32_t view_id, const double* rects, uint32_t count);
BUNITE_EXPORT void bunite_view_bring_to_front(uint32_t view_id);
BUNITE_EXPORT void bunite_view_set_bounds(
	uint32_t view_id,
	double x,
	double y,
	double width,
	double height
);
BUNITE_EXPORT void bunite_view_set_bounds_async(
	uint32_t view_id,
	double x,
	double y,
	double width,
	double height
);
BUNITE_EXPORT void bunite_view_set_anchor(uint32_t view_id, int mode, double inset);
BUNITE_EXPORT void bunite_view_go_back(uint32_t view_id);
BUNITE_EXPORT void bunite_view_reload(uint32_t view_id);
BUNITE_EXPORT void bunite_view_remove(uint32_t view_id);

/* Input dispatch (ABI v6). Coordinates are CSS px, viewport-relative (TS
 * normalizes devicePixelRatio + container offset). Modifier bitmask is
 * Alt=1, Ctrl=2, Meta=4, Shift=8. Backends translate to their native form.
 * No result envelope — `nativeInputTrusted` capability indicates DOM trust. */
BUNITE_EXPORT void bunite_view_click(
	uint32_t view_id,
	double x,
	double y,
	int32_t button,       /* 0=left, 1=middle, 2=right */
	int32_t click_count,  /* >=1 */
	uint32_t modifiers
);
/** Type UTF-8 text. Each codepoint becomes a CHAR / insertText event — no IME composition. */
BUNITE_EXPORT void bunite_view_type(uint32_t view_id, const char* text);
/** Press a key: down + (optional) char + up.
 *  `windows_vk_code` is Win32 VK_* for CEF / WebView2 CDP path.
 *  `mac_key_code` is the Quartz Event Services hardware key code (kVK_*) — separate
 *  from Win VK because DOM `KeyboardEvent.code` is derived from this on WebKit.
 *  `key` / `code` are DOM `KeyboardEvent.key` / `.code` strings, passed to CDP so
 *  the page sees the correct values. `character` is UTF-8 for the CHAR event;
 *  empty = skip char. 0 vk codes = skip the virtual-key down/up. */
BUNITE_EXPORT void bunite_view_press(
	uint32_t view_id,
	int32_t windows_vk_code,
	int32_t mac_key_code,
	const char* key,
	const char* code,
	const char* character,
	uint32_t modifiers
);
/** Scroll at (x, y). dx/dy in CSS px; positive = right/down. */
BUNITE_EXPORT void bunite_view_scroll(
	uint32_t view_id,
	double dx,
	double dy,
	double x,
	double y,
	uint32_t modifiers
);

/** Per-view automation capability bitset. Each backend returns the bits it
 *  actually supports — TS layer decodes to `SurfaceCapabilities` object.
 *  Bits are locked at ABI v6; append-only. */
enum BuniteCapBit {
	BUNITE_CAP_EVALUATE             = 1u << 0,
	BUNITE_CAP_CROSS_ORIGIN_EVAL    = 1u << 1,
	BUNITE_CAP_TITLE_CHANGED        = 1u << 2,
	BUNITE_CAP_NATIVE_INPUT_TRUSTED = 1u << 3,
	BUNITE_CAP_CLICK                = 1u << 4,
	BUNITE_CAP_TYPE                 = 1u << 5,
	BUNITE_CAP_PRESS                = 1u << 6,
	BUNITE_CAP_SCROLL               = 1u << 7,
	BUNITE_CAP_SCREENSHOT           = 1u << 8,
	BUNITE_CAP_FORMAT_PNG           = 1u << 9,
	BUNITE_CAP_FORMAT_JPEG          = 1u << 10,
};
BUNITE_EXPORT uint32_t bunite_view_capabilities(uint32_t view_id);

/** Capture the visible viewport as a PNG/JPEG image. Async — result reported
 *  via the webview event handler as `screenshot-result` with payload
 *    { requestId, ok: true, format, mime, dataBase64 }
 *    { requestId, ok: false, code, message }
 *  Error codes: `not_supported`, `runtime_error`, `timeout`, `black_frame` (CEF
 *  compositor surface unreachable). `quality` is 0–100 for JPEG only — ignored
 *  for PNG, and ignored entirely on WebView2 (`CapturePreview` has no quality
 *  parameter; output uses Edge's default ~80). `dataBase64` is base64-encoded
 *  image bytes; TS layer decodes. */
BUNITE_EXPORT void bunite_view_screenshot(
	uint32_t view_id,
	uint32_t request_id,
	const char* format,
	int32_t quality
);

BUNITE_EXPORT void bunite_view_open_devtools(uint32_t view_id);
BUNITE_EXPORT void bunite_view_close_devtools(uint32_t view_id);
BUNITE_EXPORT void bunite_view_toggle_devtools(uint32_t view_id);
BUNITE_EXPORT void bunite_complete_permission_request(uint32_t request_id, uint32_t state);
#ifdef __cplusplus
}
#endif
