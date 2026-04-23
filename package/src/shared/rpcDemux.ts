import type { RPCPacket, RPCTransport, RPCWithTransport } from "./rpc";

type DemuxPacketEnvelope = { channel: string; packet: RPCPacket };
type DemuxHelloFrame = { channel: string; hello: true };
type DemuxFrame = DemuxPacketEnvelope | DemuxHelloFrame;

function isDemuxFrame(value: unknown): value is DemuxFrame {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as DemuxFrame).channel === "string";
}

function isPacketEnvelope(frame: DemuxFrame): frame is DemuxPacketEnvelope {
  const v = frame as DemuxPacketEnvelope;
  return typeof v.packet === "object" && v.packet !== null;
}

function isHelloFrame(frame: DemuxFrame): frame is DemuxHelloFrame {
  return (frame as DemuxHelloFrame).hello === true;
}

export type ChannelHandle = {
  /**
   * Connect an RPC instance to this channel. Returns a promise that resolves
   * once both sides have registered a handler (HELLO handshake). Awaiting
   * guarantees the first subsequent request reaches the peer.
   */
  bindTo(rpc: RPCWithTransport): Promise<void>;
};

export type TransportDemuxer = {
  channel(name: string): ChannelHandle;
  dispose(): void;
};

export type TransportDemuxerOptions = {
  /** ms to wait for peer before `bindTo` rejects. Default 10_000. */
  readyTimeout?: number;
};

type ChannelState = {
  handler?: (packet: RPCPacket) => void;
  peerSawUs: boolean;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  readySettled: boolean;
  readyTimer?: ReturnType<typeof setTimeout>;
};

const DEFAULT_READY_TIMEOUT = 10_000;

export function createTransportDemuxer(
  base: RPCTransport,
  options: TransportDemuxerOptions = {}
): TransportDemuxer {
  if (!base.send || !base.registerHandler) {
    throw new Error("createTransportDemuxer requires a base transport with both send and registerHandler");
  }

  const readyTimeout = options.readyTimeout ?? DEFAULT_READY_TIMEOUT;
  const channels = new Map<string, ChannelState>();
  let disposed = false;

  function getOrCreateState(name: string): ChannelState {
    let state = channels.get(name);
    if (state) return state;

    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    ready.catch(() => {}); // prevent unhandled rejection if consumer doesn't await

    state = {
      peerSawUs: false,
      ready,
      resolveReady,
      rejectReady,
      readySettled: false
    };
    channels.set(name, state);
    return state;
  }

  function settleReady(state: ChannelState, action: () => void) {
    if (state.readySettled) return;
    state.readySettled = true;
    if (state.readyTimer) clearTimeout(state.readyTimer);
    action();
  }

  function sendHello(name: string) {
    const frame: DemuxHelloFrame = { channel: name, hello: true };
    base.send!(frame as unknown as RPCPacket);
  }

  base.registerHandler((data) => {
    if (!isDemuxFrame(data)) return;
    const state = getOrCreateState(data.channel);

    if (isHelloFrame(data)) {
      if (state.handler) {
        const wasReady = state.readySettled;
        settleReady(state, state.resolveReady);
        if (!wasReady && !disposed) sendHello(data.channel); // echo so peer wakes up
      } else {
        state.peerSawUs = true;
      }
      return;
    }

    if (isPacketEnvelope(data)) {
      state.handler?.(data.packet);
    }
  });

  return {
    channel(name) {
      const state = getOrCreateState(name);

      const transport: RPCTransport = {
        send(packet) {
          if (disposed) throw new Error(`Demuxer disposed; cannot send on channel "${name}"`);
          const envelope: DemuxPacketEnvelope = { channel: name, packet };
          base.send!(envelope as unknown as RPCPacket);
        },
        registerHandler(handler) {
          if (disposed) throw new Error(`Demuxer disposed; cannot register on channel "${name}"`);
          if (state.handler) {
            throw new Error(`Channel "${name}" already has a handler on this demuxer`);
          }
          state.handler = handler;

          sendHello(name);

          if (state.peerSawUs) {
            settleReady(state, state.resolveReady);
          } else if (!state.readySettled && !state.readyTimer) {
            state.readyTimer = setTimeout(() => {
              settleReady(state, () =>
                state.rejectReady(new Error(`Channel "${name}" ready timed out after ${readyTimeout}ms`))
              );
            }, readyTimeout);
          }
        },
        unregisterHandler() {
          state.handler = undefined;
        }
      };

      return {
        bindTo(rpc) {
          rpc.setTransport(transport);
          return state.ready;
        }
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const state of channels.values()) {
        if (state.readyTimer) clearTimeout(state.readyTimer);
        if (!state.readySettled) {
          state.readySettled = true;
          state.rejectReady(new Error("Demuxer disposed"));
        }
      }
      channels.clear();
      base.unregisterHandler?.();
    }
  };
}
