import { AsyncLocalStorage } from "node:async_hooks";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Connection } from "../rpc/peer";
import { _setCallContextStorage, createConnection } from "../rpc/peer";
import type { BytesPipe } from "../rpc/transport";
import { createFrameTransport } from "../rpc/transport";
import { DEFAULT_MAX_BYTES } from "../rpc/wire";

_setCallContextStorage(new AsyncLocalStorage<{ callId: number }>());

interface PipeSlot {
  _bunitePipe?: { handler?: (bytes: Uint8Array) => void };
}

function asBytes(message: unknown): Uint8Array {
  if (typeof message === "string") return new TextEncoder().encode(message);
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message))
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  return new Uint8Array(0);
}

export function createBunWebSocketServerHandler<TData extends object>(
  onConnection: (ws: ServerWebSocket<TData>, pipe: BytesPipe) => void,
  onClose?: (ws: ServerWebSocket<TData>) => void,
): WebSocketHandler<TData> {
  return {
    open(ws) {
      const slot = ws.data as TData & PipeSlot;
      const handlerBox: { handler?: (bytes: Uint8Array) => void } = {};
      slot._bunitePipe = handlerBox;
      const pipe: BytesPipe = {
        send: (bytes) => {
          ws.send(bytes);
        },
        setReceive: (h) => {
          handlerBox.handler = h;
        },
        close: () => {
          ws.close();
        },
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

export interface WsData {
  origin: string;
}

export interface WebRpcMount {
  fetch(req: Request, srv: Server<object>): Response | undefined;
  websocket: WebSocketHandler<object> & { maxPayloadLength: number };
}

export interface ServeWebOptions<TData extends WsData = WsData> {
  path?: string;
  /** Enrichment hook fired at upgrade — return extra fields (e.g. auth-derived userId, perms) that the setup callback receives. */
  onUpgrade?: (req: Request) => Omit<TData, keyof WsData> | undefined;
}

/** Mount a WebSocket RPC endpoint on `Bun.serve`. `setup(conn, wsData)` runs once per client connection. */
export function serveWeb<TData extends WsData = WsData>(
  setup: (conn: Connection, wsData: TData) => void,
  opts: ServeWebOptions<TData> = {},
): WebRpcMount {
  const path = opts.path ?? DEFAULT_RPC_PATH;
  return {
    fetch(req, srv) {
      if (new URL(req.url).pathname !== path) return undefined;
      const enriched = opts.onUpgrade?.(req) ?? ({} as Omit<TData, keyof WsData>);
      const data = { origin: req.headers.get("origin") ?? "", ...enriched } as TData;
      const upgraded = srv.upgrade(req, { data });
      return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    },
    websocket: {
      ...(createBunWebSocketServerHandler<TData>((ws, pipe) => {
        const wsData = ws.data;
        const origin = wsData?.origin ?? "";
        const conn = createConnection({
          transport: createFrameTransport(pipe),
          mode: "web",
          origin: origin || "web-client",
          attestation: {
            origin,
            topOrigin: origin,
            partition: "default",
            isAppRes: false,
            isMainFrame: true,
            userGesture: false,
            level: "untrusted",
          },
        });
        setup(conn, wsData);
      }) as unknown as WebRpcMount["websocket"]),
      maxPayloadLength: DEFAULT_MAX_BYTES,
    },
  };
}
