import type { RPCPacket, RPCTransport } from "./rpc";

type DemuxEnvelope = { channel: string; packet: RPCPacket };

function isDemuxEnvelope(value: unknown): value is DemuxEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<DemuxEnvelope>;
  return typeof v.channel === "string" && typeof v.packet === "object" && v.packet !== null;
}

export type TransportDemuxer = {
  channel(name: string): RPCTransport;
  dispose(): void;
};

export function createTransportDemuxer(base: RPCTransport): TransportDemuxer {
  if (!base.send || !base.registerHandler) {
    throw new Error("createTransportDemuxer requires a base transport with both send and registerHandler");
  }

  const handlers = new Map<string, (packet: RPCPacket) => void>();
  let disposed = false;

  base.registerHandler((data) => {
    // Envelopes missing or malformed are dropped. A future fallthrough hook
    // would land here if we ever multiplex legacy RPC on the same transport.
    if (!isDemuxEnvelope(data)) return;
    handlers.get(data.channel)?.(data.packet);
  });

  return {
    channel(name) {
      let ownHandler: ((packet: RPCPacket) => void) | undefined;

      return {
        send(packet) {
          if (disposed) throw new Error(`Demuxer disposed; cannot send on channel "${name}"`);
          const envelope: DemuxEnvelope = { channel: name, packet };
          // The wire layer (msgpackr) serializes the envelope opaquely, so
          // routing the wider type through RPCTransport.send is safe in practice.
          base.send!(envelope as unknown as RPCPacket);
        },
        registerHandler(handler) {
          if (disposed) throw new Error(`Demuxer disposed; cannot register on channel "${name}"`);
          if (handlers.has(name)) {
            throw new Error(`Channel "${name}" already has a handler on this demuxer`);
          }
          ownHandler = handler;
          handlers.set(name, handler);
        },
        unregisterHandler() {
          if (ownHandler && handlers.get(name) === ownHandler) {
            handlers.delete(name);
            ownHandler = undefined;
          }
        }
      };
    },
    dispose() {
      disposed = true;
      handlers.clear();
      base.unregisterHandler?.();
    }
  };
}
