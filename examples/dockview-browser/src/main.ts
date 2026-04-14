import { join } from "node:path";
import { BrowserWindow, app } from "bunite-core";

process.env.BUNITE_REMOTE_DEBUGGING_PORT ??= "9224";

await app.init({ logLevel: "info" });

const webPort = parseWebPort();
const rendererDir = app.resolve("../dist/renderer");

if (webPort) {
  const server = startStaticServer(rendererDir, { port: webPort, hostname: "0.0.0.0" });
  const origin = `http://127.0.0.1:${server.port}`;
  console.log(`[dockview-browser] web access: http://0.0.0.0:${server.port}`);

  const win = new BrowserWindow({
    title: `bunite dockview browser v${app.version} — CEF ${app.cefVersion ?? "unknown"}`,
    frame: { x: 80, y: 80, width: 1024, height: 600 },
    url: `${origin}/`,
    preloadOrigins: [origin]
  });

  win.on("close", () => server.stop(true));
} else {
  new BrowserWindow({
    title: `bunite dockview browser v${app.version} — CEF ${app.cefVersion ?? "unknown"}`,
    frame: { x: 80, y: 80, width: 1024, height: 600 },
    url: "appres://app.internal/index.html",
    appresRoot: "../dist/renderer"
  });
}

app.run();

// ---

function startStaticServer(dir: string, options: { port: number; hostname: string }) {
  return Bun.serve({
    port: options.port,
    hostname: options.hostname,
    async fetch(req) {
      const pathname = decodeURIComponent(new URL(req.url).pathname);
      if (pathname.includes("..")) return new Response("Forbidden", { status: 403 });
      const file = Bun.file(join(dir, pathname === "/" ? "index.html" : pathname.slice(1)));
      if (!(await file.exists())) return new Response("Not Found", { status: 404 });
      return new Response(file);
    }
  });
}

function parseWebPort(): number | null {
  const idx = process.argv.indexOf("--web-port");
  if (idx < 0) return null;
  const value = Number(process.argv[idx + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("--web-port requires a valid port number");
  }
  return value;
}
