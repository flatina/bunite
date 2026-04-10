import "dockview-core/dist/styles/dockview.css";
import {
  createDockview,
  themeAbyss,
  type DockviewApi,
  type GroupPanelPartInitParameters,
  type IContentRenderer
} from "dockview-core";
import "./styles.css";
import { setupDropIndicatorMasks } from "./maskHelper";

const fixtures = [
  { id: "counter", title: "Counter" },
  { id: "form", title: "Form" },
  { id: "list", title: "List" }
] as const;

declare global {
  interface Window {
    bunite?: { invoke: (method: string, params?: unknown) => Promise<unknown> };
  }
}

const root = document.getElementById("app")!;
const shell = document.createElement("div");
shell.className = "dockview-shell";
root.append(shell);

let demoOrigin = "";
let api: DockviewApi;

void bootstrap().catch((e) => {
  root.innerHTML = `<pre class="fatal">${String(e)}</pre>`;
});

// --- Panel ---
// Visibility is managed automatically: dockview sets display:none on hidden
// panels, which makes getBoundingClientRect() return zeros, and
// <bunite-webview>'s OverlaySyncController auto-hides the native surface.

class BrowserPanel implements IContentRenderer {
  readonly element = document.createElement("div");

  constructor() {
    this.element.className = "browser-panel";
  }

  init(params: GroupPanelPartInitParameters) {
    const source = (params.params as { source?: string })?.source ?? "/counter.html";
    const wv = document.createElement("bunite-webview");
    wv.className = "browser-panel__surface";
    wv.setAttribute("src", `${demoOrigin}${source}`);
    this.element.append(wv);
  }
}

// --- Bootstrap ---

async function bootstrap() {
  const invoke = window.bunite?.invoke;
  if (!invoke) throw new Error("bunite runtime not available");

  const config = (await invoke("dockviewBrowser.getConfig")) as { demoOrigin: string };
  demoOrigin = config.demoOrigin;

  renderToolbar();

  api = createDockview(shell, {
    theme: themeAbyss,
    disableFloatingGroups: true,
    createComponent: () => new BrowserPanel()
  });

  createDefaultLayout();
  setupDropIndicatorMasks();
}

function renderToolbar() {
  const bar = document.createElement("header");
  bar.className = "topbar";
  bar.innerHTML = "<strong>dockview-browser</strong>";

  for (const f of fixtures) {
    const btn = document.createElement("button");
    btn.textContent = `+ ${f.title}`;
    btn.addEventListener("click", () => {
      const ref = api.activePanel;
      api.addPanel({
        id: `p_${crypto.randomUUID()}`,
        component: "browser",
        title: f.title,
        params: { source: `/${f.id}.html` },
        position: ref ? { referencePanel: ref, direction: "right" } : undefined
      });
    });
    bar.append(btn);
  }

  const reset = document.createElement("button");
  reset.textContent = "Reset";
  reset.addEventListener("click", () => { api.clear(); createDefaultLayout(); });
  bar.append(reset);

  root.prepend(bar);
}

function createDefaultLayout() {
  const left = api.addPanel({
    id: `p_${crypto.randomUUID()}`,
    component: "browser",
    title: "Counter",
    params: { source: "/counter.html" }
  });

  api.addPanel({
    id: `p_${crypto.randomUUID()}`,
    component: "browser",
    title: "Form",
    params: { source: "/form.html" },
    position: { referencePanel: left, direction: "right" }
  });

  api.addPanel({
    id: `p_${crypto.randomUUID()}`,
    component: "browser",
    title: "List",
    params: { source: "/list.html" },
    position: { referencePanel: left, direction: "below" }
  });

  left.group.api.setSize({ width: 500 });
}
