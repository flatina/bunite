import { join } from "node:path";
import { AppRuntime, BrowserWindow, serveWeb, type ImplOf } from "bunite-core";
import { schema, apiCap, type QuickLink, type TabInfo } from "./schema";

process.env.BUNITE_REMOTE_DEBUGGING_PORT ??= "9222";

const app = new AppRuntime({ logLevel: "info" });
await app.ready;

const webPort = Number(process.argv[process.argv.indexOf("--web-port") + 1]) || 0;
const rendererDir = app.resolve("../dist/renderer");

const tabs = new Map<string, TabInfo>();
let nextTabId = 1;
let origin = "";

function quickLinks(): QuickLink[] {
  return [
    { url: `${origin}/fast`, label: "Local Fast" },
    { url: `${origin}/slow?delay=2000`, label: "Local 2s" },
    { url: "https://google.com", label: "Google" },
    { url: "https://github.com", label: "GitHub" },
  ];
}

const apiImpl: ImplOf<typeof apiCap> = {
  getQuickLinks: () => quickLinks(),
  createTab: ({ url }) => {
    const id = `tab-${nextTabId++}`;
    const tab: TabInfo = { id, url: url || `${origin}/newtab.html`, title: "New Tab" };
    tabs.set(id, tab);
    return tab;
  },
  closeTab: ({ id }) => { tabs.delete(id); },
  navigateTo: ({ id, url }) => {
    const tab = tabs.get(id);
    if (tab) tab.url = url;
  },
};

const descriptor = schema.serve({ api: apiImpl });
const webRpc = serveWeb(descriptor);

const server = Bun.serve({
  port: webPort || 0,
  hostname: webPort ? "0.0.0.0" : "127.0.0.1",
  async fetch(req, srv) {
    const rpc = webRpc.fetch(req, srv);
    if (rpc !== undefined) return rpc;

    const url = new URL(req.url);
    if (url.pathname === "/fast")
      return html("Local Fast", `<p>served instantly</p><p><a href="/slow?delay=2000">Slow 2s</a></p>`);
    if (url.pathname === "/slow") {
      const delay = Math.min(Number(url.searchParams.get("delay") ?? "1000"), 5000);
      return new Promise<Response>((r) => setTimeout(() => r(html("Local Slow", `<p>waited ${delay}ms</p><p><a href="/fast">Fast</a></p>`)), delay));
    }

    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes("..")) return new Response("Forbidden", { status: 403 });
    const file = Bun.file(join(rendererDir, pathname === "/" ? "index.html" : pathname.slice(1)));
    if (!(await file.exists())) return new Response("Not Found", { status: 404 });
    return new Response(file);
  },
  websocket: webRpc.websocket,
});

origin = `http://127.0.0.1:${server.port}`;

const win = new BrowserWindow({
  title: `bunite multi-tab browser v${app.version} — ${app.engineName ?? "?"} ${app.engineVersion ?? "unknown"}`,
  frame: { x: 80, y: 80, width: 1280, height: 900 },
  url: `${origin}/`,
  preloadOrigins: [origin],
  serve: descriptor,
});

win.on("close", () => server.stop(true));

app.run();

function html(title: string, body: string) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
    <style>body{margin:0;padding:32px;background:#111827;color:#e5e7eb;font:14px/1.6 system-ui}h1{margin:0 0 8px}a{color:#fbbf24}</style>
    </head><body><h1>${title}</h1>${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}
