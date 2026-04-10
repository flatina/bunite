import { BrowserWindow, app } from "bunite-core";

await app.init();

const win = new BrowserWindow({
  title: `dnd-test v${app.version} — CEF ${app.cefVersion ?? "unknown"}`,
  url: "./index.html",
  width: 700,
  height: 500
});

win.show();
app.run();
