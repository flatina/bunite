import { app, BrowserWindow } from "bunite-core";

await app.init();

new BrowserWindow({
  title: "Hello Bunite",
  url: "./index.html"
});

app.run();
