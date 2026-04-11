import { BrowserWindow, Utils, app } from "bunite-core";

process.env.BUNITE_REMOTE_DEBUGGING_PORT ??= "9222";

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/fast")
      return html("Local Fast", `<p>served instantly</p><p><a href="/slow?delay=2000">Slow 2s</a></p>`);
    if (url.pathname === "/slow") {
      const delay = Math.min(Number(url.searchParams.get("delay") ?? "1000"), 5000);
      return new Promise(r => setTimeout(() => r(html("Local Slow", `<p>waited ${delay}ms</p><p><a href="/fast">Fast</a></p>`)), delay));
    }
    return new Response("Not found", { status: 404 });
  }
});

function html(title: string, body: string) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
    <style>body{margin:0;padding:32px;background:#111827;color:#e5e7eb;font:14px/1.6 system-ui}h1{margin:0 0 8px}a{color:#fbbf24}</style>
    </head><body><h1>${title}</h1>${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}

const localOrigin = `http://${server.hostname}:${server.port}`;

await app.init({ logLevel: "info" });

app.handle("multitabBrowser.getConfig", () => ({
  localOrigin
}));

const win = new BrowserWindow({
  title: `bunite multi-tab browser v${app.version} — CEF ${app.cefVersion ?? "unknown"}`,
  frame: { x: 80, y: 80, width: 1280, height: 900 },
  url: "appres://app.internal/index.html",
  appresRoot: "../dist/renderer"
});

win.on("close-requested", (event: any) => {
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
});

win.on("close", () => server.stop(true));

app.run();
