import "../shared/webviewPolyfill";
import {
  defineWebviewRPC,
  type BuniteRPCConfig,
  type RPCPacket,
  type BuniteRPCSchema,
  type RPCSchema,
  type RPCTransport,
  type RPCWithTransport
} from "../shared/rpc";
import { createTransportDemuxer, type TransportDemuxer } from "../shared/rpcDemux";
import { createWebSocketTransport, type WebSocketLike, type WebSocketTransportPipe } from "../shared/webSocketTransport";
import { decodeRPCPacket, encodeRPCPacket } from "../shared/rpcWire";
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

const buniteWindow = window as BuniteWindowGlobals;
const WEBVIEW_ID = buniteWindow.__buniteWebviewId;
const RPC_SOCKET_PORT = buniteWindow.__buniteRpcSocketPort;

const isNative = WEBVIEW_ID != null && RPC_SOCKET_PORT != null;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export class BuniteView<T extends RPCWithTransport = RPCWithTransport> {
  bunSocket?: WebSocket;
  rpc?: T;
  readonly transport: RPCTransport;

  private handler?: (packet: RPCPacket) => void;
  private pendingPackets: RPCPacket[] = [];

  constructor(config?: { rpc?: T }) {
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
    if (isNative) {
      buniteWindow.__bunite ??= {};
      buniteWindow.__bunite.receiveMessageFromBun = (message) => {
        this.handler?.(message as RPCPacket);
      };
    }
    this.rpc?.setTransport(this.transport);
  }

  private sendPacket(packet: RPCPacket) {
    if (isNative) {
      void this.bunBridge(packet).catch((error) => {
        log.error("Failed to send RPC packet", error);
      });
    } else {
      this.bunSocket!.send(toArrayBuffer(encodeRPCPacket(packet)));
    }
  }

  initSocketToBun() {
    if (!isNative) {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${proto}//${location.host}/rpc`);
      socket.binaryType = "arraybuffer";
      this.bunSocket = socket;

      socket.addEventListener("message", async (event) => {
        const bytes = await messageToUint8Array(event.data);
        if (!bytes) return;
        try {
          this.handler?.(decodeRPCPacket(bytes));
        } catch (error) {
          log.error("Failed to parse WebSocket message", error);
        }
      });
    } else {
      // Share a single WebSocket with the preload's bunite.invoke.
      const globals = buniteWindow as any;
      globals.__bunite ??= {};
      const existing = globals.__bunite._socket;
      if (existing && existing.readyState <= WebSocket.OPEN) {
        this.bunSocket = existing;
      } else {
        const socket = new WebSocket(
          `ws://localhost:${RPC_SOCKET_PORT}/socket?webviewId=${WEBVIEW_ID}`
        );
        socket.binaryType = "arraybuffer";
        this.bunSocket = socket;
        globals.__bunite._socket = socket;
      }

      this.bunSocket!.addEventListener("message", async (event) => {
        const binaryMessage = await messageToUint8Array(event.data);
        if (!binaryMessage) return;

        try {
          const decrypt = buniteWindow.__bunite_decrypt;
          if (!decrypt) {
            log.error("No decrypt function available in preload globals");
            return;
          }
          const decrypted = await decrypt(binaryMessage);
          const packet = decodeRPCPacket(decrypted);
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

  async bunBridge(message: RPCPacket) {
    if (this.bunSocket?.readyState !== WebSocket.OPEN) return;

    const encrypt = buniteWindow.__bunite_encrypt;
    if (!encrypt) {
      log.error("No encrypt function available in preload globals");
      return;
    }

    const encrypted = await encrypt(encodeRPCPacket(message));
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
export { createTransportDemuxer, createWebSocketTransport, defineWebviewRPC };

export type {
  BuniteRPCConfig,
  BuniteRPCSchema,
  RPCSchema,
  TransportDemuxer,
  WebSocketLike,
  WebSocketTransportPipe
};
