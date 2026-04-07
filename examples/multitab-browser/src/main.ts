import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { BrowserView, BrowserWindow, app } from "bunite";

const SHELL_HEIGHT = 64;

const rendererDir = fileURLToPath(new URL("./renderer", import.meta.url));
const preload = join(rendererDir, "preload.js");

await Bun.build({
  entrypoints: [join(rendererDir, "shell.ts"), join(rendererDir, "status.ts")],
  outdir: rendererDir,
  target: "browser",
  naming: "[name].js",
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

function createContentRpc() {
  return BrowserView.defineRPC<ContentSchema>({
    handlers: {
      requests: {
        getAppInfo() {
          return {
            buniteVersion: "0.0.1",
            nativeLoaded: app.runtime?.nativeLoaded ?? false,
            usingStub: app.runtime?.usingStub ?? true,
            tabCount: tabs.size,
            platform: process.platform
          };
        }
      }
    }
  });
}

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

function createTab(url: string): number {
  const isViews = !url || url.startsWith("views://");
  const view = new BrowserView({
    url: !url ? "views://newtab.html" : url,
    viewsRoot: isViews ? rendererDir : undefined,
    rpc: isViews ? createContentRpc() : undefined,
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

const win = new BrowserWindow({
  title: "bunite multi-tab browser",
  frame: { x: 80, y: 80, width: 1280, height: 900 },
  url: "views://shell.html",
  viewsRoot: rendererDir,
  preload,
  rpc: shellRpc,
  hidden: true
});

win.webview.setAnchor("top", SHELL_HEIGHT);
win.on("close", () => app.quit());

win.show();
createTab("");

app.run();
