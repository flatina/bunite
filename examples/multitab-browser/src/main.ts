import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { BrowserView, BrowserWindow, app } from "bunite-core";

process.env.BUNITE_REMOTE_DEBUGGING_PORT ??= "9222";

const SHELL_HEIGHT = 64;

const rendererDir = fileURLToPath(new URL("./renderer", import.meta.url));
const preload = join(rendererDir, "preload.js");

// for real web page navigation test
const localServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    const startedAt = Date.now();
    const sendPage = (title: string, body: string) =>
      new Response(
        `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { margin: 0; padding: 32px; background: #111827; color: #e5e7eb; font: 14px/1.6 system-ui, sans-serif; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    .meta { color: #93c5fd; margin-bottom: 20px; }
    a { color: #fbbf24; }
    code { color: #c4b5fd; }
  </style>
</head>
<body>
  ${body}
</body>
</html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store"
          }
        }
      );

    if (url.pathname === "/fast") {
      return sendPage(
        "Local Fast",
        `<h1>Local Fast</h1>
        <div class="meta">served in ${Date.now() - startedAt}ms</div>
        <p>Deterministic localhost page for navigation latency testing.</p>
        <p><a href="/echo?from=fast">Open another local page</a></p>`
      );
    }

    if (url.pathname === "/slow") {
      const delay = Math.max(0, Math.min(Number(url.searchParams.get("delay") ?? "1000"), 5000));
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(
            sendPage(
              `Local Slow ${delay}`,
              `<h1>Local Slow</h1>
              <div class="meta">delay ${delay}ms, total ${Date.now() - startedAt}ms</div>
              <p>This response intentionally waits before returning.</p>
              <p><a href="/fast">Go to local fast</a></p>`
            )
          );
        }, delay);
      });
    }

    if (url.pathname === "/echo") {
      const from = url.searchParams.get("from") ?? "unknown";
      return sendPage(
        "Local Echo",
        `<h1>Local Echo</h1>
        <div class="meta">from=${from}, served in ${Date.now() - startedAt}ms</div>
        <p><a href="/fast">Fast</a></p>
        <p><a href="/slow?delay=1500">Slow 1500ms</a></p>`
      );
    }

    return new Response("Not found", { status: 404 });
  }
});
const localOrigin = `http://${localServer.hostname}:${localServer.port}`;

await Bun.build({
  entrypoints: [join(rendererDir, "shell.ts")],
  outdir: rendererDir,
  target: "browser",
  naming: "[name].built.js",
});

type TabInfo = { id: number; url: string; active: boolean };

type ShellSchema = {
  bun: {
    requests: {
      createTab: { params: { url: string }; response: { tabId: number } };
      switchTab: { params: { tabId: number }; response: {} };
      closeTab: { params: { tabId: number }; response: {} };
      navigate: { params: { url: string }; response: {} };
      goBack: { params: {}; response: {} };
      reload: { params: {}; response: {} };
      getTabs: { params: {}; response: { tabs: TabInfo[] } };
    };
    messages: {
      tabsUpdated: { tabs: TabInfo[] };
    };
  };
  webview: {
    requests: {};
    messages: {};
  };
};

const tabs = new Map<number, { view: BrowserView; url: string }>();
let activeTabId: number | null = null;

function getTabList(): TabInfo[] {
  return Array.from(tabs.entries()).map(([id, tab]) => ({
    id,
    url: tab.url,
    active: id === activeTabId
  }));
}

function notifyShell() {
  shellRpc.send("tabsUpdated", { tabs: getTabList() });
}

const shellRpc = BrowserView.defineRPC<ShellSchema>({
  handlers: {
    requests: {
      createTab({ url }) {
        const tabId = createTab(url || "");
        return { tabId };
      },
      switchTab({ tabId }) {
        switchToTab(tabId);
        return {};
      },
      closeTab({ tabId }) {
        closeTab(tabId);
        return {};
      },
      navigate({ url }) {
        if (activeTabId !== null) {
          const tab = tabs.get(activeTabId);
          if (tab) {
            let resolved = url;
            if (!resolved.includes("://")) resolved = "https://" + resolved;
            tab.view.loadURL(resolved);
            tab.url = resolved;
            notifyShell();
          }
        }
        return {};
      },
      goBack() {
        if (activeTabId !== null) {
          tabs.get(activeTabId)?.view.goBack();
        }
        return {};
      },
      reload() {
        if (activeTabId !== null) {
          tabs.get(activeTabId)?.view.reload();
        }
        return {};
      },
      getTabs() {
        return { tabs: getTabList() };
      }
    }
  }
});

// Global IPC — any views:// page can call bunite.invoke("getAppInfo")
app.handle("getAppInfo", () => ({
  buniteVersion: "0.0.1",
  nativeLoaded: app.runtime?.nativeLoaded ?? false,
  usingStub: app.runtime?.usingStub ?? true,
  tabCount: tabs.size,
  platform: process.platform,
  localOrigin
}));

function createTab(url: string): number {
  const isViews = !url || url.startsWith("views://");
  const view = new BrowserView({
    url: !url ? "views://newtab" : url,
    viewsRoot: isViews ? rendererDir : undefined,
    windowPtr: win.ptr,
    autoResize: false,
    windowId: win.id
  });

  view.setAnchor("below-top", SHELL_HEIGHT);
  view.setVisible(false);
  const tabId = view.id;
  tabs.set(tabId, { view, url: url || "New Tab" });

  view.on("did-navigate", (event: unknown) => {
    const detail = (event as { data?: { detail?: string } })?.data?.detail;
    const tab = tabs.get(tabId);
    if (tab && detail) {
      tab.url = detail;
      notifyShell();
    }
  });

  view.on("new-window-open", (event: unknown) => {
    const data = (event as { data?: { detail?: string | { url: string } } })?.data?.detail;
    const popupUrl = typeof data === "string" ? data : data?.url;
    if (popupUrl) {
      const newId = createTab(popupUrl);
      switchToTab(newId);
    }
  });

  switchToTab(tabId);
  return tabId;
}

function switchToTab(tabId: number) {
  if (!tabs.has(tabId)) return;
  for (const [id, tab] of tabs) {
    tab.view.setVisible(id === tabId);
  }
  activeTabId = tabId;
  notifyShell();
}

function closeTab(tabId: number) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  tab.view.remove();
  tabs.delete(tabId);

  if (activeTabId === tabId) {
    const remaining = Array.from(tabs.keys());
    if (remaining.length > 0) {
      switchToTab(remaining[remaining.length - 1]);
    } else {
      activeTabId = null;
      notifyShell();
    }
  } else {
    notifyShell();
  }
}

