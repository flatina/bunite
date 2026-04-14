import { AppRuntime, BrowserWindow } from "bunite-core";
import indexHtml from "./index.html" with { type: "text" };
// bun types return HTMLBundle; cast to string for bunite API
const html = indexHtml as unknown as string;

const app = new AppRuntime();
await app.ready;

new BrowserWindow({
  title: `Hello Bunite v${app.version} — CEF ${app.cefVersion ?? "unknown"}`,
  html
});

app.run();
