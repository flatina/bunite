// WebView2 cooperative-pump spike (Stage 0).
//
// Validates the hypothesis that a non-blocking message-pump loop driven from
// the main thread (mirroring mac/linux's `bunite_pump_once` model) can dispatch
// every WebView2 callback class bunite relies on.
//
// Measurement targets (printed to stderr as `SPIKE: …`):
//   1. Environment / Controller create-completion latency
//   2. NavigationCompleted latency
//   3. WebResourceRequested concurrent stress (N=100)        — p95
//   4. WebMessageReceived hot-path throughput                — drop rate
//   5. PermissionRequested Deferral completion latency
//   6. Sleep(1) vs MsgWaitForMultipleObjects(QS_ALLEVENTS)  — wake cycle cost
//
// Exit code 0 = all green. Non-zero = at least one measurement failed a budget.

#include <windows.h>
#include <wrl.h>
#include "WebView2.h"
#include "WebView2EnvironmentOptions.h"

#include <cstdio>
#include <cstdint>
#include <chrono>
#include <string>
#include <vector>
#include <atomic>
#include <algorithm>

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Make;

namespace {

using SteadyClock = std::chrono::steady_clock;

constexpr wchar_t kClassName[] = L"BuniteWebView2Spike";

double ElapsedMs(SteadyClock::time_point from) {
  return std::chrono::duration<double, std::milli>(SteadyClock::now() - from).count();
}

// --- HTML payload --------------------------------------------------------
// The page generates synthetic load for every callback class we measure.
constexpr const char* kSpikeHtml = R"(<!doctype html>
<html><head><meta charset="utf-8"><title>spike</title></head>
<body>
<script>
  // 3. WebResourceRequested stress: 100 concurrent fetches of /probe/N.
  window.__startResourceStress = (n) => {
    const t0 = performance.now();
    const promises = [];
    for (let i = 0; i < n; i++) {
      promises.push(fetch('/probe/' + i).then(r => r.text()));
    }
    return Promise.all(promises).then(() => performance.now() - t0);
  };

  // 4. WebMessageReceived hot-path.
  window.__startMessageStress = (n) => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) window.chrome.webview.postMessage('p:' + i);
    return performance.now() - t0;
  };

  window.chrome.webview.addEventListener('message', (ev) => {
    if (ev.data === 'ping') window.chrome.webview.postMessage('pong');
  });

  // 5. PermissionRequested: ask for clipboard read (any permission works).
  window.__requestPermission = async () => {
    try { await navigator.clipboard.readText(); } catch (e) {}
  };
</script>
<p>WebView2 spike loaded</p>
</body></html>)";

// --- Spike state ---------------------------------------------------------
struct Spike {
  HWND hwnd = nullptr;
  ComPtr<ICoreWebView2Environment> env;
  ComPtr<ICoreWebView2Controller> controller;
  ComPtr<ICoreWebView2> webview;

  std::atomic<bool> envReady{false};
  std::atomic<bool> controllerReady{false};
  std::atomic<bool> navigationCompleted{false};

  SteadyClock::time_point t_env_request;
  SteadyClock::time_point t_controller_request;
  SteadyClock::time_point t_navigate_request;

  double env_ms = 0;
  double controller_ms = 0;
  double navigation_ms = 0;

  // Resource stress.
  std::vector<double> resource_latencies;
  std::atomic<int> messageCount{0};
  std::atomic<int> permissionEvents{0};

  bool stress_started = false;
  bool resource_done = false;
  bool message_done = false;
  bool permission_done = false;

  HRESULT lastError = S_OK;
};

void Fail(Spike& s, const char* where, HRESULT hr) {
  s.lastError = hr;
  std::fprintf(stderr, "SPIKE: FAIL %s hr=0x%08x\n", where, static_cast<unsigned>(hr));
  PostQuitMessage(static_cast<int>(hr));
}

// --- Pump --------------------------------------------------------------
// Drains the message queue using the cooperative model the plan proposes.
// Returns false when WM_QUIT is dequeued.
bool PumpOnce() {
  MSG msg;
  while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
    if (msg.message == WM_QUIT) return false;
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  return true;
}

// --- Async chain --------------------------------------------------------
void StartNavigate(Spike& s);
void StartStress(Spike& s);