await app.init();

app.getView("newtab", () => `
  <!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      body { margin: 0; background: #202124; color: #e8eaed; font-family: system-ui, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; gap: 32px; }
      .watermark { font-size: 48px; font-weight: 200; opacity: 0.25; }
      .links { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; max-width: 640px; }
      .links a { display: flex; align-items: center; justify-content: center; width: 120px; height: 72px; background: #292b2e; border-radius: 12px; color: #9aa0a6; text-decoration: none; font-size: 12px; text-align: center; padding: 8px; word-break: break-all; }
      .links a:hover { background: #35363a; color: #e8eaed; }
      .meta { color: #9aa0a6; font-size: 12px; }
    </style>
  </head>
  <body>
    <div class="watermark">bunite</div>
    <div class="meta">local test origin: ${localOrigin}</div>
    <div class="links">
      <a href="${localOrigin}/fast">Local Fast</a>
      <a href="${localOrigin}/slow?delay=2000">Local 2000ms</a>
      <a href="views://about">About</a>
      <a href="views://global-ipc">Global IPC</a>
      <a href="https://google.com">Google</a>
    </div>
  </body>
  </html>
`);

app.getView("about", () => `
  <style>body { background: #202124; color: #e8eaed; font-family: system-ui, sans-serif; }</style>
  <h1>bunite</h1>
  <p>Uniting UI and Bun</p>
  <p>v0.0.1 &middot; ${process.platform} &middot; tabs: ${tabs.size}</p>
  <p>local test origin: ${localOrigin}</p>
  <p><a href="https://github.com/flatina/bunite">GitHub</a></p>
`);

const win = new BrowserWindow({
  title: "bunite multi-tab browser",
  frame: { x: 80, y: 80, width: 1280, height: 900 },
  url: "views://shell",
  viewsRoot: rendererDir,
  preload,
  rpc: shellRpc,
  hidden: true
});

win.webview.setAnchor("top", SHELL_HEIGHT);
win.on("close", () => {
  localServer.stop();
  app.quit();
});

win.show();
createTab("");

app.run();
