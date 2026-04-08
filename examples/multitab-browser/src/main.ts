import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { BrowserView, BrowserWindow, app } from "bunite-core";
import { localServer, localOrigin } from "./localServer";

process.env.BUNITE_REMOTE_DEBUGGING_PORT ??= "9222";

const SHELL_HEIGHT = 64;

const rendererDir = fileURLToPath(new URL("./renderer", import.meta.url));
const preload = join(rendererDir, "preload.js");

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

// Global IPC — any appres:// page can call bunite.invoke("getAppInfo")
app.handle("getAppInfo", () => ({
  buniteVersion: "0.0.1",
  nativeLoaded: app.runtime?.nativeLoaded ?? false,
  usingStub: app.runtime?.usingStub ?? true,
  tabCount: tabs.size,
  platform: process.platform,
  localOrigin
}));

function createTab(url: string): number {
  const isViews = !url || url.startsWith("appres://");
  const view = new BrowserView({
    url: !url ? "appres://newtab" : url,
    appresRoot: isViews ? rendererDir : undefined,
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

app.getAppRes("newtab", () => `
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
      <a href="appres://about">About</a>
      <a href="appres://global-ipc">Global IPC</a>
      <a href="https://google.com">Google</a>
    </div>
  </body>
  </html>
`);

app.getAppRes("about", () => `
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
  url: "appres://shell",
  appresRoot: rendererDir,
  preload,
  rpc: shellRpc,
  hidden: true
});

win.webview.setAnchor("top", SHELL_HEIGHT);

// --- Quit confirmation overlay dialog ---
const DIALOG_W = 360;
const DIALOG_H = 160;
let quitConfirmOpen = false;
let quitDialogView: BrowserView | null = null;

const resDir = fileURLToPath(new URL("./res", import.meta.url));
const quitDialogHtml = await Bun.file(join(resDir, "quit-dialog.html")).text();

app.handle("quitDialogResponse", (params: unknown) => {
  const { action } = params as { action: string };
  quitConfirmOpen = false;
  if (quitDialogView) {
    quitDialogView.remove();
    quitDialogView = null;
  }
  if (action === "quit") {
    win.destroy();
  }
  return {};
});

win.on("close-requested", (event: any) => {
  if (quitConfirmOpen) {
    event.response = { allow: false };
    return;
  }
  event.response = { allow: false };
  quitConfirmOpen = true;

  const { width } = win.getFrame();
  const dialogX = Math.round((width - DIALOG_W) / 2);
  const dialogY = 20;

  quitDialogView = new BrowserView({
    html: quitDialogHtml,
    windowId: win.id,
    autoResize: false,
    appresRoot: rendererDir,
  });
  quitDialogView.setBounds(dialogX, dialogY, DIALOG_W, DIALOG_H);
  quitDialogView.bringToFront();
});

win.on("close", () => {
  localServer.stop();
});

win.show();
createTab("");

app.run();
