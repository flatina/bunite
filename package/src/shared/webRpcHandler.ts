import {
  defineBunRpc,
  type BuniteRpcConfig,
  type BuniteRpcSchema
} from "./rpc";
import { createWebSocketTransport, type WebSocketLike } from "./webSocketTransport";
import { log } from "./log";

export type WebRpcClient<Schema extends BuniteRpcSchema = BuniteRpcSchema> = {
  ws: WebSocketLike;
  rpc: ReturnType<typeof defineBunRpc<Schema>>;
};

export function createWebRpcHandler<Schema extends BuniteRpcSchema>(
  config: BuniteRpcConfig<Schema, "bun"> & {
    extraRequestHandlers?: Record<string, (...args: any[]) => unknown>;
  }
) {
  type Entry = { client: WebRpcClient<Schema>; receive: (raw: ArrayBuffer | Uint8Array) => void };

  const connections = new WeakMap<WebSocketLike, Entry>();
  const webClients = new Set<WebRpcClient<Schema>>();

  const handler = {
    open(ws: WebSocketLike) {
      const pipe = createWebSocketTransport(ws);
      const rpc = defineBunRpc(config);
      rpc.setTransport(pipe.transport);

      const client: WebRpcClient<Schema> = { ws, rpc: rpc as WebRpcClient<Schema>["rpc"] };

      connections.set(ws, { client, receive: pipe.receive });
      webClients.add(client);
      handler.onWebClientConnected?.(client);
    },

    message(ws: WebSocketLike, raw: string | Buffer | ArrayBuffer | Uint8Array) {
      if (typeof raw === "string") return;
      const entry = connections.get(ws);
      if (!entry) return;

      try {
        entry.receive(raw);
      } catch (error) {
        log.error("Web RPC packet handler error", error);
      }
    },

    close(ws: WebSocketLike) {
      const entry = connections.get(ws);
      if (!entry) return;

      entry.client.rpc.dispose();
      webClients.delete(entry.client);
      connections.delete(ws);
      handler.onWebClientDisconnected?.(entry.client);
    },

    webClients: webClients as ReadonlySet<WebRpcClient<Schema>>,

    broadcast<M extends keyof Schema["bun"]["messages"]>(
      messageName: M,
      ...args: void extends Schema["bun"]["messages"][M]
        ? []
        : undefined extends Schema["bun"]["messages"][M]
          ? [payload?: Schema["bun"]["messages"][M]]
          : [payload: Schema["bun"]["messages"][M]]
    ) {
      for (const client of webClients) {
        (client.rpc.send as any)(messageName, ...args);
      }
    },

    onWebClientConnected: undefined as ((client: WebRpcClient<Schema>) => void) | undefined,
    onWebClientDisconnected: undefined as ((client: WebRpcClient<Schema>) => void) | undefined,
  };

  return handler;
}
