#include "bunite_linux_internal.h"
#include "webview_storage.h"

#include <string>
#include <vector>

namespace bunite_linux {

namespace {

constexpr const char* kViewIdKey = "bunite-view-id";

// Forward decls — on_create references these to wire popup-minted views.
gboolean on_decide_policy(WebKitWebView*, WebKitPolicyDecision*, WebKitPolicyDecisionType, gpointer);
void on_title_changed(GObject*, GParamSpec*, gpointer);

void emit_url(uint32_t view_id, const char* name, WebKitWebView* wv) {
  const char* uri = webkit_web_view_get_uri(wv);
  emitWebviewEvent(view_id, name, uri ? std::string(uri) : std::string{});
}

void on_load_changed(WebKitWebView* wv, WebKitLoadEvent event, gpointer user_data) {
  const uint32_t view_id = GPOINTER_TO_UINT(user_data);
  switch (event) {
    case WEBKIT_LOAD_STARTED:
      emit_url(view_id, "load-start", wv);
      break;
    case WEBKIT_LOAD_COMMITTED:
      emit_url(view_id, "did-navigate", wv);
      queueViewRedraw(wv);
      break;
    case WEBKIT_LOAD_FINISHED:
      emit_url(view_id, "load-finish", wv);
      emit_url(view_id, "dom-ready", wv);
      queueViewRedraw(wv);
      break;
    default: break;
  }
}

gboolean on_load_failed(WebKitWebView* /*wv*/, WebKitLoadEvent /*ev*/, const char* failing_uri,
                        GError* error, gpointer user_data) {
  const uint32_t view_id = GPOINTER_TO_UINT(user_data);
  std::string payload = "{\"url\":\"" + escapeJsonString(failing_uri ? failing_uri : "") +
                        "\",\"reason\":\"" + escapeJsonString(error && error->message ? error->message : "") + "\"}";
  emitWebviewEvent(view_id, "load-fail", payload);
  return FALSE;  // let WebKit show its default error page
}

gboolean on_load_failed_tls(WebKitWebView* /*wv*/, const char* failing_uri,
                            GTlsCertificate* /*cert*/, GTlsCertificateFlags /*errors*/,
                            gpointer user_data) {
  const uint32_t view_id = GPOINTER_TO_UINT(user_data);
  std::string payload = "{\"url\":\"" + escapeJsonString(failing_uri ? failing_uri : "") +
                        "\",\"reason\":\"tls-certificate-error\"}";
  emitWebviewEvent(view_id, "load-fail", payload);
  return FALSE;  // do not override default certificate failure behavior
}

gboolean on_script_dialog(WebKitWebView* /*wv*/, WebKitScriptDialog* dialog, gpointer user_data) {
  const uint32_t view_id = GPOINTER_TO_UINT(user_data);
  auto* v = findView(view_id);
  if (!v) return FALSE;
  WebKitScriptDialogType type = webkit_script_dialog_get_dialog_type(dialog);
  const char* kind = nullptr;
  switch (type) {
    case WEBKIT_SCRIPT_DIALOG_ALERT:        kind = "alert"; break;
    case WEBKIT_SCRIPT_DIALOG_CONFIRM:      kind = "confirm"; break;
    case WEBKIT_SCRIPT_DIALOG_PROMPT:       kind = "prompt"; break;
    case WEBKIT_SCRIPT_DIALOG_BEFORE_UNLOAD_CONFIRM: kind = "beforeunload"; break;
    default: return FALSE;
  }
  // Defer the dialog so the page execution stays paused until host responds.
  webkit_script_dialog_ref(dialog);
  const uint32_t rid = v->next_dialog_request_id++;
  v->pending_dialogs[rid] = dialog;
  const char* message = webkit_script_dialog_get_message(dialog);
  std::string payload = "{\"requestId\":" + std::to_string(rid) +
                        ",\"kind\":\"" + kind +
                        "\",\"message\":\"" + escapeJsonString(message ? message : "") + "\"";
  if (type == WEBKIT_SCRIPT_DIALOG_PROMPT) {
    const char* def = webkit_script_dialog_prompt_get_default_text(dialog);
    payload += ",\"defaultPrompt\":\"" + escapeJsonString(def ? def : "") + "\"";
  }
  payload += "}";
  emitWebviewEvent(view_id, "dialog", payload);
  return TRUE;  // we handled it
}

GtkWidget* on_create(WebKitWebView* wv, WebKitNavigationAction* action, gpointer user_data) {
  const uint32_t opener_view_id = GPOINTER_TO_UINT(user_data);
  WebKitURIRequest* req = webkit_navigation_action_get_request(action);
  const char* uri = webkit_uri_request_get_uri(req);
  if (g_runtime.popup_blocking) {
    std::string payload = "{\"url\":\"" + escapeJsonString(uri ? uri : "") + "\"}";
    emitWebviewEvent(opener_view_id, "new-window-open", payload);
    return nullptr;
  }
  static std::atomic<uint32_t> g_popup_seq{0x80000000u};
  const uint32_t new_view_id = g_popup_seq.fetch_add(1);
  // Share network-session + user-content-manager so cookies/preload-injection
  // carry across the opener boundary.
  WebKitWebView* popup = WEBKIT_WEB_VIEW(g_object_new(
      WEBKIT_TYPE_WEB_VIEW,
      "network-session", webkit_web_view_get_network_session(wv),
      "user-content-manager", webkit_web_view_get_user_content_manager(wv),
      nullptr));
  g_object_ref_sink(popup);
  g_object_set_data(G_OBJECT(popup), kViewIdKey, GUINT_TO_POINTER(new_view_id));
  g_signal_connect(popup, "load-changed", G_CALLBACK(on_load_changed), GUINT_TO_POINTER(new_view_id));
  g_signal_connect(popup, "load-failed", G_CALLBACK(on_load_failed), GUINT_TO_POINTER(new_view_id));
  g_signal_connect(popup, "load-failed-with-tls-errors", G_CALLBACK(on_load_failed_tls), GUINT_TO_POINTER(new_view_id));
  g_signal_connect(popup, "decide-policy", G_CALLBACK(on_decide_policy), GUINT_TO_POINTER(new_view_id));
  g_signal_connect(popup, "create", G_CALLBACK(on_create), GUINT_TO_POINTER(new_view_id));
  g_signal_connect(popup, "notify::title", G_CALLBACK(on_title_changed), GUINT_TO_POINTER(new_view_id));
  g_signal_connect(popup, "script-dialog", G_CALLBACK(on_script_dialog), GUINT_TO_POINTER(new_view_id));
  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    g_runtime.parked_popups[new_view_id] = popup;
    auto& st = g_runtime.views[new_view_id];
    st.webview = popup;
    st.window_id = 0;  // bound on adoption
    st.container = GTK_WIDGET(popup);
  }
  if (g_runtime.popup_parent) {
    GtkWidget* box = gtk_window_get_child(g_runtime.popup_parent);
    if (box) gtk_box_append(GTK_BOX(box), GTK_WIDGET(popup));
  }
  std::string payload = "{\"newSurfaceId\":" + std::to_string(new_view_id) +
                        ",\"url\":\"" + escapeJsonString(uri ? uri : "") +
                        "\",\"disposition\":\"popup\"}";
  emitWebviewEvent(opener_view_id, "popup-requested", payload);
  return GTK_WIDGET(popup);
}

void on_title_changed(GObject* source, GParamSpec* /*pspec*/, gpointer user_data) {
  const uint32_t view_id = GPOINTER_TO_UINT(user_data);
  WebKitWebView* wv = WEBKIT_WEB_VIEW(source);
  const char* title = webkit_web_view_get_title(wv);
  std::string payload = "{\"title\":\"" + escapeJsonString(title ? title : "") + "\"}";
  emitWebviewEvent(view_id, "title-changed", payload);
}

// WebKitGTK fires nav-action for sub-frames with no main-frame discriminator — iframes hit nav rules.
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

constexpr const char* kDownloadIdKey = "bunite-download-id";
std::atomic<uint64_t> g_download_seq{1};

uint32_t viewIdForDownload(WebKitDownload* download) {
  WebKitWebView* wv = webkit_download_get_web_view(download);
  if (!wv) return 0;
  return GPOINTER_TO_UINT(g_object_get_data(G_OBJECT(wv), kViewIdKey));
}

void on_received_data(WebKitDownload* download, guint64 /*data_length*/, gpointer /*user_data*/) {
  const uint32_t view_id = viewIdForDownload(download);
  if (!view_id) return;
  const uint64_t id = GPOINTER_TO_SIZE(g_object_get_data(G_OBJECT(download), kDownloadIdKey));
  const guint64 received = webkit_download_get_received_data_length(download);
  WebKitURIResponse* resp = webkit_download_get_response(download);
  const guint64 total = resp ? webkit_uri_response_get_content_length(resp) : 0;
  std::string payload = "{\"kind\":\"progress\",\"id\":\"linux-" + std::to_string(id) +
                        "\",\"receivedBytes\":" + std::to_string(received);
  if (total > 0) payload += ",\"totalBytes\":" + std::to_string(total);
  payload += "}";
  emitWebviewEvent(view_id, "download-event", payload);
}

void on_download_finished(WebKitDownload* download, gpointer /*user_data*/) {
  const uint32_t view_id = viewIdForDownload(download);
  if (!view_id) return;
  const uint64_t id = GPOINTER_TO_SIZE(g_object_get_data(G_OBJECT(download), kDownloadIdKey));
  const char* dest_uri = webkit_download_get_destination(download);
  std::string dest = dest_uri ? dest_uri : "";
  if (dest.rfind("file://", 0) == 0) dest = dest.substr(7);
  std::string payload = "{\"kind\":\"completed\",\"id\":\"linux-" + std::to_string(id) +
                        "\",\"localPath\":\"" + escapeJsonString(dest) + "\"}";
  emitWebviewEvent(view_id, "download-event", payload);
}

void on_download_failed(WebKitDownload* download, GError* error, gpointer /*user_data*/) {
  const uint32_t view_id = viewIdForDownload(download);
  if (!view_id) return;
  const uint64_t id = GPOINTER_TO_SIZE(g_object_get_data(G_OBJECT(download), kDownloadIdKey));
  std::string reason = error && error->message ? error->message : "unknown";
  std::string payload = "{\"kind\":\"failed\",\"id\":\"linux-" + std::to_string(id) +
                        "\",\"reason\":\"" + escapeJsonString(reason) + "\"}";
  emitWebviewEvent(view_id, "download-event", payload);
}

// `decide-destination` is the gate: emits `started` / `blocked` and sets path.
// Returning TRUE tells WebKit we resolved (or cancelled) destination.
gboolean on_decide_destination(WebKitDownload* download, const gchar* suggested, gpointer /*user_data*/) {
  const uint32_t view_id = viewIdForDownload(download);
  if (!view_id) return FALSE;
  ViewState* st = nullptr;
  {
    std::lock_guard<std::mutex> lk(g_runtime.object_mutex);
    auto it = g_runtime.views.find(view_id);
    if (it != g_runtime.views.end()) st = &it->second;
  }
  if (!st) return FALSE;
  const uint64_t id = GPOINTER_TO_SIZE(g_object_get_data(G_OBJECT(download), kDownloadIdKey));
  WebKitURIRequest* req = webkit_download_get_request(download);
  const std::string url = (req && webkit_uri_request_get_uri(req)) ? webkit_uri_request_get_uri(req) : "";

  const int32_t policy = st->download_policy.load();
  if (policy != 0) {
    const char* reason = (policy == 1) ? "ask-not-implemented" : "host-policy";
    std::string payload = "{\"kind\":\"blocked\",\"id\":\"linux-" + std::to_string(id) +
                          "\",\"url\":\"" + escapeJsonString(url) +
                          "\",\"reason\":\"" + reason + "\"}";
    emitWebviewEvent(view_id, "download-event", payload);
    webkit_download_cancel(download);
    return TRUE;
  }

  const std::string sug = suggested ? suggested : "download";
  WebKitURIResponse* resp = webkit_download_get_response(download);
  const std::string mime = (resp && webkit_uri_response_get_mime_type(resp)) ? webkit_uri_response_get_mime_type(resp) : "";
  const guint64 total = resp ? webkit_uri_response_get_content_length(resp) : 0;
  std::string started = "{\"kind\":\"started\",\"id\":\"linux-" + std::to_string(id) +
                        "\",\"url\":\"" + escapeJsonString(url) +
                        "\",\"suggestedFilename\":\"" + escapeJsonString(sug) +
                        "\",\"mimeType\":\"" + escapeJsonString(mime) + "\"";
  if (total > 0) started += ",\"sizeBytes\":" + std::to_string(total);
  started += "}";
  emitWebviewEvent(view_id, "download-event", started);

  std::string dir = st->download_dir;
  if (dir.empty()) {
    const char* d = g_get_user_special_dir(G_USER_DIRECTORY_DOWNLOAD);
    dir = d ? d : "/tmp";
  }
  std::string path = dir + "/" + sug;
  std::string uri = "file://" + path;
  webkit_download_set_destination(download, uri.c_str());
  return TRUE;
}

void on_download_started(WebKitNetworkSession* /*session*/, WebKitDownload* download, gpointer /*user_data*/) {
  const uint32_t view_id = viewIdForDownload(download);
  if (!view_id) {
    webkit_download_cancel(download);
    return;
  }
  const uint64_t id = g_download_seq.fetch_add(1);
  g_object_set_data(G_OBJECT(download), kDownloadIdKey, GSIZE_TO_POINTER(id));
  g_signal_connect(download, "decide-destination", G_CALLBACK(on_decide_destination), nullptr);
  g_signal_connect(download, "received-data", G_CALLBACK(on_received_data), nullptr);
  g_signal_connect(download, "finished", G_CALLBACK(on_download_finished), nullptr);
  g_signal_connect(download, "failed", G_CALLBACK(on_download_failed), nullptr);
}

}  // namespace

