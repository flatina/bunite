import "bunite-core/webview-polyfill";
import "./styles.css";
import { BuniteView, defineWebviewRpc, type RpcSchema } from "bunite-core/view";

type MultitabRpcSchema = {
  bun: RpcSchema<{
    requests: {
      getQuickLinks: { params: undefined; response: { url: string; label: string }[] };
      createTab: { params: { url?: string }; response: { id: string; url: string; title: string } };
      closeTab: { params: { id: string }; response: void };
      navigateTo: { params: { id: string; url: string }; response: void };
    };
  }>;
  webview: RpcSchema;
};

type Tab = { id: string; webview: HTMLElement; url: string; title: string };

const tabBar = document.getElementById("tab-bar")!;
const newTabBtn = document.getElementById("new-tab-btn")!;
const urlInput = document.getElementById("url-input") as HTMLInputElement;
const content = document.getElementById("content")!;

const tabs = new Map<string, Tab>();
let activeId: string | null = null;

const rpc = defineWebviewRpc<MultitabRpcSchema>({ handlers: {} });
new BuniteView({ rpc });

newTabBtn.addEventListener("click", () => createTab());
document.querySelector('[data-action="back"]')!.addEventListener("click", () => activeWebview()?.goBack());
document.querySelector('[data-action="reload"]')!.addEventListener("click", () => activeWebview()?.reload());
urlInput.addEventListener("keydown", e => { if (e.key === "Enter") navigate(); });

createTab();

async function createTab(url?: string) {
  const tab = await rpc.requestProxy.createTab({ url });

  const webview = document.createElement("bunite-webview") as HTMLElement & { goBack(): void; reload(): void };
  webview.setAttribute("src", tab.url);
  webview.hidden = true;
  content.appendChild(webview);

  webview.addEventListener("did-navigate", ((e: CustomEvent<{ url: string }>) => {
    const t = tabs.get(tab.id);
    if (t) {
      t.url = e.detail.url;
      rpc.requestProxy.navigateTo({ id: tab.id, url: e.detail.url });
      renderTabs();
    }
  }) as EventListener);

  tabs.set(tab.id, { id: tab.id, webview, url: tab.url, title: tab.title });
  switchTo(tab.id);
}

function switchTo(id: string) {
  if (!tabs.has(id)) return;
  for (const [tid, tab] of tabs) tab.webview.hidden = tid !== id;
  activeId = id;
  renderTabs();
}

async function closeTab(id: string) {
  const tab = tabs.get(id);
  if (!tab) return;
  await rpc.requestProxy.closeTab({ id });
  tab.webview.remove();
  tabs.delete(id);
  if (activeId === id) {
    const remaining = [...tabs.keys()];
    if (remaining.length > 0) switchTo(remaining[remaining.length - 1]);
    else { activeId = null; renderTabs(); }
  } else {
    renderTabs();
  }
}

function navigate() {
  let url = urlInput.value.trim();
  if (!url) return;
  if (!url.includes("://")) url = "https://" + url;
  if (activeId != null) {
    const tab = tabs.get(activeId);
    if (tab) {
      tab.webview.setAttribute("src", url);
      tab.url = url;
      rpc.requestProxy.navigateTo({ id: activeId, url });
      renderTabs();
      return;
    }
  }
  createTab(url);
}

function activeWebview(): any {
  return activeId != null ? tabs.get(activeId)?.webview : null;
}

function shortUrl(url: string): string {
  if (!url || url.endsWith("/newtab.html")) return "New Tab";
  try { const u = new URL(url); return u.hostname + (u.pathname !== "/" ? u.pathname : ""); }
  catch { return url; }
}

function renderTabs() {
  tabBar.querySelectorAll(".tab").forEach(el => el.remove());
  for (const [id, tab] of tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (id === activeId ? " active" : "");

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = shortUrl(tab.url);

    const close = document.createElement("span");
    close.className = "tab-close";
    close.textContent = "\u00d7";

    el.append(label, close);
    tabBar.insertBefore(el, newTabBtn);

    el.addEventListener("click", e => {
      if ((e.target as HTMLElement).closest(".tab-close")) closeTab(id);
      else switchTo(id);
    });

    if (id === activeId) urlInput.value = tab.url.endsWith("/newtab.html") ? "" : tab.url;
  }
}
