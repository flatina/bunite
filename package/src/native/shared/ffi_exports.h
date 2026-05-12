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

BUNITE_EXPORT int32_t bunite_abi_version(void);
BUNITE_EXPORT void bunite_set_log_level(int32_t level);
BUNITE_EXPORT bool bunite_init(
	const char* engine_dir,
	bool hide_console,
	bool popup_blocking,
	const char* engine_config_json
);
BUNITE_EXPORT const char* bunite_engine_name(void);
BUNITE_EXPORT const char* bunite_engine_version(void);
BUNITE_EXPORT void bunite_run_loop(void);
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
BUNITE_EXPORT void bunite_view_open_devtools(uint32_t view_id);
BUNITE_EXPORT void bunite_view_close_devtools(uint32_t view_id);
BUNITE_EXPORT void bunite_view_toggle_devtools(uint32_t view_id);
BUNITE_EXPORT void bunite_complete_permission_request(uint32_t request_id, uint32_t state);
#ifdef __cplusplus
}
#endif
