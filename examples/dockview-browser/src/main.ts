import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { BrowserWindow, app } from "bunite-core";

process.env.BUNITE_REMOTE_DEBUGGING_PORT ??= "9224";

const distDir = fileURLToPath(new URL("../dist", import.meta.url));

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const pathname = decodeURIComponent(new URL(req.url).pathname);
    if (pathname.includes("..")) return new Response("Forbidden", { status: 403 });
    const file = Bun.file(join(distDir, pathname === "/" ? "index.html" : pathname.slice(1)));
    if (!(await file.exists())) return new Response("Not Found", { status: 404 });
    return new Response(file);
  }
});

console.log(`[dockview-browser] preview: http://localhost:${server.port}`);

await app.init({ logLevel: "info" });

app.handle("dockviewBrowser.getConfig", () => ({
  demoOrigin: `http://localhost:${server.port}`
}));

const win = new BrowserWindow({
  title: "bunite dockview browser",
  frame: { x: 80, y: 80, width: 1024, height: 600 },
  url: "appres://app.internal/index.html",
  appresRoot: distDir
});

win.on("close", () => server.stop(true));

app.run();
