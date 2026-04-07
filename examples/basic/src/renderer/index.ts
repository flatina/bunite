import { BuniteView } from "bunite/view";

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

const rpc = BuniteView.defineRPC<ExampleSchema>({
  handlers: {
    requests: {}
  }
});

const view = new BuniteView({ rpc });

async function waitForSocketOpen(socket: WebSocket | undefined) {
  if (!socket) {
    throw new Error("bunite socket was not initialized.");
  }
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const handleOpen = () => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      resolve();
    };
    const handleError = () => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      reject(new Error("bunite socket failed to open."));
    };

    socket.addEventListener("open", handleOpen, { once: true });
    socket.addEventListener("error", handleError, { once: true });
  });
}

await waitForSocketOpen(view.bunSocket);
const pong = await rpc.request("ping", { value: "renderer" });

document.body.innerHTML = `
  <main>
    <h1>bunite basic example</h1>
    <p>Renderer bridge initialized.</p>
    <p>WebSocket ready: ${String(Boolean(view.bunSocket))}</p>
    <p>RPC response: ${pong.pong}</p>
  </main>
`;
