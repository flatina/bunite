#include "bunite_linux_internal.h"
#include "webview_storage.h"

#include <string>
#include <vector>

namespace bunite_linux {

namespace {

constexpr const char* kViewIdKey = "bunite-view-id";

void emit_url(uint32_t view_id, const char* name, WebKitWebView* wv) {
  const char* uri = webkit_web_view_get_uri(wv);
  emitWebviewEvent(view_id, name, uri ? std::string(uri) : std::string{});
}

void on_load_changed(WebKitWebView* wv, WebKitLoadEvent event, gpointer user_data) {
  const uint32_t view_id = GPOINTER_TO_UINT(user_data);
  switch (event) {
    case WEBKIT_LOAD_COMMITTED:
      emit_url(view_id, "did-navigate", wv);
      queueViewRedraw(wv);
      break;
    case WEBKIT_LOAD_FINISHED:
      emit_url(view_id, "dom-ready", wv);
      queueViewRedraw(wv);
      break;
    default: break;
  }
}

GtkWidget* on_create(WebKitWebView* wv, WebKitNavigationAction* action, gpointer user_data) {
  const uint32_t view_id = GPOINTER_TO_UINT(user_data);
  WebKitURIRequest* req = webkit_navigation_action_get_request(action);
  const char* uri = webkit_uri_request_get_uri(req);
  std::string payload = "{\"url\":\"" + escapeJsonString(uri ? uri : "") + "\"}";
  emitWebviewEvent(view_id, "new-window-open", payload);
  (void)wv;
  return nullptr;  // cancel; JS opens via load_url if desired
}

// WebKitGTK fires NAVIGATION_ACTION for sub-frames too with no main-frame
// discriminator, so iframes go through nav rules here (diverges from mac/win).
gboolean on_decide_policy(WebKitWebView* wv, WebKitPolicyDecision* decision,
                          WebKitPolicyDecisionType type, gpointer user_data) {
  (void)wv;
  if (type != WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION &&
      type != WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION) return FALSE;
  const uint32_t view_id = GPOINTER_TO_UINT(user_data);
  auto* nav = WEBKIT_NAVIGATION_POLICY_DECISION(decision);
  WebKitNavigationAction* action = webkit_navigation_policy_decision_get_navigation_action(nav);
  WebKitURIRequest* request = webkit_navigation_action_get_request(action);
  const char* uri = webkit_uri_request_get_uri(request);
  const std::string url_str = uri ? uri : "";
  const bool allow = shouldAllowNavigation(findView(view_id), url_str);
  emitWebviewEvent(view_id, "will-navigate", url_str);
  if (allow) webkit_policy_decision_use(decision);
  else webkit_policy_decision_ignore(decision);
  return TRUE;
}

}  // namespace

ViewState* findView(uint32_t view_id) {
  std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
  auto it = g_runtime.views.find(view_id);
  return it == g_runtime.views.end() ? nullptr : &it->second;
}

uint32_t viewIdForWebView(WebKitWebView* wv) {
  if (!wv) return 0;
  return GPOINTER_TO_UINT(g_object_get_data(G_OBJECT(wv), kViewIdKey));
}

bool createView(uint32_t view_id, uint32_t window_id,
                const char* url, const char* html, const char* preload, const char* appres_root,
                const char* navigation_rules_json, const char* preload_origins_json,
                double x, double y, double width, double height, bool auto_resize) {
  auto* window_state = findWindow(window_id);
  if (!window_state) {
    BUNITE_ERROR("bunite_view_create: window %u not found", window_id);
    return false;
  }
  if (findView(view_id)) {
    BUNITE_ERROR("bunite_view_create: view %u already exists", view_id);
    return false;
  }

  WebKitUserContentManager* ucm = webkit_user_content_manager_new();

  // Origin-gate the preload so http(s) navigations don't inherit the RPC bridge.
  if (preload && *preload) {
    const char* origins = (preload_origins_json && *preload_origins_json)
      ? preload_origins_json : "[]";
    std::string gated;
    gated.reserve(strlen(preload) + 128);
    gated += "(function(){var _o=";
    gated += origins;
    gated += ";_o.push('appres://app.internal');";
    gated += "if(_o.indexOf(location.origin)<0)return;";
    gated += preload;
    gated += "})();";
    WebKitUserScript* script = webkit_user_script_new(
      gated.c_str(),
      WEBKIT_USER_CONTENT_INJECT_TOP_FRAME,
      WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START,
      nullptr, nullptr);
    webkit_user_content_manager_add_script(ucm, script);
    webkit_user_script_unref(script);
  }

  WebKitWebView* wv = WEBKIT_WEB_VIEW(g_object_new(
    WEBKIT_TYPE_WEB_VIEW,
    "user-content-manager", ucm,
    nullptr));
  g_object_unref(ucm);

  WebKitSettings* settings = webkit_web_view_get_settings(wv);
  webkit_settings_set_javascript_can_open_windows_automatically(settings, !g_runtime.popup_blocking);

  g_object_set_data(G_OBJECT(wv), kViewIdKey, GUINT_TO_POINTER(view_id));
  registerAppresScheme(webkit_web_view_get_context(wv));

  g_signal_connect(wv, "load-changed", G_CALLBACK(on_load_changed), GUINT_TO_POINTER(view_id));
  g_signal_connect(wv, "decide-policy", G_CALLBACK(on_decide_policy), GUINT_TO_POINTER(view_id));
  g_signal_connect(wv, "create", G_CALLBACK(on_create), GUINT_TO_POINTER(view_id));

  GtkWidget* container = GTK_WIDGET(wv);
  if (auto_resize) {
    gtk_overlay_set_child(window_state->host, GTK_WIDGET(wv));
  } else {
    container = gtk_fixed_new();
    gtk_widget_set_halign(container, GTK_ALIGN_START);
    gtk_widget_set_valign(container, GTK_ALIGN_START);
    gtk_widget_set_overflow(container, GTK_OVERFLOW_HIDDEN);
    gtk_fixed_put(GTK_FIXED(container), GTK_WIDGET(wv), 0, 0);
    gtk_overlay_add_overlay(window_state->host, container);
  }

  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    auto& st = g_runtime.views[view_id];
    st.webview = wv;
    st.container = container;
    st.window_id = window_id;
    st.appres_root = appres_root ? appres_root : "";
    st.preload_script = preload ? preload : "";
    st.navigation_rules = parseNavigationRulesJson(navigation_rules_json ? navigation_rules_json : "");
  }

