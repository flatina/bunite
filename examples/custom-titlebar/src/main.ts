import { AppRuntime, BrowserWindow } from "bunite-core";

const app = new AppRuntime();
await app.ready;

new BrowserWindow({
  title: `Custom Titlebar — ${app.engineName ?? "?"} ${app.engineVersion ?? ""}`,
  url: "./index.html",
  titleBarStyle: "hidden", // frameless — HTML draws the titlebar
  frame: { x: 120, y: 120, width: 860, height: 560 },
});

app.run();
