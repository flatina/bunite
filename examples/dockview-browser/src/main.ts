import { join } from "node:path";
import { BrowserWindow, AppRuntime } from "bunite-core";

const flagIdx = process.argv.indexOf("--web-port");
const webPort = flagIdx >= 0 ? Number(process.argv[flagIdx + 1]) : NaN;
if (flagIdx >= 0 && !(Number.isInteger(webPort) && webPort > 0)) {
  throw new Error("--web-port requires a positive integer");
}

if (flagIdx >= 0) {
  const rendererDir = join(import.meta.dir, "../dist/renderer");
  const server = Bun.serve({
    port: webPort,
    hostname: "0.0.0.0",
    async fetch(req) {
      const pathname = decodeURIComponent(new URL(req.url).pathname);
      if (pathname.includes("..")) return new Response("Forbidden", { status: 403 });
      const file = Bun.file(join(rendererDir, pathname === "/" ? "index.html" : pathname.slice(1)));
      if (!(await file.exists())) return new Response("Not Found", { status: 404 });
      return new Response(file);
    }
  });
  console.log(`dockview-browser renderer serving on http://0.0.0.0:${server.port}`);
} else {
  process.env.BUNITE_REMOTE_DEBUGGING_PORT ??= "9224";

  const app = new AppRuntime({ logLevel: "info" });
  await app.ready;

  new BrowserWindow({
    title: `bunite dockview browser v${app.version} — CEF ${app.cefVersion ?? "unknown"}`,
    frame: { x: 80, y: 80, width: 1024, height: 600 },
    url: "../dist/renderer/index.html"
  });

  app.run();
}
