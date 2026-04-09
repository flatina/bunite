import { BuniteView } from "bunite-core/view";

type SmokeSchema = {
  bun: {
    requests: {
      ping: { params: { value: string }; response: { pong: string } };
    };
    messages: {};
  };
  webview: { requests: {}; messages: {} };
};

const rpc = BuniteView.defineRPC<SmokeSchema>({ handlers: { requests: {} } });
const view = new BuniteView({ rpc });

function setStatus(text: string) {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

async function waitForSocket(socket: WebSocket | undefined) {
  if (!socket) throw new Error("No socket");
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    socket!.addEventListener("open", () => resolve(), { once: true });
    socket!.addEventListener("error", () => reject(new Error("Socket error")), { once: true });
  });
}

try {
  await waitForSocket(view.bunSocket);
  const { pong } = await rpc.request("ping", { value: "smoke" });
  setStatus(`rpc ok: ${pong}`);

  // Attempt blocked navigation (should be rejected by rules)
  location.href = "appres://app.internal/smoke/nav-blocked.html";

  // Then navigate to allowed page
  setTimeout(() => {
    location.href = "appres://app.internal/smoke/nav-ok.html";
  }, 100);
} catch (e) {
  setStatus(`error: ${e}`);
}
