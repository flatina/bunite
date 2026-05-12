#include "bunite_linux_internal.h"

namespace bunite_linux {

namespace {

gboolean on_close_request(GtkWindow* window, gpointer user_data) {
  (void)window;
  const uint32_t window_id = GPOINTER_TO_UINT(user_data);
  auto* state = findWindow(window_id);
  if (!state) return FALSE;
  if (!state->close_pending.exchange(true)) {
    emitWindowEvent(window_id, "close-requested", "");
  }
  return TRUE;  // JS must call destroy or reset_close_pending
}

void on_destroy(GtkWidget* widget, gpointer user_data) {
  (void)widget;
  const uint32_t window_id = GPOINTER_TO_UINT(user_data);
  emitWindowEvent(window_id, "close", "");
  std::vector<uint32_t> orphans;
  bool last = false;
  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    // GTK destroyed child view widgets with the parent; drop stale entries.
    for (auto it = g_runtime.views.begin(); it != g_runtime.views.end();) {
      if (it->second.window_id == window_id) {
        orphans.push_back(it->first);
        it = g_runtime.views.erase(it);
      } else ++it;
    }
    g_runtime.windows.erase(window_id);
    last = g_runtime.windows.empty();
  }
  for (uint32_t vid : orphans) detachViewSideState(vid);
  if (last && !g_runtime.shutting_down.load()) {
    emitWindowEvent(0, "all-windows-closed", "");
  }
}

}  // namespace

WindowState* findWindow(uint32_t window_id) {
  std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
  auto it = g_runtime.windows.find(window_id);
  return it == g_runtime.windows.end() ? nullptr : &it->second;
}

bool createWindow(uint32_t window_id, double x, double y, double width, double height,
                  const char* title, const char* title_bar_style,
                  bool transparent, bool hidden, bool minimized, bool maximized) {
  (void)x; (void)y;             // GTK4/Wayland: compositor places windows
  (void)title_bar_style;
  (void)transparent;

  if (!g_runtime.app) {
    BUNITE_ERROR("bunite_window_create: GtkApplication not initialized");
    return false;
  }

  GtkWindow* win = GTK_WINDOW(gtk_application_window_new(g_runtime.app));
  if (title && *title) gtk_window_set_title(win, title);
  gtk_window_set_default_size(win, (int)width, (int)height);

  GtkOverlay* host = GTK_OVERLAY(gtk_overlay_new());
  gtk_window_set_child(win, GTK_WIDGET(host));

  const gpointer id_ptr = GUINT_TO_POINTER(window_id);
  g_signal_connect(win, "close-request", G_CALLBACK(on_close_request), id_ptr);
  g_signal_connect(win, "destroy", G_CALLBACK(on_destroy), id_ptr);

  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    auto& st = g_runtime.windows[window_id];
    st.window = win;
    st.host = host;
    st.close_pending.store(false);
    st.minimized.store(minimized);
    st.maximized.store(maximized);
  }

  if (!hidden) gtk_window_present(win);
  if (maximized) gtk_window_maximize(win);
  if (minimized) gtk_window_minimize(win);

  return true;
}

void destroyWindow(uint32_t window_id) {
  GtkWindow* w = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    auto it = g_runtime.windows.find(window_id);
    if (it == g_runtime.windows.end()) return;
    w = it->second.window;
  }
  if (w) gtk_window_destroy(w);
}

}  // namespace bunite_linux
