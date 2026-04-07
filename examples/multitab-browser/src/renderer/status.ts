import { BuniteView } from "bunite/view";

type ContentSchema = {
  bun: {
    requests: {
      getAppInfo: {
        params: {};
        response: {
          buniteVersion: string;
          nativeLoaded: boolean;
          usingStub: boolean;
          tabCount: number;
          platform: string;
        };
      };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {};
  };
};

const rpc = BuniteView.defineRPC<ContentSchema>({
  handlers: { requests: {} }
});

const view = new BuniteView({ rpc });

const browserRows: [string, string][] = [
  ["User Agent", navigator.userAgent],
  ["Platform", navigator.platform],
  ["Language", navigator.language],
  ["Screen", `${screen.width} x ${screen.height}`],
  ["Window", `${window.innerWidth} x ${window.innerHeight}`],
  ["Device Pixel Ratio", String(window.devicePixelRatio)],
  ["Cookies Enabled", String(navigator.cookieEnabled)],
  ["Online", String(navigator.onLine)],
  ["Webview ID", String((window as any).__buniteWebviewId ?? "N/A")],
];

function render(browserId: string, appId: string, rows: [string, string][]) {
  const table = document.getElementById(browserId)!;
  for (const [k, v] of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${k}</td><td>${v}</td>`;
    table.appendChild(tr);
  }
}

render("browser-info", "", browserRows);

async function loadAppInfo() {
  if (!view.bunSocket) return;
  if (view.bunSocket.readyState !== WebSocket.OPEN) {
    await new Promise<void>(r =>
      view.bunSocket!.addEventListener("open", () => r(), { once: true })
    );
  }

  try {
    const info = await rpc.request("getAppInfo", {});
    render("app-info", "", [
      ["Bunite Version", info.buniteVersion],
      ["Native Loaded", String(info.nativeLoaded)],
      ["Using Stub", String(info.usingStub)],
      ["Open Tabs", String(info.tabCount)],
      ["OS Platform", info.platform],
    ]);
  } catch (e) {
    document.getElementById("app-info")!.innerHTML =
      `<tr><td colspan="2" style="color:#f28b82">Failed to load app info: ${e}</td></tr>`;
  }
}

loadAppInfo();
