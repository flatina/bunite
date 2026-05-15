import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BrowserWindow, AppRuntime } from "bunite-core";
import { descriptor, attachNavigationChecks, checkIPC } from "./ipc";
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

const win = new BrowserWindow({
  title: "bunite smoke",
  url: "appres://app.internal/smoke/index.html",
  appresRoot: resolveRendererRoot(),
  serve: descriptor,
  navigationRules: ["^*", "appres://app.internal/smoke/*", "^appres://app.internal/smoke/nav-blocked.html*"],
});

const view = win.webview;
if (!view) throw new Error("smoke: BrowserWindow has no webview");
attachNavigationChecks(view);

win.show();
void runWindowTests(win);

setTimeout(() => {
  const results = { ...checkIPC(), ...checkWindow() };
  const allPassed = Object.values(results).every(Boolean);
  if (allPassed) console.log("[smoke] PASSED", results);
  else console.error("[smoke] FAILED", results);
  app.quit(allPassed ? 0 : 1);
}, 8_000);

app.run();