  if (!auto_resize) applyViewBounds(view_id, x, y, width, height);
  queueViewRedraw(wv);

  if (url && *url) {
    webkit_web_view_load_uri(wv, url);
  } else if (html && *html) {
    webkit_web_view_load_html(wv, html, "appres://app.internal/");
  }

  emitWebviewEvent(view_id, "view-ready", "");
  return true;
}

void queueViewRedraw(WebKitWebView* wv) {
  if (!wv) return;
  GtkWidget* widget = GTK_WIDGET(wv);
  gtk_widget_queue_resize(widget);
  gtk_widget_queue_draw(widget);

  g_object_ref(widget);
  g_idle_add_full(G_PRIORITY_DEFAULT_IDLE,
    +[](gpointer data) -> gboolean {
      GtkWidget* w = GTK_WIDGET(data);
      gtk_widget_queue_resize(w);
      gtk_widget_queue_draw(w);
      GtkWidget* parent = gtk_widget_get_parent(w);
      if (parent) gtk_widget_queue_draw(parent);
      GtkWidget* grandparent = parent ? gtk_widget_get_parent(parent) : nullptr;
      if (grandparent) gtk_widget_queue_draw(grandparent);
      return G_SOURCE_REMOVE;
    },
    widget,
    +[](gpointer data) { g_object_unref(data); });
}

void applyViewBounds(uint32_t view_id, double x, double y, double w, double h) {
  auto* v = findView(view_id);
  if (!v) return;
  const int scale = gtk_widget_get_scale_factor(GTK_WIDGET(v->webview));
  const int s = scale > 0 ? scale : 1;
  // floor origin, ceil far edge — preserve coverage at non-integer scales.
  const int x0 = (int)(x / s);
  const int y0 = (int)(y / s);
  const int x1 = (int)((x + w + s - 1) / s);
  const int y1 = (int)((y + h + s - 1) / s);
  GtkWidget* widget = GTK_WIDGET(v->webview);
  GtkWidget* container = v->container ? v->container : widget;
  const int width = x1 - x0;
  const int height = y1 - y0;
  gtk_widget_set_margin_start(container, x0);
  gtk_widget_set_margin_top(container, y0);
  gtk_widget_set_size_request(container, width, height);
  gtk_widget_set_size_request(widget, width, height);
  gtk_widget_queue_resize(container);
  gtk_widget_queue_draw(container);
  queueViewRedraw(v->webview);
}

void detachViewSideState(uint32_t view_id) {
  bunite::WebviewContentStorage::instance().remove(view_id);
  std::vector<uint32_t> request_ids;
  for (auto& [rid, p] : g_runtime.pending_route_tasks) {
    if (p.view_id == view_id) request_ids.push_back(rid);
  }
  for (uint32_t rid : request_ids) {
    auto it = g_runtime.pending_route_tasks.find(rid);
    WebKitURISchemeRequest* req = it->second.request;
    g_runtime.pending_route_tasks.erase(it);
    GError* err = g_error_new_literal(G_IO_ERROR, G_IO_ERROR_CANCELLED, "view destroyed");
    webkit_uri_scheme_request_finish_error(req, err);
    g_error_free(err);
    g_object_unref(req);
  }
}

void removeView(uint32_t view_id) {
  WebKitWebView* wv = nullptr;
  GtkWidget* container = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    auto it = g_runtime.views.find(view_id);
    if (it == g_runtime.views.end()) return;
    wv = it->second.webview;
    container = it->second.container;
    g_runtime.views.erase(it);
  }
  detachViewSideState(view_id);
  GtkWidget* target = container ? container : (wv ? GTK_WIDGET(wv) : nullptr);
  if (target && gtk_widget_get_parent(target)) {
    gtk_widget_unparent(target);
  }
}

}  // namespace bunite_linux
