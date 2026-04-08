const sendPage = (title: string, body: string, startedAt: number) =>
  new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { margin: 0; padding: 32px; background: #111827; color: #e5e7eb; font: 14px/1.6 system-ui, sans-serif; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    .meta { color: #93c5fd; margin-bottom: 20px; }
    a { color: #fbbf24; }
    code { color: #c4b5fd; }
  </style>
</head>
<body>
  ${body}
</body>
</html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      }
    }
  );

export const localServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    const startedAt = Date.now();

    if (url.pathname === "/fast") {
      return sendPage(
        "Local Fast",
        `<h1>Local Fast</h1>
        <div class="meta">served in ${Date.now() - startedAt}ms</div>
        <p>Deterministic localhost page for navigation latency testing.</p>
        <p><a href="/echo?from=fast">Open another local page</a></p>`,
        startedAt
      );
    }

    if (url.pathname === "/slow") {
      const delay = Math.max(0, Math.min(Number(url.searchParams.get("delay") ?? "1000"), 5000));
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(
            sendPage(
              `Local Slow ${delay}`,
              `<h1>Local Slow</h1>
              <div class="meta">delay ${delay}ms, total ${Date.now() - startedAt}ms</div>
              <p>This response intentionally waits before returning.</p>
              <p><a href="/fast">Go to local fast</a></p>`,
              startedAt
            )
          );
        }, delay);
      });
    }

    if (url.pathname === "/echo") {
      const from = url.searchParams.get("from") ?? "unknown";
      return sendPage(
        "Local Echo",
        `<h1>Local Echo</h1>
        <div class="meta">from=${from}, served in ${Date.now() - startedAt}ms</div>
        <p><a href="/fast">Fast</a></p>
        <p><a href="/slow?delay=1500">Slow 1500ms</a></p>`,
        startedAt
      );
    }

    return new Response("Not found", { status: 404 });
  }
});

export const localOrigin = `http://${localServer.hostname}:${localServer.port}`;