void wireDownloadHandlers() {
  static bool wired = false;
  if (wired) return;
  WebKitNetworkSession* session = webkit_network_session_get_default();
  if (!session) return;
  g_signal_connect(session, "download-started", G_CALLBACK(on_download_started), nullptr);
  wired = true;
}

ViewState* findView(uint32_t view_id) {
  std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
  auto it = g_runtime.views.find(view_id);
  return it == g_runtime.views.end() ? nullptr : &it->second;
}

uint32_t viewIdForWebView(WebKitWebView* wv) {
  if (!wv) return 0;
  return GPOINTER_TO_UINT(g_object_get_data(G_OBJECT(wv), kViewIdKey));
}

void respondToDialogRequest(uint32_t view_id, uint32_t request_id, bool accept,
                            const std::string& text) {
  auto* v = findView(view_id);
  if (!v) return;
  auto it = v->pending_dialogs.find(request_id);
  if (it == v->pending_dialogs.end()) return;
  WebKitScriptDialog* dialog = it->second;
  v->pending_dialogs.erase(it);
  if (!dialog) return;
  WebKitScriptDialogType type = webkit_script_dialog_get_dialog_type(dialog);
  if (type == WEBKIT_SCRIPT_DIALOG_CONFIRM || type == WEBKIT_SCRIPT_DIALOG_BEFORE_UNLOAD_CONFIRM) {
    webkit_script_dialog_confirm_set_confirmed(dialog, accept ? TRUE : FALSE);
  } else if (type == WEBKIT_SCRIPT_DIALOG_PROMPT) {
    if (accept) webkit_script_dialog_prompt_set_text(dialog, text.c_str());
    else webkit_script_dialog_prompt_set_text(dialog, nullptr);
  }
  webkit_script_dialog_close(dialog);
  webkit_script_dialog_unref(dialog);
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

  wireDownloadHandlers();

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
  g_signal_connect(wv, "load-failed", G_CALLBACK(on_load_failed), GUINT_TO_POINTER(view_id));
  g_signal_connect(wv, "load-failed-with-tls-errors", G_CALLBACK(on_load_failed_tls), GUINT_TO_POINTER(view_id));
  g_signal_connect(wv, "decide-policy", G_CALLBACK(on_decide_policy), GUINT_TO_POINTER(view_id));
  g_signal_connect(wv, "create", G_CALLBACK(on_create), GUINT_TO_POINTER(view_id));
  g_signal_connect(wv, "notify::title", G_CALLBACK(on_title_changed), GUINT_TO_POINTER(view_id));
  g_signal_connect(wv, "script-dialog", G_CALLBACK(on_script_dialog), GUINT_TO_POINTER(view_id));

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

bool acceptParkedPopup(uint32_t new_view_id, uint32_t host_window_id, double x, double y, double w, double h) {
  WebKitWebView* popup = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    auto it = g_runtime.parked_popups.find(new_view_id);
    if (it == g_runtime.parked_popups.end()) return false;
    popup = it->second;
    g_runtime.parked_popups.erase(it);
  }
  auto* host = findWindow(host_window_id);
  if (!host || !host->host) return false;
  gtk_widget_unparent(GTK_WIDGET(popup));
  GtkWidget* container = gtk_fixed_new();
  gtk_widget_set_halign(container, GTK_ALIGN_START);
  gtk_widget_set_valign(container, GTK_ALIGN_START);
  gtk_widget_set_overflow(container, GTK_OVERFLOW_HIDDEN);
  gtk_fixed_put(GTK_FIXED(container), GTK_WIDGET(popup), 0, 0);
  gtk_overlay_add_overlay(host->host, container);
  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    auto& st = g_runtime.views[new_view_id];
    st.window_id = host_window_id;
    st.container = container;
    st.webview = popup;
  }
  applyViewBounds(new_view_id, x, y, w, h);
  // Re-emit view-ready so TS BrowserView.adopt resolves its waiter — the
  // initial `did-navigate` fired before the adopter registered.
  emitWebviewEvent(new_view_id, "view-ready", std::string{});
  return true;
}

void dismissParkedPopup(uint32_t new_view_id) {
  WebKitWebView* popup = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_runtime.object_mutex);
    auto it = g_runtime.parked_popups.find(new_view_id);
    if (it == g_runtime.parked_popups.end()) return;
    popup = it->second;
    g_runtime.parked_popups.erase(it);
    g_runtime.views.erase(new_view_id);
  }
  gtk_widget_unparent(GTK_WIDGET(popup));
  g_object_unref(popup);
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
