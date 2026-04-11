import { join } from "node:path";
import { BrowserWindow, app } from "bunite-core";

process.env.BUNITE_REMOTE_DEBUGGING_PORT ??= "9224";

await app.init({ logLevel: "info" });

// Serve renderer files for the demo preview server
const rendererDir = app.resolve("../dist/renderer");

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const pathname = decodeURIComponent(new URL(req.url).pathname);
    if (pathname.includes("..")) return new Response("Forbidden", { status: 403 });
    const file = Bun.file(join(rendererDir, pathname === "/" ? "index.html" : pathname.slice(1)));
    if (!(await file.exists())) return new Response("Not Found", { status: 404 });
    return new Response(file);
  }
});

console.log(`[dockview-browser] preview: http://localhost:${server.port}`);

app.handle("dockviewBrowser.getConfig", () => ({
  demoOrigin: `http://localhost:${server.port}`
}));

const win = new BrowserWindow({
  title: `bunite dockview browser v${app.version} — CEF ${app.cefVersion ?? "unknown"}`,
  frame: { x: 80, y: 80, width: 1024, height: 600 },
  url: "appres://app.internal/index.html",
  appresRoot: "../dist/renderer"
});

win.on("close", () => server.stop(true));

app.run();
