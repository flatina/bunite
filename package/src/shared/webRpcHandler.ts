import { decodeRPCPacket, encodeRPCPacket, asUint8Array } from "./rpcWire";

type WebRPCHandlers = Record<string, (params?: unknown) => unknown>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWebRPCHandler(handlers: WebRPCHandlers) {
  return {
    message(ws: { send(data: Uint8Array): void }, raw: string | Buffer) {
      if (typeof raw === "string") return;

      let packet;
      try {
        packet = decodeRPCPacket(asUint8Array(raw));
      } catch {
        return;
      }

      if (packet.type !== "request" || typeof packet.method !== "string") return;

      const handler = handlers[packet.method];
      if (!handler) {
        ws.send(
          encodeRPCPacket({ type: "response", id: packet.id, success: false, error: `Unknown method: ${packet.method}` })
        );
        return;
      }

      try {
        Promise.resolve(handler(packet.params)).then(
          (payload) =>
            ws.send(encodeRPCPacket({ type: "response", id: packet.id, success: true, payload })),
          (error) =>
            ws.send(encodeRPCPacket({ type: "response", id: packet.id, success: false, error: errorMessage(error) }))
        );
      } catch (error) {
        ws.send(
          encodeRPCPacket({ type: "response", id: packet.id, success: false, error: errorMessage(error) })
        );
      }
    }
  };
}
