import { app, BrowserWindow } from "bunite-core";
import indexHtml from "./index.html" with { type: "text" };
// bun types return HTMLBundle; cast to string for bunite API
const html = indexHtml as unknown as string;

await app.init();

new BrowserWindow({
  title: `Hello Bunite v${app.version} — CEF ${app.cefVersion ?? "unknown"}`,
  html
});

app.run();
