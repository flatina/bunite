import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BrowserWindow, AppRuntime } from "bunite-core";
import { rpcDefinition, attachNavigationChecks, checkIPC } from "./ipc";
import { runWindowTests, checkWindow } from "./window";

function resolveRendererRoot() {
  const candidate = fileURLToPath(new URL("../dist/renderer", import.meta.url));
  if (!existsSync(candidate)) {
    throw new Error("Renderer not built. Run `bun run prepare:renderer` first.");
  }
  return candidate;
}

const app = new AppRuntime();
await app.ready;

const appresRoot = resolveRendererRoot();

const win = new BrowserWindow({
  title: "bunite smoke",
  url: "appres://app.internal/smoke/index.html",
  appresRoot,
  rpc: rpcDefinition,
  navigationRules: ["^*", "appres://app.internal/smoke/*", "^appres://app.internal/smoke/nav-blocked.html*"]
});

attachNavigationChecks(win.webview);

win.show();
void runWindowTests(win);

setTimeout(() => {
  const ipc = checkIPC();
  const window = checkWindow();
  const results = { ...ipc, ...window };
  const allPassed = Object.values(results).every(Boolean);

  if (allPassed) {
    console.log("[smoke] PASSED", results);
  } else {
    console.error("[smoke] FAILED", results);
  }

  app.quit(allPassed ? 0 : 1);
}, 5_000);

app.run();
