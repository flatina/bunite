// Web mode: serve the bridge over WebSocket. Renderer is the same bundle as `native.ts`.
import { serveWeb } from "bunite-core";
import { BridgeCap } from "./schema";
import { makeBridgeImpl } from "./server";

const rendererJs = await (async () => {
  const out = await Bun.build({ entrypoints: ["src/renderer/index.ts"], target: "browser" });
  if (!out.success) throw new Error(out.logs.join("\n"));
  return out.outputs[0]!.text();
})();
const indexHtml = await Bun.file("src/renderer/index.html").text();
const html = indexHtml.replace("/*BUNDLE*/", rendererJs);

const mount = serveWeb((conn) => {
  conn.serve(BridgeCap, makeBridgeImpl());
});

const port = Number(process.env.PORT ?? 3000);
Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req, srv) {
    const rpc = mount.fetch(req, srv);
    if (rpc !== undefined) return rpc;
    const path = new URL(req.url).pathname;
    if (path === "/" || path === "/index.html") {
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("Not Found", { status: 404 });
  },
  websocket: mount.websocket,
});

console.log(`auth-bridge web mode on http://127.0.0.1:${port}`);
console.log(`  try: open the URL, paste \`t-alice\` or \`t-bob\` as a token`);
