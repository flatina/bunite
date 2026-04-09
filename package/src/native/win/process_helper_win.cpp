#include "include/cef_app.h"
#include "include/cef_v8.h"

#include <windows.h>

#include <map>
#include <string>

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
    if (extra_info && extra_info->HasKey("preloadScript")) {
      preload_scripts_[browser->GetIdentifier()] =
        extra_info->GetString("preloadScript").ToString();
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
    if (url.empty() || url == "about:blank" || url.rfind("appres://", 0) != 0) return;

    const auto it = preload_scripts_.find(browser->GetIdentifier());
    if (it == preload_scripts_.end() || it->second.empty()) return;

    CefRefPtr<CefV8Value> retval;
    CefRefPtr<CefV8Exception> exception;
    context->Eval(it->second, "bunite://preload", 0, retval, exception);
  }

private:
  std::map<int, std::string> preload_scripts_;

  IMPLEMENT_REFCOUNTING(BuniteHelperApp);
};

int APIENTRY wWinMain(HINSTANCE hInstance, HINSTANCE, PWSTR, int) {
  CefMainArgs main_args(hInstance);
  CefRefPtr<CefApp> app = new BuniteHelperApp();
  return CefExecuteProcess(main_args, app, nullptr);
}
