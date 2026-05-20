import { AppRuntime, BrowserWindow } from "bunite-core";

const app = new AppRuntime();
await app.ready;

new BrowserWindow({
  title: `Browser Automation Demo — ${app.engineName ?? "?"} ${app.engineVersion ?? "unknown"}`,
  url: "./index.html",
  frame: { x: 60, y: 60, width: 1280, height: 800 }
});

app.run();
