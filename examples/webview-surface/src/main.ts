import { app, BrowserWindow } from "bunite-core";

const server = Bun.serve({
  port: 0,
  fetch(_req, srv) {
    return new Response(`<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin:0; display:flex; align-items:center; justify-content:center;
         height:100vh; background:#7c3aed; color:#fff; font-family:system-ui;
         flex-direction:column; gap:12px; }
  h1 { font-size:28px; }
  p { color:#c4b5fd; font-size:14px; }
  button { padding:8px 20px; border:none; border-radius:6px; background:#a78bfa;
           color:#fff; font-size:15px; cursor:pointer; }
  #count { font-size:48px; font-weight:700; }
</style></head><body>
  <h1>Surface B</h1>
  <div id="count">0</div>
  <button onclick="document.getElementById('count').textContent=++n">Click me</button>
  <p>Served from localhost:${srv.port}</p>
  <script>var n=0;</script>
</body></html>`, { headers: { "Content-Type": "text/html" } });
  }
});

await app.init();

app.handle("getServerUrl", () => `http://localhost:${server.port}`);

new BrowserWindow({
  title: "Webview Surface Test",
  url: "./index.html",
  frame: { x: 80, y: 80, width: 900, height: 650 }
});

app.run();
