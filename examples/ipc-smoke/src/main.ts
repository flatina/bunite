import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BrowserView, BrowserWindow, app } from "bunite";

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

const viewsRoot = resolveRendererRoot();
const preload = fileURLToPath(new URL("../dist/renderer/main/preload.js", import.meta.url));

const win = new BrowserWindow({
  title: "bunite ipc smoke",
  titleBarStyle: "hidden",
  url: "views://main/index.html",
  viewsRoot,
  preload,
  rpc,
  // navigationRules are last-match-wins; prepend ^* when you want an allowlist.
  navigationRules: ["^*", "views://main/*", "^views://main/rpc-blocked.html*"]
});

win.webview.on("will-navigate", (event) => {
  const detail = String((event as { data?: { detail?: string } }).data?.detail ?? "");
  if (detail.includes("rpc-blocked.html")) {
    smokeState.blockedAttemptSeen = true;
    console.log("[ipc-smoke] blocked navigation attempted", detail);
  }
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

win.show();
console.log("[ipc-smoke] initialized", {
  usingStub: app.runtime?.usingStub ?? true,
  webviewId: win.webviewId,
  viewsRoot
});

app.run();
