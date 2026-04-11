import "./styles.css";

declare global {
  interface Window {
    bunite?: { invoke: (method: string, params?: unknown) => Promise<unknown> };
  }
}

type Tab = { id: number; webview: HTMLElement; url: string };

const tabBar = document.getElementById("tab-bar")!;
const newTabBtn = document.getElementById("new-tab-btn")!;
const urlInput = document.getElementById("url-input") as HTMLInputElement;
const content = document.getElementById("content")!;

const tabs = new Map<number, Tab>();
let nextId = 1;
let activeId: number | null = null;
let localOrigin = "";

void bootstrap().catch(e => {
  document.body.innerHTML = `<pre style="color:#ff6b6b;padding:32px">${e}</pre>`;
});

async function bootstrap() {
  const invoke = window.bunite?.invoke;
  if (!invoke) throw new Error("bunite runtime not available");

  const config = (await invoke("multitabBrowser.getConfig")) as { localOrigin: string };
  localOrigin = config.localOrigin;

  newTabBtn.addEventListener("click", () => createTab(""));
  document.querySelector('[data-action="back"]')!.addEventListener("click", () => activeWebview()?.goBack());
  document.querySelector('[data-action="reload"]')!.addEventListener("click", () => activeWebview()?.reload());
  urlInput.addEventListener("keydown", e => { if (e.key === "Enter") navigate(); });

  createTab("");
}

function createTab(url: string) {
  const id = nextId++;
  const webview = document.createElement("bunite-webview") as HTMLElement & { goBack(): void; reload(): void };
  const src = url || `appres://app.internal/newtab.html`;
  webview.setAttribute("src", src);
  webview.hidden = true;
  content.appendChild(webview);

  webview.addEventListener("did-navigate", ((e: CustomEvent<{ url: string }>) => {
    const tab = tabs.get(id);
    if (tab) {
      tab.url = e.detail.url;
      renderTabs();
    }
  }) as EventListener);

  tabs.set(id, { id, webview, url: url || "New Tab" });
  switchTo(id);
}

function switchTo(id: number) {
  if (!tabs.has(id)) return;
  for (const [tid, tab] of tabs) tab.webview.hidden = tid !== id;
  activeId = id;
  renderTabs();
}

function closeTab(id: number) {
  const tab = tabs.get(id);
  if (!tab) return;
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
  if (!url || url === "New Tab") return "New Tab";
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

    if (id === activeId) urlInput.value = tab.url === "New Tab" ? "" : tab.url;
  }
}