HRESULT OnEnvironmentCreated(Spike& s, HRESULT hr, ICoreWebView2Environment* env) {
  if (FAILED(hr) || !env) { Fail(s, "environment-create", hr); return hr; }
  s.env_ms = ElapsedMs(s.t_env_request);
  s.envReady = true;
  s.env = env;
  std::fprintf(stderr, "SPIKE: env_ready ms=%.2f\n", s.env_ms);

  s.t_controller_request = SteadyClock::now();
  hr = env->CreateCoreWebView2Controller(
      s.hwnd,
      Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
          [&s](HRESULT cr, ICoreWebView2Controller* ctl) -> HRESULT {
            if (FAILED(cr) || !ctl) { Fail(s, "controller-create", cr); return cr; }
            s.controller_ms = ElapsedMs(s.t_controller_request);
            s.controller = ctl;
            s.controllerReady = true;
            std::fprintf(stderr, "SPIKE: controller_ready ms=%.2f\n", s.controller_ms);

            RECT rc; GetClientRect(s.hwnd, &rc);
            ctl->put_Bounds(rc);

            HRESULT gh = ctl->get_CoreWebView2(&s.webview);
            if (FAILED(gh) || !s.webview) { Fail(s, "get_CoreWebView2", gh); return gh; }

            // 3. WebResourceRequested — add filter + handler for /probe/*.
            s.webview->AddWebResourceRequestedFilter(
                L"https://spike.invalid/*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
            EventRegistrationToken tok;
            s.webview->add_WebResourceRequested(
                Callback<ICoreWebView2WebResourceRequestedEventHandler>(
                    [&s](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
                      ComPtr<ICoreWebView2WebResourceRequest> req;
                      args->get_Request(&req);
                      // Build a 1-byte response.
                      ComPtr<ICoreWebView2WebResourceResponse> resp;
                      s.env->CreateWebResourceResponse(
                          nullptr, 200, L"OK",
                          L"Content-Type: text/plain\r\nAccess-Control-Allow-Origin: *\r\n",
                          &resp);
                      args->put_Response(resp.Get());
                      s.resource_latencies.push_back(ElapsedMs(s.t_env_request));
                      return S_OK;
                    }).Get(),
                &tok);

            // 4. WebMessageReceived counter.
            s.webview->add_WebMessageReceived(
                Callback<ICoreWebView2WebMessageReceivedEventHandler>(
                    [&s](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs*) -> HRESULT {
                      s.messageCount.fetch_add(1, std::memory_order_relaxed);
                      return S_OK;
                    }).Get(),
                &tok);

            // 5. PermissionRequested counter — silent grant.
            s.webview->add_PermissionRequested(
                Callback<ICoreWebView2PermissionRequestedEventHandler>(
                    [&s](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) -> HRESULT {
                      args->put_State(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                      s.permissionEvents.fetch_add(1, std::memory_order_relaxed);
                      return S_OK;
                    }).Get(),
                &tok);

            // NavigationCompleted handler.
            s.webview->add_NavigationCompleted(
                Callback<ICoreWebView2NavigationCompletedEventHandler>(
                    [&s](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs*) -> HRESULT {
                      s.navigation_ms = ElapsedMs(s.t_navigate_request);
                      s.navigationCompleted = true;
                      std::fprintf(stderr, "SPIKE: navigation_done ms=%.2f\n", s.navigation_ms);
                      StartStress(s);
                      return S_OK;
                    }).Get(),
                &tok);

            StartNavigate(s);
            return S_OK;
          }).Get());
  return hr;
}

void StartNavigate(Spike& s) {
  // Embed HTML via NavigateToString. We mount fetch base via document.baseURI =
  // any synthetic origin so WebResourceRequested fires for the stress URLs.
  std::wstring page = L"<base href=\"https://spike.invalid/\">";
  std::string utf8 = kSpikeHtml;
  std::wstring html(utf8.begin(), utf8.end());
  s.t_navigate_request = SteadyClock::now();
  HRESULT hr = s.webview->NavigateToString((page + html).c_str());
  if (FAILED(hr)) Fail(s, "NavigateToString", hr);
}

void StartStress(Spike& s) {
  if (s.stress_started) return;
  s.stress_started = true;

  // 3. Resource stress.
  s.webview->ExecuteScript(
      L"window.__startResourceStress(100).then(ms => window.chrome.webview.postMessage('rs:' + ms))",
      Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
          [](HRESULT, LPCWSTR) -> HRESULT { return S_OK; }).Get());

  // 4. Message stress.
  s.webview->ExecuteScript(
      L"window.__startMessageStress(500)",
      Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
          [](HRESULT, LPCWSTR) -> HRESULT { return S_OK; }).Get());

  // 5. Permission request.
  s.webview->ExecuteScript(
      L"window.__requestPermission()",
      Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
          [](HRESULT, LPCWSTR) -> HRESULT { return S_OK; }).Get());
}

LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_DESTROY) { PostQuitMessage(0); return 0; }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

double Percentile(std::vector<double> v, double p) {
  if (v.empty()) return 0;
  std::sort(v.begin(), v.end());
  size_t idx = std::min<size_t>(v.size() - 1, static_cast<size_t>(v.size() * p));
  return v[idx];
}

}  // namespace

