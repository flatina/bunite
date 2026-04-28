import type { RpcPacket, RpcTransport } from "./rpc";
import { asUint8Array, decodeRpcPacket, encodeRpcPacket } from "./rpcWire";

export type WebSocketLike = {
  send(data: Uint8Array | ArrayBuffer): void | number;
};

export type WebSocketTransportPipe = {
  transport: RpcTransport;
  receive(raw: ArrayBuffer | ArrayBufferView | Uint8Array): void;
};

export function createWebSocketTransport(ws: WebSocketLike): WebSocketTransportPipe {
  let handler: ((packet: RpcPacket) => void) | undefined;

  return {
    transport: {
      send(packet) { ws.send(encodeRpcPacket(packet)); },
      registerHandler(h) { handler = h; },
      unregisterHandler() { handler = undefined; }
    },
    receive(raw) {
      handler?.(decodeRpcPacket(asUint8Array(raw)));
    }
  };
}
