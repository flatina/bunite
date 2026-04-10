import { app, BrowserWindow } from "bunite-core";

await app.init();

new BrowserWindow({
  title: `Hello Bunite v${app.version} — CEF ${app.cefVersion ?? "unknown"}`,
  url: "./index.html"
});

app.run();
