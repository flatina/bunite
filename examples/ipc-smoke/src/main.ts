import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BrowserView, BrowserWindow, Utils, app } from "bunite-core";

type IPCSmokeSchema = {
  bun: {
    requests: {
      ping: {
        params: {
          value: string;
        };
        response: {
          pong: string;
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

export const smokeState = {
  pingCount: 0,
  lastPing: "",
  lastNavigation: "",
  blockedAttemptSeen: false,
  blockedNavigationSeen: false,
  okNavigationSeen: false,
  messageBoxResponseOk: false,
  devToolsCycleAttempted: false,
  minimizeResizeSeen: false,
  minimizeReadbackOk: false,
  restoreFromMinimizeSeen: false,
  restoreFromMinimizeReadbackOk: false,
  maximizeResizeSeen: false,
  maximizeReadbackOk: false,
  restoreResizeSeen: false,
  restoreReadbackOk: false,
  popupSeen: false,
  popupUrl: ""
};

function resolveRendererRoot() {
  const candidate = fileURLToPath(new URL("../dist/renderer", import.meta.url));
  if (!existsSync(candidate)) {
    throw new Error("ipc-smoke renderer bundle is missing. Run `bun run prepare:renderer` first.");
  }
  return candidate;
}

async function waitForCondition(check: () => boolean, timeoutMs = 1_500, intervalMs = 25) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return check();
}

const rpc = BrowserView.defineRPC<IPCSmokeSchema>({
  handlers: {
    requests: {
      ping({ value }) {
        smokeState.pingCount += 1;
        smokeState.lastPing = value;
        return { pong: `pong:${value}` };
      }
    }
  }
});

await app.init();

const appresRoot = resolveRendererRoot();
const preload = fileURLToPath(new URL("../dist/renderer/main/preload.js", import.meta.url));

const win = new BrowserWindow({
  title: "bunite ipc smoke",
  titleBarStyle: "hidden",
  url: "appres://main/index.html",
  appresRoot,
  preload,
  rpc,
  // navigationRules are last-match-wins; prepend ^* when you want an allowlist.
  navigationRules: ["^*", "appres://main/*", "^appres://main/rpc-blocked.html*"]
});

let messageBoxRequested = false;

win.webview.on("will-navigate", (event) => {
  const detail = String((event as { data?: { detail?: string } }).data?.detail ?? "");
  if (detail.includes("rpc-blocked.html")) {
    smokeState.blockedAttemptSeen = true;
    console.log("[ipc-smoke] blocked navigation attempted", detail);
  }
});

win.webview.on("dom-ready", (event) => {
  const detail = String((event as { data?: { detail?: string } }).data?.detail ?? "");
  if (messageBoxRequested || !detail.includes("index.html")) {
    return;
  }

  messageBoxRequested = true;
  smokeState.devToolsCycleAttempted = true;
  win.webview.openDevTools();
  setTimeout(() => {
    win.webview.closeDevTools();
  }, 250);
  void Utils.showMessageBox({
    type: "question",
    title: "bunite browser dialog",
    message: "Confirm browser-side message box wiring",
    detail: "ipc-smoke should auto-accept this dialog from the renderer.",
    buttons: ["Proceed", "Cancel"],
    defaultId: 0,
    cancelId: 1
  }).then(({ response }) => {
    smokeState.messageBoxResponseOk = response === 0;
    console.log("[ipc-smoke] message box response", response);
  });
});

win.webview.on("did-navigate", (event) => {
  const detail = String((event as { data?: { detail?: string } }).data?.detail ?? "");
  smokeState.lastNavigation = detail;
  if (detail.includes("rpc-blocked.html")) {
    smokeState.blockedNavigationSeen = true;
  }
  if (detail.includes("rpc-ok.html")) {
    smokeState.okNavigationSeen = true;
    console.log("[ipc-smoke] renderer navigation", detail);
  }
});

win.webview.on("new-window-open", (event) => {
  const detail = (event as { data?: { detail?: string | { url?: string } } }).data?.detail;
  const popupUrl =
    typeof detail === "string" ? detail : String(detail?.url ?? "");

  smokeState.popupUrl = popupUrl;
  if (popupUrl.includes("popup-target.html")) {
    smokeState.popupSeen = true;
    console.log("[ipc-smoke] popup event", popupUrl);
  }
});

win.on("resize", (event) => {
  const data = (event as {
    data?: { maximized?: boolean; minimized?: boolean; width?: number; height?: number };
  }).data;
  if (!data) {
    return;
  }

  if (data.minimized) {
    smokeState.minimizeResizeSeen = true;
    console.log("[ipc-smoke] window minimized");
    return;
  }

  if (smokeState.minimizeResizeSeen && !smokeState.restoreFromMinimizeSeen) {
    smokeState.restoreFromMinimizeSeen = true;
    console.log("[ipc-smoke] window restored from minimize", {
      width: data.width ?? 0,
      height: data.height ?? 0
    });
  }

  if (data.maximized) {
    smokeState.maximizeResizeSeen = true;
    console.log("[ipc-smoke] window maximized", {
      width: data.width ?? 0,
      height: data.height ?? 0
    });
    return;
  }

  if (smokeState.maximizeResizeSeen) {
    smokeState.restoreResizeSeen = true;
    console.log("[ipc-smoke] window restored", {
      width: data.width ?? 0,
      height: data.height ?? 0
    });
  }
});

win.show();
void (async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  win.maximize();
  smokeState.maximizeReadbackOk = await waitForCondition(
    () => smokeState.maximizeResizeSeen && win.isMaximized()
  );
  win.unmaximize();
  smokeState.restoreReadbackOk = await waitForCondition(
    () => smokeState.restoreResizeSeen && !win.isMaximized()
  );
  win.minimize();
  smokeState.minimizeReadbackOk = await waitForCondition(
    () => smokeState.minimizeResizeSeen && win.isMinimized()
  );
  win.unminimize();
  smokeState.restoreFromMinimizeReadbackOk = await waitForCondition(
    () => smokeState.restoreFromMinimizeSeen && !win.isMinimized()
  );
})();

console.log("[ipc-smoke] initialized", {
  usingStub: app.runtime?.usingStub ?? true,
  webviewId: win.webviewId,
  appresRoot
});

app.run();