int main() {
  HRESULT co_hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
  if (FAILED(co_hr)) {
    std::fprintf(stderr, "SPIKE: CoInitializeEx failed hr=0x%08x\n", static_cast<unsigned>(co_hr));
    return 1;
  }

  Spike spike;

  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = WndProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.lpszClassName = kClassName;
  RegisterClassExW(&wc);

  spike.hwnd = CreateWindowExW(
      0, kClassName, L"webview2-spike", WS_OVERLAPPEDWINDOW,
      CW_USEDEFAULT, CW_USEDEFAULT, 800, 600, nullptr, nullptr, wc.hInstance, nullptr);
  ShowWindow(spike.hwnd, SW_HIDE);  // headless

  // Environment.
  spike.t_env_request = SteadyClock::now();
  HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(
      nullptr, nullptr, nullptr,
      Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
          [&spike](HRESULT cr, ICoreWebView2Environment* env) -> HRESULT {
            return OnEnvironmentCreated(spike, cr, env);
          }).Get());
  if (FAILED(hr)) {
    std::fprintf(stderr, "SPIKE: FAIL bootstrap hr=0x%08x\n", static_cast<unsigned>(hr));
    CoUninitialize();
    return 1;
  }

  // Cooperative pump loop. Budget: 10 s total.
  // Arm A: Sleep(1) — busy-ish wake at ~1kHz.
  // Arm B (after Arm A drains): MsgWaitForMultipleObjects(QS_ALLEVENTS, INFINITE) — event-driven wake.
  auto t_pump_start = SteadyClock::now();
  size_t loop_iters = 0;
  size_t arm_b_iters = 0;
  bool arm_b = false;
  auto t_arm_b_start = SteadyClock::now();
  while (true) {
    if (!PumpOnce()) break;
    loop_iters++;
    if (arm_b) arm_b_iters++;

    bool done = spike.navigationCompleted && spike.messageCount >= 500 &&
                spike.resource_latencies.size() >= 100;

    if (done && !arm_b) {
      // Switch to Arm B for an additional 2 s idle measurement, posting a heartbeat
      // every 250 ms via SetTimer so we can count wake-ups without busy looping.
      arm_b = true;
      arm_b_iters = 0;
      t_arm_b_start = SteadyClock::now();
      SetTimer(spike.hwnd, /*id*/1, 250, nullptr);
    }

    if (arm_b && ElapsedMs(t_arm_b_start) > 2000.0) {
      KillTimer(spike.hwnd, 1);
      break;
    }
    if (!arm_b && ElapsedMs(t_pump_start) > 10000.0) {
      std::fprintf(stderr, "SPIKE: TIMEOUT after %.0f ms\n", ElapsedMs(t_pump_start));
      break;
    }

    if (arm_b) {
      MsgWaitForMultipleObjects(0, nullptr, FALSE, INFINITE, QS_ALLEVENTS);
    } else {
      Sleep(1);
    }
  }

  // Report.
  std::fprintf(stderr, "SPIKE: ---- results ----\n");
  std::fprintf(stderr, "SPIKE: env_ms=%.2f controller_ms=%.2f navigation_ms=%.2f\n",
                spike.env_ms, spike.controller_ms, spike.navigation_ms);
  std::fprintf(stderr, "SPIKE: armA(Sleep1) pump_iters=%zu elapsed=%.0fms\n",
                loop_iters - arm_b_iters, ElapsedMs(t_pump_start) - 2000.0);
  std::fprintf(stderr, "SPIKE: armB(MsgWait) idle_iters=%zu / 2000ms (lower=better)\n",
                arm_b_iters);
  std::fprintf(stderr, "SPIKE: resource_count=%zu p50=%.2f p95=%.2f p99=%.2f\n",
                spike.resource_latencies.size(),
                Percentile(spike.resource_latencies, 0.5),
                Percentile(spike.resource_latencies, 0.95),
                Percentile(spike.resource_latencies, 0.99));
  std::fprintf(stderr, "SPIKE: messages=%d / 500 expected\n", spike.messageCount.load());
  std::fprintf(stderr, "SPIKE: permission_events=%d\n", spike.permissionEvents.load());

  bool pass = spike.navigationCompleted &&
              spike.resource_latencies.size() == 100 &&
              spike.messageCount >= 500 &&
              spike.lastError == S_OK;

  std::fprintf(stderr, "SPIKE: verdict=%s\n", pass ? "PASS" : "FAIL");

  if (spike.controller) spike.controller->Close();
  DestroyWindow(spike.hwnd);
  // Drain so Close() completion handlers run.
  auto t_drain = SteadyClock::now();
  while (ElapsedMs(t_drain) < 500.0) { if (!PumpOnce()) break; Sleep(1); }

  spike.controller.Reset();
  spike.webview.Reset();
  spike.env.Reset();
  CoUninitialize();
  return pass ? 0 : 2;
}
