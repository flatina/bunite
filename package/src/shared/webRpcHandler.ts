import {
  defineBuniteRPC,
  type BuniteRPCConfig,
  type BuniteRPCSchema,
  type RPCTransport,
  type RPCPacket
} from "./rpc";
import { decodeRPCPacket, encodeRPCPacket, asUint8Array } from "./rpcWire";
import { log } from "./log";

type WebRPCSocket = { send(data: Uint8Array | ArrayBuffer): void | number };

export type WebRPCClient<Schema extends BuniteRPCSchema = BuniteRPCSchema> = {
  ws: WebRPCSocket;
  rpc: ReturnType<typeof defineBuniteRPC<Schema, "bun">>;
  handlePacket: (packet: RPCPacket) => void | Promise<void>;
};

export function createWebRPCHandler<Schema extends BuniteRPCSchema>(
  config: BuniteRPCConfig<Schema, "bun"> & {
    extraRequestHandlers?: Record<string, (...args: any[]) => unknown>;
  }
) {
  const connections = new WeakMap<WebRPCSocket, WebRPCClient<Schema>>();
  const webClients = new Set<WebRPCClient<Schema>>();

  const handler = {
    open(ws: WebRPCSocket) {
      let handlePacket: ((packet: RPCPacket) => void | Promise<void>) | undefined;

      const transport: RPCTransport = {
        send(packet) {
          ws.send(encodeRPCPacket(packet));
        },
        registerHandler(h) {
          handlePacket = h;
        },
        unregisterHandler() {
          handlePacket = undefined;
        }
      };

      const rpc = defineBuniteRPC("bun", config);
      rpc.setTransport(transport);

      const client: WebRPCClient<Schema> = {
        ws,
        rpc: rpc as WebRPCClient<Schema>["rpc"],
        handlePacket: (packet) => handlePacket?.(packet)
      };

      connections.set(ws, client);
      webClients.add(client);
      handler.onWebClientConnected?.(client);
    },

    message(ws: WebRPCSocket, raw: string | Buffer | ArrayBuffer | Uint8Array) {
      if (typeof raw === "string") return;

      const client = connections.get(ws);
      if (!client) return;

      try {
        Promise.resolve(client.handlePacket(decodeRPCPacket(asUint8Array(raw)))).catch((error) => {
          log.error("Web RPC packet handler error", error);
        });
      } catch {
        // malformed packet — decode failure
      }
    },

    close(ws: WebRPCSocket) {
      const client = connections.get(ws);
      if (!client) return;

      client.rpc.setTransport({});
      webClients.delete(client);
      connections.delete(ws);
      handler.onWebClientDisconnected?.(client);
    },

    webClients: webClients as ReadonlySet<WebRPCClient<Schema>>,

    broadcast(messageName: string, payload?: unknown) {
      for (const client of webClients) {
        (client.rpc.send as any)(messageName, payload);
      }
    },

    onWebClientConnected: undefined as ((client: WebRPCClient<Schema>) => void) | undefined,
    onWebClientDisconnected: undefined as ((client: WebRPCClient<Schema>) => void) | undefined,
  };

  return handler;
}
