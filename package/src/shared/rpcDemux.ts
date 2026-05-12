import type { RpcPacket, RpcTransport, RpcWithTransport } from "./rpc";

type DemuxPacketEnvelope = { channel: string; packet: RpcPacket };
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

export type RpcChannelHandle = {
  /**
   * Connect an RPC instance to this channel. Returns a promise that resolves
   * once both sides have registered a handler (HELLO handshake). Awaiting
   * guarantees the first subsequent request reaches the peer.
   */
  bindTo(rpc: RpcWithTransport): Promise<void>;
};

export type RpcTransportDemuxer = {
  channel(name: string): RpcChannelHandle;
  dispose(): void;
};

export type RpcDemuxBufferPolicy = "drop-oldest" | "drop-newest";

export type RpcTransportDemuxerOptions = {
  /** ms to wait for peer before `bindTo` rejects. Default 10_000. */
  readyTimeout?: number;
  /**
   * Per-channel cap for packets received before a handler is registered.
   * Drained FIFO on registerHandler. Default 64. Set 0 to disable buffering.
   */
  bufferSize?: number;
  /** Overflow behaviour when bufferSize is exceeded. Default "drop-oldest". */
  bufferPolicy?: RpcDemuxBufferPolicy;
};

type ChannelState = {
  handler?: (packet: RpcPacket) => void;
  peerSawUs: boolean;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  readySettled: boolean;
  readyTimer?: ReturnType<typeof setTimeout>;
  pending: RpcPacket[];
};

const DEFAULT_READY_TIMEOUT = 10_000;
const DEFAULT_BUFFER_SIZE = 64;

export function createRpcTransportDemuxer(
  base: RpcTransport,
  options: RpcTransportDemuxerOptions = {}
): RpcTransportDemuxer {
  if (!base.send || !base.registerHandler) {
    throw new Error("createRpcTransportDemuxer requires a base transport with both send and registerHandler");
  }

  const readyTimeout = options.readyTimeout ?? DEFAULT_READY_TIMEOUT;
  const bufferSize = Math.max(0, options.bufferSize ?? DEFAULT_BUFFER_SIZE);
  const bufferPolicy: RpcDemuxBufferPolicy = options.bufferPolicy ?? "drop-oldest";
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
      readySettled: false,
      pending: []
    };
    channels.set(name, state);
    return state;
  }

  function bufferIncoming(state: ChannelState, packet: RpcPacket) {
    if (bufferSize === 0) return;
    if (state.pending.length < bufferSize) {
      state.pending.push(packet);
      return;
    }
    if (bufferPolicy === "drop-oldest") {
      state.pending.shift();
      state.pending.push(packet);
    }
    // drop-newest: leave the queue alone, discard the new packet
  }

  function settleReady(state: ChannelState, action: () => void) {
    if (state.readySettled) return;
    state.readySettled = true;
    if (state.readyTimer) clearTimeout(state.readyTimer);
    action();
  }

  function sendHello(name: string) {
    const frame: DemuxHelloFrame = { channel: name, hello: true };
    base.send!(frame as unknown as RpcPacket);
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
      if (state.handler) {
        state.handler(data.packet);
      } else {
        bufferIncoming(state, data.packet);
      }
    }
  });

  return {
    channel(name) {
      if (disposed) throw new Error(`Demuxer disposed; cannot open channel "${name}"`);
      const state = getOrCreateState(name);

      const transport: RpcTransport = {
        send(packet) {
          if (disposed) throw new Error(`Demuxer disposed; cannot send on channel "${name}"`);
          const envelope: DemuxPacketEnvelope = { channel: name, packet };
          base.send!(envelope as unknown as RpcPacket);
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

          // Drain after handshake bookkeeping so a thrown handler doesn't
          // leave HELLO unsent or the ready promise un-armed. Handler errors
          // during drain are swallowed so one bad packet doesn't drop the rest;
          // synchronous throws from RPC handlers are a consumer bug.
          if (state.pending.length > 0) {
            const drained = state.pending;
            state.pending = [];
            for (const packet of drained) {
              try { handler(packet); } catch { /* drain continues */ }
            }
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
        state.pending.length = 0;
      }
      channels.clear();
      base.unregisterHandler?.();
    }
  };
}
