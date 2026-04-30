import { registerBuniteWebviewPolyfill } from "../shared/webviewPolyfill";
import {
  defineWebviewRpc,
  type BuniteRpcConfig,
  type RpcPacket,
  type BuniteRpcSchema,
  type RpcSchema,
  type RpcTransport,
  type RpcWithTransport
} from "../shared/rpc";
import { createRpcTransportDemuxer, type RpcChannelHandle, type RpcTransportDemuxer, type RpcTransportDemuxerOptions } from "../shared/rpcDemux";
import { createWebSocketTransport, type WebSocketLike, type WebSocketTransportPipe } from "../shared/webSocketTransport";
import { decodeRpcPacket, encodeRpcPacket } from "../shared/rpcWire";
import { log } from "../shared/log";

type BuniteWindowGlobals = Window &
  typeof globalThis & {
    __buniteWebviewId?: number;
    __buniteRpcSocketPort?: number;
    __bunite?: {
      receiveMessageFromBun?: (message: unknown) => void;
    };
    __bunite_encrypt?: (data: Uint8Array) => Promise<Uint8Array>;
    __bunite_decrypt?: (data: Uint8Array) => Promise<Uint8Array>;
  };

type BuniteEnv = {
  window: BuniteWindowGlobals | null;
  webviewId: number | undefined;
  rpcPort: number | undefined;
  isNative: boolean;
};

function readBuniteEnv(): BuniteEnv {
  const w = typeof window !== "undefined" ? (window as BuniteWindowGlobals) : null;
  const webviewId = w?.__buniteWebviewId;
  const rpcPort = w?.__buniteRpcSocketPort;
  return { window: w, webviewId, rpcPort, isNative: webviewId != null && rpcPort != null };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export class BuniteView<T extends RpcWithTransport = RpcWithTransport> {
  bunSocket?: WebSocket;
  rpc?: T;
  readonly transport: RpcTransport;

  private env: BuniteEnv;
  private handler?: (packet: RpcPacket) => void;
  private pendingPackets: RpcPacket[] = [];

  constructor(config?: { rpc?: T }) {
    registerBuniteWebviewPolyfill();
    this.env = readBuniteEnv();
    this.rpc = config?.rpc;

    this.transport = {
      send: (packet) => {
        if (this.bunSocket?.readyState === WebSocket.OPEN) {
          this.sendPacket(packet);
        } else if (this.bunSocket?.readyState === WebSocket.CONNECTING) {
          this.pendingPackets.push(packet);
        }
      },
      registerHandler: (h) => { this.handler = h; },
      unregisterHandler: () => { this.handler = undefined; }
    };

    this.initSocketToBun();
    if (this.env.isNative && this.env.window) {
      this.env.window.__bunite ??= {};
      this.env.window.__bunite.receiveMessageFromBun = (message) => {
        this.handler?.(message as RpcPacket);
      };
    }
    this.rpc?.setTransport(this.transport);
  }

  private sendPacket(packet: RpcPacket) {
    if (this.env.isNative) {
      void this.bunBridge(packet).catch((error) => {
        log.error("Failed to send RPC packet", error);
      });
    } else {
      this.bunSocket!.send(toArrayBuffer(encodeRpcPacket(packet)));
    }
  }

  initSocketToBun() {
    if (!this.env.isNative) {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${proto}//${location.host}/rpc`);
      socket.binaryType = "arraybuffer";
      this.bunSocket = socket;

      socket.addEventListener("message", async (event) => {
        const bytes = await messageToUint8Array(event.data);
        if (!bytes) return;
        try {
          this.handler?.(decodeRpcPacket(bytes));
        } catch (error) {
          log.error("Failed to parse WebSocket message", error);
        }
      });
    } else {
      // Share a single WebSocket with the preload's bunite.invoke.
      const globals = this.env.window as any;
      globals.__bunite ??= {};
      const existing = globals.__bunite._socket;
      if (existing && existing.readyState <= WebSocket.OPEN) {
        this.bunSocket = existing;
      } else {
        const socket = new WebSocket(
          `ws://localhost:${this.env.rpcPort}/socket?webviewId=${this.env.webviewId}`
        );
        socket.binaryType = "arraybuffer";
        this.bunSocket = socket;
        globals.__bunite._socket = socket;
      }

      this.bunSocket!.addEventListener("message", async (event) => {
        const binaryMessage = await messageToUint8Array(event.data);
        if (!binaryMessage) return;

        try {
          const decrypt = this.env.window?.__bunite_decrypt;
          if (!decrypt) {
            log.error("No decrypt function available in preload globals");
            return;
          }
          const decrypted = await decrypt(binaryMessage);
          const packet = decodeRpcPacket(decrypted);
          if ((packet as any).scope === "global") return;
          this.handler?.(packet);
        } catch (error) {
          log.error("Failed to parse message from Bun", error);
        }
      });
    }

    this.bunSocket!.addEventListener("open", () => {
      for (const packet of this.pendingPackets) this.sendPacket(packet);
      this.pendingPackets = [];
    });

    this.bunSocket!.addEventListener("error", () => {
      log.error("RPC WebSocket error");
    });

    this.bunSocket!.addEventListener("close", () => {
      if (this.pendingPackets.length > 0) {
        log.error(`RPC WebSocket closed with ${this.pendingPackets.length} pending packets`);
        this.pendingPackets = [];
      }
    });
  }

  async bunBridge(message: RpcPacket) {
    if (this.bunSocket?.readyState !== WebSocket.OPEN) return;

    const encrypt = this.env.window?.__bunite_encrypt;
    if (!encrypt) {
      log.error("No encrypt function available in preload globals");
      return;
    }

    const encrypted = await encrypt(encodeRpcPacket(message));
    this.bunSocket.send(toArrayBuffer(encrypted));
  }

}

async function messageToUint8Array(data: unknown) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (data instanceof Uint8Array) return data;
  return null;
}

export { log, type LogLevel } from "../shared/log";
export { createRpcTransportDemuxer, createWebSocketTransport, defineWebviewRpc, registerBuniteWebviewPolyfill };

export type {
  BuniteRpcConfig,
  BuniteRpcSchema,
  RpcChannelHandle,
  RpcSchema,
  RpcTransportDemuxer,
  RpcTransportDemuxerOptions,
  WebSocketLike,
  WebSocketTransportPipe
};
