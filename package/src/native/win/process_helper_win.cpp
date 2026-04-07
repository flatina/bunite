#include "include/cef_app.h"

#include <windows.h>

class BuniteHelperApp : public CefApp {
public:
  void OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) override {
    registrar->AddCustomScheme(
      "views",
      CEF_SCHEME_OPTION_STANDARD |
        CEF_SCHEME_OPTION_CORS_ENABLED |
        CEF_SCHEME_OPTION_SECURE |
        CEF_SCHEME_OPTION_CSP_BYPASSING |
        CEF_SCHEME_OPTION_FETCH_ENABLED
    );
  }

private:
  IMPLEMENT_REFCOUNTING(BuniteHelperApp);
};

int APIENTRY wWinMain(HINSTANCE hInstance, HINSTANCE, PWSTR, int) {
  CefMainArgs main_args(hInstance);
  CefRefPtr<CefApp> app = new BuniteHelperApp();
  return CefExecuteProcess(main_args, app, nullptr);
}
