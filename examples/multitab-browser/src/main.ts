import { join } from "node:path";
import { BrowserWindow, BrowserView, Utils, AppRuntime, type RPCSchema } from "bunite-core";

process.env.BUNITE_REMOTE_DEBUGGING_PORT ??= "9222";

const app = new AppRuntime({ logLevel: "info" });
await app.ready;

const webPort = Number(process.argv[process.argv.indexOf("--web-port") + 1]) || 0;
const rendererDir = app.resolve("../dist/renderer");

type MultitabRPCSchema = {
  bun: RPCSchema<{
    requests: {
      getQuickLinks: { params: undefined; response: { url: string; label: string }[] };
      createTab: { params: { url?: string }; response: { id: string; url: string; title: string } };
      closeTab: { params: { id: string }; response: void };
      navigateTo: { params: { id: string; url: string }; response: void };
    };
  }>;
  webview: RPCSchema;
};

const tabs = new Map<string, { id: string; url: string; title: string }>();
let nextTabId = 1;
let origin = "";

const rpcHandlers = {
  getQuickLinks: () => [
    { url: `${origin}/fast`, label: "Local Fast" },
    { url: `${origin}/slow?delay=2000`, label: "Local 2s" },
    { url: "https://google.com", label: "Google" },
    { url: "https://github.com", label: "GitHub" }
  ],
  createTab: ({ url }: { url?: string }) => {
    const id = `tab-${nextTabId++}`;
    const tab = { id, url: url || `${origin}/newtab.html`, title: "New Tab" };
    tabs.set(id, tab);
    return tab;
  },
  closeTab: ({ id }: { id: string }) => { tabs.delete(id); },
  navigateTo: ({ id, url }: { id: string; url: string }) => {
    const tab = tabs.get(id);
    if (tab) tab.url = url;
  }
};

const rendererRpc = BrowserView.defineRPC<MultitabRPCSchema>({
  handlers: { requests: rpcHandlers }
});

const server = Bun.serve({
  port: webPort || 0,
  hostname: webPort ? "0.0.0.0" : "127.0.0.1",
  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/rpc") {
      if (server.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (url.pathname === "/fast")
      return html("Local Fast", `<p>served instantly</p><p><a href="/slow?delay=2000">Slow 2s</a></p>`);
    if (url.pathname === "/slow") {
      const delay = Math.min(Number(url.searchParams.get("delay") ?? "1000"), 5000);
      return new Promise(r => setTimeout(() => r(html("Local Slow", `<p>waited ${delay}ms</p><p><a href="/fast">Fast</a></p>`)), delay));
    }

    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes("..")) return new Response("Forbidden", { status: 403 });
    const file = Bun.file(join(rendererDir, pathname === "/" ? "index.html" : pathname.slice(1)));
    if (!(await file.exists())) return new Response("Not Found", { status: 404 });
    return new Response(file);
  },
  websocket: rendererRpc.webHandler
});

origin = `http://127.0.0.1:${server.port}`;

const win = new BrowserWindow({
  title: `bunite multi-tab browser v${app.version} — CEF ${app.cefVersion ?? "unknown"}`,
  frame: { x: 80, y: 80, width: 1280, height: 900 },
  url: `${origin}/`,
  preloadOrigins: [origin],
  rpc: rendererRpc
});

win.on("close-requested", (event: any) => confirmQuit(event, win));
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

function confirmQuit(event: any, win: BrowserWindow) {
  event.response = { allow: false };
  const { response } = Utils.showMessageBoxSync({
    windowId: win.id,
    type: "question",
    title: "Quit",
    message: "Are you sure you want to quit?",
    buttons: ["Quit", "Cancel"],
    defaultId: 0,
    cancelId: 1
  });
  if (response === 0) win.destroy();
}
