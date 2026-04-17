import { AppRuntime, BrowserWindow } from "bunite-core";

const app = new AppRuntime();
await app.ready;

// Dynamic appres routes — generate HTML on demand
app.getAppRes("/dynamic/now", () => page("Current time", `
  <p>Generated at <strong>${new Date().toLocaleString()}</strong></p>
  <p>Each request re-runs the handler.</p>
`));

app.getAppRes("/dynamic/random", () => page("Random number", `
  <p style="font-size: 48px; font-weight: 700;">${Math.random().toFixed(6)}</p>
`));

new BrowserWindow({
  title: `appres:// demo v${app.version} — CEF ${app.cefVersion ?? "unknown"}`,
  url: "./index.html",
  frame: { x: 80, y: 80, width: 900, height: 700 }
});

app.run();

function page(title: string, body: string) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; padding: 32px; background: #064e3b; color: #fff; font-family: system-ui, sans-serif; }
  h1 { margin: 0 0 8px; font-size: 24px; }
  p { color: #a7f3d0; font-size: 14px; margin-bottom: 12px; }
  code { background: rgba(0,0,0,0.2); padding: 2px 6px; border-radius: 4px; }
</style></head><body><h1>${title}</h1>${body}</body></html>`;
}
