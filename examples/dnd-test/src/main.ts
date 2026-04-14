import { BrowserWindow, AppRuntime } from "bunite-core";
import indexHtml from "./index.html" with { type: "text" };
const html = indexHtml as unknown as string;

const app = new AppRuntime();
await app.ready;

const win = new BrowserWindow({
  title: `dnd-test v${app.version} — CEF ${app.cefVersion ?? "unknown"}`,
  html,
  frame: { x: 80, y: 80, width: 700, height: 500 }
});

win.show();
app.run();
