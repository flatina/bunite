import type { RPCPacket, RPCTransport } from "./rpc";
import { asUint8Array, decodeRPCPacket, encodeRPCPacket } from "./rpcWire";

export type WebSocketLike = {
  send(data: Uint8Array | ArrayBuffer): void | number;
};

export type WebSocketTransportPipe = {
  transport: RPCTransport;
  receive(raw: ArrayBuffer | ArrayBufferView | Uint8Array): void;
};

export function createWebSocketTransport(ws: WebSocketLike): WebSocketTransportPipe {
  let handler: ((packet: RPCPacket) => void) | undefined;

  return {
    transport: {
      send(packet) { ws.send(encodeRPCPacket(packet)); },
      registerHandler(h) { handler = h; },
      unregisterHandler() { handler = undefined; }
    },
    receive(raw) {
      handler?.(decodeRPCPacket(asUint8Array(raw)));
    }
  };
}
