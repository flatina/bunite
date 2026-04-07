import { fileURLToPath } from "node:url";
import { BrowserView, BrowserWindow, app } from "bunite-core";

type ExampleSchema = {
  bun: {
    requests: {
      ping: {
        params: {
          value: string;
        };
        response: {
          pong: string;
        };
      };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {};
  };
};

const rpc = BrowserView.defineRPC<ExampleSchema>({
  handlers: {
    requests: {
      ping({ value }) {
        return { pong: `pong:${value}` };
      }
    }
  }
});

await app.init();

const viewsRoot = fileURLToPath(new URL("./renderer", import.meta.url));
const preload = fileURLToPath(new URL("./renderer/preload.js", import.meta.url));

const win = new BrowserWindow({
  title: "bunite basic example",
  titleBarStyle: "hidden",
  url: "views://index.html",
  viewsRoot,
  preload,
  rpc
});

win.show();
console.log(
  `[example] bunite basic initialized usingStub=${String(app.runtime?.usingStub ?? true)} webviewId=${win.webviewId}`
);

app.run();
