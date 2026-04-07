import { BuniteView } from "bunite-core/view";

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

const rpc = BuniteView.defineRPC<ShellSchema>({
  handlers: { requests: {} }
});

const view = new BuniteView({ rpc });

const tabRow = document.getElementById("tab-row")!;
const newTabBtn = document.getElementById("new-tab-btn")!;
const urlInput = document.getElementById("url-input") as HTMLInputElement;
const backBtn = document.getElementById("back-btn")!;
const refreshBtn = document.getElementById("refresh-btn")!;

rpc.addMessageListener("tabsUpdated", (payload: unknown) => {
  renderTabs((payload as { tabs: TabInfo[] }).tabs);
});

function renderTabs(tabs: TabInfo[]) {
  // Remove old tab elements (keep new-tab button)
  for (const el of Array.from(tabRow.querySelectorAll(".tab"))) {
    el.remove();
  }

  for (const tab of tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (tab.active ? " active" : "");

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = shortUrl(tab.url);

    const close = document.createElement("span");
    close.className = "tab-close";
    close.textContent = "\u00d7";

    el.append(label, close);
    tabRow.insertBefore(el, newTabBtn);

    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".tab-close")) {
        rpc.request("closeTab", { tabId: tab.id }).catch(() => {});
      } else {
        rpc.request("switchTab", { tabId: tab.id }).catch(() => {});
      }
    });

    if (tab.active) {
      urlInput.value = tab.url === "New Tab" ? "" : tab.url;
    }
  }
}

function shortUrl(url: string): string {
  if (!url || url === "New Tab") return "New Tab";
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== "/" ? u.pathname : "");
  } catch {
    return url;
  }
}

function navigateOrCreate() {
  let url = urlInput.value.trim();
  if (!url) return;
  if (!url.includes("://")) url = "https://" + url;
  const hasTabs = tabRow.querySelectorAll(".tab").length > 0;
  if (!hasTabs) {
    rpc.request("createTab", { url }).catch(() => {});
  } else {
    rpc.request("navigate", { url }).catch(() => {});
  }
}

urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") navigateOrCreate();
});
newTabBtn.addEventListener("click", () => {
  rpc.request("createTab", { url: "" }).catch(() => {});
});
backBtn.addEventListener("click", () => {
  rpc.request("goBack", {}).catch(() => {});
});
refreshBtn.addEventListener("click", () => {
  rpc.request("reload", {}).catch(() => {});
});

async function initTabs() {
  if (!view.bunSocket) return;
  if (view.bunSocket.readyState !== WebSocket.OPEN) {
    await new Promise<void>(resolve => {
      view.bunSocket!.addEventListener("open", () => resolve(), { once: true });
    });
  }
  const result = await rpc.request("getTabs", {});
  renderTabs(result.tabs);
}

initTabs().catch(() => {});

void view;
