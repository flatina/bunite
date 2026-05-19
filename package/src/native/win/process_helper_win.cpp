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

  bool OnProcessMessageReceived(
    CefRefPtr<CefBrowser> browser,
    CefRefPtr<CefFrame> frame,
    CefProcessId /*source_process*/,
    CefRefPtr<CefProcessMessage> message
  ) override {
    if (message->GetName() != "bunite.evaluate.request") return false;
    auto args = message->GetArgumentList();
    if (!args || args->GetSize() < 2) return true;
    uint32_t request_id = static_cast<uint32_t>(args->GetInt(0));
    std::string script = args->GetString(1).ToString();

    auto context = frame->GetV8Context();
    auto reply = CefProcessMessage::Create("bunite.evaluate.result");
    auto rl = reply->GetArgumentList();
    rl->SetInt(0, static_cast<int>(request_id));
    if (!context) {
      rl->SetBool(1, false);
      rl->SetString(2, "runtime_error");
      rl->SetString(3, "no V8 context");
      frame->SendProcessMessage(PID_BROWSER, reply);
      return true;
    }

    // Same wrapper as WebView2/mac/linux: try/catch returning a JSON envelope
    // string. SecurityError is detected locale-independently inside the JS.
    std::string wrapped =
        "(function(){try{return JSON.stringify({__bunite_ok:true,value:(" + script +
        ")})}catch(e){var c=(e&&e.name===\"SecurityError\")?\"cross_origin\":\"runtime_error\";"
        "return JSON.stringify({__bunite_ok:false,code:c,"
        "message:(e&&e.message)?e.message:String(e),"
        "name:(e&&e.name)||\"\"})}})()";

    context->Enter();
    CefRefPtr<CefV8Value> retval;
    CefRefPtr<CefV8Exception> exception;
    bool ok = context->Eval(wrapped, "bunite://evaluate", 0, retval, exception);

    if (ok && retval && retval->IsString()) {
      std::string inner = retval->GetStringValue().ToString();
      if (inner.find("\"__bunite_ok\":true") != std::string::npos) {
        static const std::string prefix = "{\"__bunite_ok\":true,\"value\":";
        std::string value_json = "null";
        if (inner.compare(0, prefix.size(), prefix) == 0 &&
            inner.size() > prefix.size() + 1) {
          value_json = inner.substr(prefix.size(), inner.size() - prefix.size() - 1);
        }
        rl->SetBool(1, true);
        rl->SetString(2, value_json);
        rl->SetString(3, "");
      } else {
        // Anchor at the envelope prefix — user-controlled e.message could
        // otherwise inject a fake "code" via the substring scan above.
        static const std::string codePrefix = "{\"__bunite_ok\":false,\"code\":\"";
        std::string code = "runtime_error";
        std::string msg = "script threw";
        if (inner.compare(0, codePrefix.size(), codePrefix) == 0) {
          size_t start = codePrefix.size();
          size_t end = start;
          while (end < inner.size() && inner[end] != '"') ++end;
          if (end > start) code = inner.substr(start, end - start);
          static const std::string msgKey = "\",\"message\":\"";
          if (end + msgKey.size() <= inner.size() &&
              inner.compare(end, msgKey.size(), msgKey) == 0) {
            size_t mstart = end + msgKey.size();
            size_t mend = mstart;
            while (mend < inner.size()) {
              if (inner[mend] == '"' && (mend == mstart || inner[mend - 1] != '\\')) break;
              ++mend;
            }
            if (mend > mstart) msg = inner.substr(mstart, mend - mstart);
          }
        }
        rl->SetBool(1, false);
        rl->SetString(2, code);
        rl->SetString(3, msg);
      }
    } else {
      // Wrapper itself failed (syntax error in user script, or V8 internal).
      std::string msg = exception ? exception->GetMessage().ToString() : "eval failed";
      rl->SetBool(1, false);
      rl->SetString(2, "runtime_error");
      rl->SetString(3, msg);
    }
    context->Exit();
    frame->SendProcessMessage(PID_BROWSER, reply);
    return true;
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

    // Skip isolated-world contexts (DevTools/extensions) — only main-world has customElements.
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
