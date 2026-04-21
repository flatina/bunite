import "bunite-core/webview-polyfill";
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

const shell = document.querySelector<HTMLElement>(".dockview-shell")!;
const panelTpl = document.getElementById("browser-panel-tpl") as HTMLTemplateElement;

let demoOrigin = "";
let api: DockviewApi;

// --- Panel ---

class BrowserPanel implements IContentRenderer {
  readonly element = document.createElement("div");

  constructor() {
    this.element.className = "browser-panel";
  }

  init(params: GroupPanelPartInitParameters) {
    const source = (params.params as { source?: string })?.source ?? "/counter.html";
    const fullUrl = `${demoOrigin}${source}`;

    this.element.append(panelTpl.content.cloneNode(true));

    const urlInput = this.element.querySelector<HTMLInputElement>(".browser-nav__url")!;
    const wv = this.element.querySelector("bunite-webview")! as HTMLElement & {
      goBack(): void; reload(): void; navigate(url: string): void;
    };
    urlInput.value = fullUrl;
    wv.setAttribute("src", fullUrl);

    this.element.querySelector('[data-action="back"]')!.addEventListener("click", () => wv.goBack());
    this.element.querySelector('[data-action="reload"]')!.addEventListener("click", () => wv.reload());
    urlInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      let url = urlInput.value.trim();
      if (!url) return;
      if (!url.includes("://")) url = `https://${url}`;
      wv.navigate(url);
    });
    wv.addEventListener("did-navigate", ((e: CustomEvent<{ url: string }>) => {
      urlInput.value = e.detail.url;
    }) as EventListener);
  }
}

// --- Bootstrap ---

async function bootstrap() {
  demoOrigin = location.origin;

  document.querySelectorAll<HTMLButtonElement>("[data-fixture]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.fixture!;
      const ref = api.activePanel;
      api.addPanel({
        id: `p_${crypto.randomUUID()}`,
        component: "browser",
        title: id[0].toUpperCase() + id.slice(1),
        params: { source: `/${id}.html` },
        position: ref ? { referencePanel: ref, direction: "right" } : undefined
      });
    });
  });

  document.querySelector('[data-action="reset"]')!.addEventListener("click", () => {
    api.clear();
    createDefaultLayout();
  });

  api = createDockview(shell, {
    theme: themeAbyss,
    disableFloatingGroups: true,
    // up/down/within splits re-parent panel content and would tear down native webview surfaces — "always" keeps panels in a shared overlay container and repositions via style.
    defaultRenderer: "always",
    createComponent: () => new BrowserPanel()
  });

  createDefaultLayout();
  setupDropIndicatorMasks();
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

void bootstrap().catch((e) => {
  document.getElementById("app")!.innerHTML = `<pre class="fatal">${String(e)}</pre>`;
});
