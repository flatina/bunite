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

BUNITE_EXPORT bool bunite_init(const char* process_helper_path, const char* cef_dir, bool hide_console);
BUNITE_EXPORT void bunite_run_loop(void);
BUNITE_EXPORT void bunite_quit(void);
BUNITE_EXPORT void bunite_free_cstring(const char* value);
BUNITE_EXPORT void bunite_set_webview_event_handler(BuniteWebviewEventHandler handler);
BUNITE_EXPORT void bunite_set_window_event_handler(BuniteWindowEventHandler handler);

BUNITE_EXPORT void* bunite_window_create(
	uint32_t window_id,
	double x,
	double y,
	double width,
	double height,
	const char* title,
	const char* title_bar_style,
	bool transparent,
	bool hidden
);
BUNITE_EXPORT void bunite_window_show(void* window_ptr);
BUNITE_EXPORT void bunite_window_close(void* window_ptr);
BUNITE_EXPORT void bunite_window_set_title(void* window_ptr, const char* title);
BUNITE_EXPORT void bunite_window_set_frame(
	void* window_ptr,
	double x,
	double y,
	double width,
	double height
);

BUNITE_EXPORT void* bunite_view_create(
	uint32_t view_id,
	void* window_ptr,
	const char* url,
	const char* html,
	const char* preload,
	const char* views_root,
	const char* navigation_rules_json,
	double x,
	double y,
	double width,
	double height,
	bool auto_resize,
	bool sandbox
);
BUNITE_EXPORT void bunite_view_load_url(void* view_ptr, const char* url);
BUNITE_EXPORT void bunite_view_load_html(void* view_ptr, const char* html);
BUNITE_EXPORT void bunite_view_remove(void* view_ptr);
BUNITE_EXPORT void bunite_complete_permission_request(uint32_t request_id, uint32_t state);

#ifdef __cplusplus
}
#endif
