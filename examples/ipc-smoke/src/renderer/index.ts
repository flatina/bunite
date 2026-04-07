import { BuniteView } from "bunite/view";

type IPCSmokeSchema = {
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

function getAppRoot() {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) {
    throw new Error("ipc-smoke renderer root is missing.");
  }
  return app;
}

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

const rpc = BuniteView.defineRPC<IPCSmokeSchema>({
  handlers: {
    requests: {}
  }
});

const view = new BuniteView({ rpc });

try {
  await waitForSocketOpen(view.bunSocket);
  const pong = await rpc.request("ping", { value: "ipc-smoke" });

  getAppRoot().innerHTML = `
    <h1>bunite ipc smoke</h1>
    <p>WebSocket ready: ${String(Boolean(view.bunSocket))}</p>
    <p>RPC response: ${pong.pong}</p>
  `;

  if (pong.pong === "pong:ipc-smoke") {
    window.open("views://main/popup-target.html", "_blank");
    // Give CEF a brief turn to surface OnBeforePopup before we navigate away.
    setTimeout(() => {
      location.href = "views://main/rpc-ok.html";
    }, 50);
  } else {
    location.href = "views://main/rpc-fail.html";
  }
} catch (error) {
  console.error("[ipc-smoke] renderer RPC failed", error);
  location.href = "views://main/rpc-fail.html";
}
