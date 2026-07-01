import type { CloseInfo, Transport } from "./peer";
import { createCodec, type Frame, isFrame } from "./wire";

export interface BytesPipe {
  send(bytes: Uint8Array): void;
  setReceive(handler: (bytes: Uint8Array) => void): void;
  close(): void;
  onClose?(handler: (info?: CloseInfo) => void): void;
}

export interface FrameTransportOptions {
  onProtocolError?(reason: string): void;
}

export function createFrameTransport(pipe: BytesPipe, opts: FrameTransportOptions = {}): Transport {
  const codec = createCodec();
  let handler: ((frame: Frame) => void) | undefined;
  let closeHandler: ((info?: CloseInfo) => void) | undefined;
  let closeFired = false;
  // Fire once for any close cause — pipe disconnect (WS close/error) or a
  // protocol error that forces pipe.close() — so the Connection always tears down.
  const fireClose = (info?: CloseInfo) => {
    if (closeFired) return;
    closeFired = true;
    closeHandler?.(info);
  };
  pipe.onClose?.(fireClose);

  pipe.setReceive((bytes) => {
    let frame: unknown;
    try {
      frame = codec.unpackr.unpack(bytes);
    } catch (err) {
      opts.onProtocolError?.(`unpack failed: ${err instanceof Error ? err.message : String(err)}`);
      fireClose();
      pipe.close();
      return;
    }
    if (!isFrame(frame)) {
      opts.onProtocolError?.("malformed frame");
      fireClose();
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
    onClose(h) {
      closeHandler = h;
    },
  };
}

type WsMessageEvent = { data: ArrayBuffer | Uint8Array | Blob | string };
type WsCloseEvent = { code?: number; reason?: string };

export interface WebSocketLike {
  send(data: Uint8Array | ArrayBuffer): unknown;
  addEventListener(type: "message", listener: (event: WsMessageEvent) => void): void;
  removeEventListener?(type: "message", listener: (event: WsMessageEvent) => void): void;
  close?(): void;
}

// close/error listeners — real WebSockets have them; kept off the public type so
// message-only implementations stay assignable.
type WsLifecycle = {
  addEventListener(type: "close", listener: (event: WsCloseEvent) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  removeEventListener?(type: "close", listener: (event: WsCloseEvent) => void): void;
  removeEventListener?(type: "error", listener: (event: unknown) => void): void;
};

export function createWebSocketPipe(ws: WebSocketLike): BytesPipe {
  if ("binaryType" in ws) {
    try {
      (ws as { binaryType?: string }).binaryType = "arraybuffer";
    } catch {
      /* readonly in some envs */
    }
  }
  const wsLife = ws as WebSocketLike & WsLifecycle;
  let handler: ((bytes: Uint8Array) => void) | undefined;
  let closeHandler: ((info?: CloseInfo) => void) | undefined;
  let closeFired = false;
  const onMessage = (event: WsMessageEvent) => {
    if (!handler) return;
    const d = event.data;
    if (d instanceof Uint8Array) {
      handler(d);
      return;
    }
    if (d instanceof ArrayBuffer) {
      handler(new Uint8Array(d));
      return;
    }
    if (typeof Blob !== "undefined" && d instanceof Blob) {
      void d.arrayBuffer().then((buf) => handler?.(new Uint8Array(buf)));
      return;
    }
  };
  const detach = () => {
    ws.removeEventListener?.("message", onMessage);
    wsLife.removeEventListener?.("close", onClose);
    wsLife.removeEventListener?.("error", onError);
  };
  const fireClose = (info?: CloseInfo) => {
    if (closeFired) return;
    closeFired = true;
    detach();
    closeHandler?.(info);
  };
  const onClose = (event: WsCloseEvent) => fireClose({ code: event?.code, reason: event?.reason });
  // `error` is usually followed by `close` (which carries code/reason); defer so
  // close wins, and this still fires for an error with no following close.
  const onError = () => setTimeout(() => fireClose(), 0);
  ws.addEventListener("message", onMessage);
  wsLife.addEventListener("close", onClose);
  wsLife.addEventListener("error", onError);
  return {
    send(bytes) {
      ws.send(bytes);
    },
    setReceive(h) {
      handler = h;
    },
    onClose(h) {
      closeHandler = h;
    },
    close() {
      detach();
      ws.close?.();
    },
  };
}
