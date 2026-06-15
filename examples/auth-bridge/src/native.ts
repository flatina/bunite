// Native mode: BrowserWindow ships the same renderer. The preload connection
// arrives with `attestation.level === "app-internal"`, so `createDesktopSession`
// succeeds without a token.
import { AppRuntime, BrowserWindow } from "bunite-core";
import indexHtml from "./renderer/index.html" with { type: "text" };
import { BridgeCap } from "./schema";
import { makeBridgeImpl } from "./server";

const app = new AppRuntime();
await app.ready;

const rendererJs = await (async () => {
  const out = await Bun.build({
    entrypoints: [app.resolve("./renderer/index.ts")],
    target: "browser",
  });
  if (!out.success) throw new Error(out.logs.join("\n"));
  return out.outputs[0]!.text();
})();
const html = (indexHtml as unknown as string).replace("/*BUNDLE*/", rendererJs);

new BrowserWindow({
  title: `auth-bridge native — ${app.engineName ?? "?"} ${app.engineVersion ?? ""}`,
  html,
  serve: (conn) => {
    conn.serve(BridgeCap, makeBridgeImpl());
  },
});

app.run();
