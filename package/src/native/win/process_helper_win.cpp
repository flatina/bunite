#include "include/cef_app.h"
#include "include/cef_parser.h"
#include "include/cef_v8.h"

#include <windows.h>

#include <map>
#include <string>

namespace {

struct PreloadScriptInfo {
  std::string script;
  std::vector<std::string> allowed_origins; // e.g. "http://localhost:3000"
};

std::string getUrlOrigin(const std::string& url) {
  CefURLParts parts;
  if (!CefParseURL(url, parts)) {
    return "";
  }
  const std::string scheme = CefString(&parts.scheme).ToString();
  const std::string host = CefString(&parts.host).ToString();
  const std::string port = CefString(&parts.port).ToString();
  if (scheme.empty() || host.empty()) return "";
  if (port.empty()) return scheme + "://" + host;
  return scheme + "://" + host + ":" + port;
}

} // namespace

class BuniteHelperApp : public CefApp, public CefRenderProcessHandler {
public:
  CefRefPtr<CefRenderProcessHandler> GetRenderProcessHandler() override {
    return this;
  }

  void OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) override {
    registrar->AddCustomScheme(
      "appres",
      CEF_SCHEME_OPTION_STANDARD |
        CEF_SCHEME_OPTION_CORS_ENABLED |
        CEF_SCHEME_OPTION_SECURE |
        CEF_SCHEME_OPTION_CSP_BYPASSING |
        CEF_SCHEME_OPTION_FETCH_ENABLED
    );
  }

  void OnBrowserCreated(
    CefRefPtr<CefBrowser> browser,
    CefRefPtr<CefDictionaryValue> extra_info
  ) override {
    if (extra_info && (extra_info->HasKey("preloadScript") || extra_info->HasKey("preloadOrigins"))) {
      PreloadScriptInfo info;
      if (extra_info->HasKey("preloadScript")) {
        info.script = extra_info->GetString("preloadScript").ToString();
      }
      if (extra_info->HasKey("preloadOrigins")) {
        auto list = extra_info->GetList("preloadOrigins");
        for (size_t i = 0; i < list->GetSize(); ++i) {
          info.allowed_origins.push_back(list->GetString(i).ToString());
        }
      }
      preload_scripts_[browser->GetIdentifier()] = std::move(info);
    }
  }

  void OnBrowserDestroyed(CefRefPtr<CefBrowser> browser) override {
    preload_scripts_.erase(browser->GetIdentifier());
  }

  void OnContextCreated(
    CefRefPtr<CefBrowser> browser,
    CefRefPtr<CefFrame> frame,
    CefRefPtr<CefV8Context> context
  ) override {
    if (!frame->IsMain()) return;

    const std::string url = frame->GetURL().ToString();
    if (url.empty() || url == "about:blank") return;

    const auto it = preload_scripts_.find(browser->GetIdentifier());
    if (it == preload_scripts_.end() || it->second.script.empty()) return;

    const bool is_appres = url.rfind("appres://app.internal/", 0) == 0;
    bool is_allowed_origin = false;
    if (!it->second.allowed_origins.empty()) {
      const std::string origin = getUrlOrigin(url);
      for (const auto& allowed : it->second.allowed_origins) {
        if (origin == allowed) { is_allowed_origin = true; break; }
      }
    }
    if (!is_appres && !is_allowed_origin) return;

    // Skip isolated-world contexts (DevTools overlay, extensions, etc.) that
    // lack full Web APIs. The page's main-world context has customElements;
    // DevTools-injected contexts do not.
    context->Enter();
    CefRefPtr<CefV8Value> ce = context->GetGlobal()->GetValue("customElements");
    bool is_main_world = ce && !ce->IsNull() && !ce->IsUndefined();
    context->Exit();
    if (!is_main_world) return;

    CefRefPtr<CefV8Value> retval;
    CefRefPtr<CefV8Exception> exception;
    bool ok = context->Eval(it->second.script, "bunite://preload", 0, retval, exception);
    if (!ok && exception) {
      std::string msg = exception->GetMessage().ToString();
      int line = exception->GetLineNumber();
      std::string src_line = exception->GetSourceLine().ToString();
      LOG(ERROR) << "bunite preload eval failed at line " << line
                 << ": " << msg << "\n  " << src_line;
    }
  }

private:
  std::map<int, PreloadScriptInfo> preload_scripts_;

  IMPLEMENT_REFCOUNTING(BuniteHelperApp);
};

int APIENTRY wWinMain(HINSTANCE hInstance, HINSTANCE, PWSTR, int) {
  CefMainArgs main_args(hInstance);
  CefRefPtr<CefApp> app = new BuniteHelperApp();
  return CefExecuteProcess(main_args, app, nullptr);
}
