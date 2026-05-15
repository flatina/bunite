import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import type { BytesPipe } from "./transport";
import { createConnection, _setCallContextStorage } from "./peer";
import { createFrameTransport } from "./transport";
import type { SchemaShape, ServerDescriptor } from "./schema";

_setCallContextStorage(new AsyncLocalStorage<{ callId: number }>());

interface PipeSlot {
  _bunitePipe?: { handler?: (bytes: Uint8Array) => void };
}

function asBytes(message: unknown): Uint8Array {
  if (typeof message === "string") return new TextEncoder().encode(message);
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message)) return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  return new Uint8Array(0);
}

export function createBunWebSocketServerHandler<TData extends object>(
  onConnection: (ws: ServerWebSocket<TData>, pipe: BytesPipe) => void,
  onClose?: (ws: ServerWebSocket<TData>) => void
): WebSocketHandler<TData> {
  return {
    open(ws) {
      const slot = ws.data as TData & PipeSlot;
      const handlerBox: { handler?: (bytes: Uint8Array) => void } = {};
      slot._bunitePipe = handlerBox;
      const pipe: BytesPipe = {
        send: (bytes) => { ws.send(bytes); },
        setReceive: (h) => { handlerBox.handler = h; },
        close: () => { ws.close(); },
      };
      onConnection(ws, pipe);
    },
    message(ws, message) {
      const slot = ws.data as TData & PipeSlot;
      slot._bunitePipe?.handler?.(asBytes(message));
    },
    close(ws) {
      const slot = ws.data as TData & PipeSlot;
      slot._bunitePipe = undefined;
      onClose?.(ws);
    },
  };
}

const DEFAULT_RPC_PATH = "/rpc";

export interface WebRpcMount {
  fetch(req: Request, srv: Server<object>): Response | undefined;
  websocket: WebSocketHandler<object>;
}

export function serveWeb<S extends SchemaShape>(
  descriptor: ServerDescriptor<S>,
  opts: { path?: string } = {}
): WebRpcMount {
  const path = opts.path ?? DEFAULT_RPC_PATH;
  return {
    fetch(req, srv) {
      if (new URL(req.url).pathname !== path) return undefined;
      const upgraded = srv.upgrade(req, { data: {} });
      return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    },
    websocket: createBunWebSocketServerHandler<object>((_ws, pipe) => {
      const conn = createConnection({
        transport: createFrameTransport(pipe),
        mode: "web",
        origin: "web-client",
      });
      conn.serve(descriptor);
    }),
  };
}
