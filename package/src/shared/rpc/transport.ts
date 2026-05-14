import { type Frame, createCodec, isFrame } from "./wire";
import type { Transport } from "./peer";

export interface BytesPipe {
  send(bytes: Uint8Array): void;
  setReceive(handler: (bytes: Uint8Array) => void): void;
  close(): void;
}

export interface FrameTransportOptions {
  onProtocolError?(reason: string): void;
}

export function createFrameTransport(pipe: BytesPipe, opts: FrameTransportOptions = {}): Transport {
  const codec = createCodec();
  let handler: ((frame: Frame) => void) | undefined;

  pipe.setReceive((bytes) => {
    let frame: unknown;
    try {
      frame = codec.unpackr.unpack(bytes);
    } catch (err) {
      opts.onProtocolError?.(`unpack failed: ${err instanceof Error ? err.message : String(err)}`);
      pipe.close();
      return;
    }
    if (!isFrame(frame)) {
      opts.onProtocolError?.("malformed frame");
      pipe.close();
      return;
    }
    handler?.(frame);
  });

  return {
    send(frame) {
      const bytes = codec.packr.pack(frame);
      pipe.send(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    },
    setReceive(h) {
      handler = h;
    },
    close() {
      pipe.close();
    },
  };
}

export interface WebSocketLike {
  send(data: Uint8Array | ArrayBuffer): unknown;
  addEventListener(type: "message", listener: (event: { data: ArrayBuffer | Uint8Array | Blob | string }) => void): void;
  removeEventListener?(type: "message", listener: (event: { data: ArrayBuffer | Uint8Array | Blob | string }) => void): void;
  close?(): void;
}

export function createWebSocketPipe(ws: WebSocketLike): BytesPipe {
  if ("binaryType" in ws) {
    try { (ws as { binaryType?: string }).binaryType = "arraybuffer"; } catch { /* readonly in some envs */ }
  }
  let handler: ((bytes: Uint8Array) => void) | undefined;
  const onMessage = (event: { data: ArrayBuffer | Uint8Array | Blob | string }) => {
    if (!handler) return;
    const d = event.data;
    if (d instanceof Uint8Array) { handler(d); return; }
    if (d instanceof ArrayBuffer) { handler(new Uint8Array(d)); return; }
    if (typeof Blob !== "undefined" && d instanceof Blob) {
      void d.arrayBuffer().then((buf) => handler?.(new Uint8Array(buf)));
      return;
    }
  };
  ws.addEventListener("message", onMessage);
  return {
    send(bytes) { ws.send(bytes); },
    setReceive(h) { handler = h; },
    close() {
      ws.removeEventListener?.("message", onMessage);
      ws.close?.();
    },
  };
}

export interface PostMessageChannel {
  postMessage(data: Uint8Array): void;
  onMessage(handler: (bytes: Uint8Array) => void): () => void;
  close(): void;
}

export function createPostMessagePipe(channel: PostMessageChannel): BytesPipe {
  let unsub: (() => void) | undefined;
  return {
    send(bytes) { channel.postMessage(bytes); },
    setReceive(h) {
      unsub?.();
      unsub = channel.onMessage(h);
    },
    close() {
      unsub?.();
      channel.close();
    },
  };
}

export function createInMemoryPipePair(): [BytesPipe, BytesPipe] {
  let aRecv: ((bytes: Uint8Array) => void) | undefined;
  let bRecv: ((bytes: Uint8Array) => void) | undefined;
  return [
    {
      send: (bytes) => queueMicrotask(() => bRecv?.(bytes)),
      setReceive: (h) => { aRecv = h; },
      close: () => {},
    },
    {
      send: (bytes) => queueMicrotask(() => aRecv?.(bytes)),
      setReceive: (h) => { bRecv = h; },
      close: () => {},
    },
  ];
}
