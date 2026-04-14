import { join } from "node:path";
import { BrowserWindow, AppRuntime } from "bunite-core";

process.env.BUNITE_REMOTE_DEBUGGING_PORT ??= "9224";

const app = new AppRuntime({ logLevel: "info" });
await app.ready;

const webPort = Number(process.argv[process.argv.indexOf("--web-port") + 1]) || 0;
const rendererDir = app.resolve("../dist/renderer");

const server = Bun.serve({
  port: webPort || 0,
  hostname: webPort ? "0.0.0.0" : "127.0.0.1",
  async fetch(req) {
    const pathname = decodeURIComponent(new URL(req.url).pathname);
    if (pathname.includes("..")) return new Response("Forbidden", { status: 403 });
    const file = Bun.file(join(rendererDir, pathname === "/" ? "index.html" : pathname.slice(1)));
    if (!(await file.exists())) return new Response("Not Found", { status: 404 });
    return new Response(file);
  }
});

const origin = `http://127.0.0.1:${server.port}`;

const win = new BrowserWindow({
  title: `bunite dockview browser v${app.version} — CEF ${app.cefVersion ?? "unknown"}`,
  frame: { x: 80, y: 80, width: 1024, height: 600 },
  url: `${origin}/`,
  preloadOrigins: [origin]
});

win.on("close", () => server.stop(true));

app.run();
