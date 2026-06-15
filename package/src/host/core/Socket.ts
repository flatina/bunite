import type { Server, WebSocketHandler } from "bun";
import { DEFAULT_MAX_BYTES } from "../../rpc/wire";
import { log } from "../log";
import type { BrowserView } from "./BrowserView";

type ViewRegistry = {
  getById(id: number): BrowserView | undefined;
};

type WebSocketData = {
  webviewId: number;
  pipe?: { deliver(bytes: Uint8Array): void };
};

let rpcServer: Server<WebSocketData> | null = null;
let rpcPort = 0;
let registry: ViewRegistry | null = null;

export function attachBrowserViewRegistry(nextRegistry: ViewRegistry) {
  registry = nextRegistry;
}

function asBytes(message: unknown): Uint8Array | null {
  if (typeof message === "string") return null;
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message))
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  return null;
}

const websocket: WebSocketHandler<WebSocketData> = {
  open(ws) {
    const view = registry?.getById(ws.data.webviewId);
    if (!view) {
      ws.close();
      return;
    }
    let handler: ((bytes: Uint8Array) => void) | undefined;
    const pending: Uint8Array[] = [];
    const pipe = {
      send: (bytes: Uint8Array) => {
        ws.send(bytes);
      },
      setReceive: (h: (bytes: Uint8Array) => void) => {
        handler = h;
        for (const b of pending) h(b);
        pending.length = 0;
      },
      close: () => {
        try {
          ws.close();
        } catch {
          /* swallow */
        }
      },
      deliver: (bytes: Uint8Array) => {
        if (handler) handler(bytes);
        else pending.push(bytes);
      },
    };
    ws.data.pipe = pipe;
    void view.attachNewConnection(pipe);
  },
  close(ws) {
    const view = registry?.getById(ws.data.webviewId);
    view?.detachNewConnection();
    ws.data.pipe = undefined;
  },
  message(ws, message) {
    const bytes = asBytes(message);
    if (bytes) ws.data.pipe?.deliver(bytes);
  },
};

export function ensureRpcServer() {
  if (rpcServer) return { rpcServer, rpcPort };

  let port = 45000;
  while (port <= 65535) {
    try {
      rpcServer = Bun.serve<WebSocketData>({
        hostname: "127.0.0.1",
        port,
        fetch(req, server) {
          const url = new URL(req.url);
          if (url.pathname !== "/rpc") return new Response("Not found", { status: 404 });
          const webviewId = Number(url.searchParams.get("webviewId"));
          if (!Number.isFinite(webviewId))
            return new Response("Missing webviewId", { status: 400 });
          if (!registry?.getById(webviewId))
            return new Response("Unknown webviewId", { status: 403 });
          const upgraded = server.upgrade(req, { data: { webviewId } });
          return upgraded ? undefined : new Response("Upgrade failed", { status: 500 });
        },
        websocket: { ...websocket, maxPayloadLength: DEFAULT_MAX_BYTES },
      });
      rpcPort = port;
      break;
    } catch (error: any) {
      if (error?.code === "EADDRINUSE") {
        port += 1;
        continue;
      }
      throw error;
    }
  }
  if (!rpcServer) throw new Error("Could not start bunite RPC server.");
  log.debug(`bunite RPC server listening on 127.0.0.1:${rpcPort}`);
  return { rpcServer, rpcPort };
}

export function getRpcPort(): number {
  return rpcPort;
}
