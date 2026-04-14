import "../shared/webviewPolyfill";
import {
  defineBuniteRPC,
  type BuniteRPCConfig,
  type RPCPacket,
  type BuniteRPCSchema,
  type RPCSchema,
  type RPCTransport,
  type RPCWithTransport
} from "../shared/rpc";
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

export class BuniteView<T extends RPCWithTransport> {
  bunSocket?: WebSocket;
  rpc?: T;
  rpcHandler?: (message: unknown) => void;
  private pendingPackets: RPCPacket[] = [];

  constructor(config: { rpc: T }) {
    this.rpc = config.rpc;
    this.init();
  }

  init() {
    this.initSocketToBun();
    if (isNative) {
      buniteWindow.__bunite ??= {};
      buniteWindow.__bunite.receiveMessageFromBun = this.receiveMessageFromBun.bind(this);
    }
    this.rpc?.setTransport(this.createTransport());
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
        const bytes = await this.messageToUint8Array(event.data);
        if (!bytes) return;
        try {
          this.rpcHandler?.(decodeRPCPacket(bytes));
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
        const binaryMessage = await this.messageToUint8Array(event.data);
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
          this.rpcHandler?.(packet);
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

  async messageToUint8Array(data: unknown) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    if (data instanceof Uint8Array) return data;
    return null;
  }

  createTransport(): RPCTransport {
    return {
      send: (message) => {
        if (this.bunSocket?.readyState === WebSocket.OPEN) {
          this.sendPacket(message);
        } else if (this.bunSocket?.readyState === WebSocket.CONNECTING) {
          this.pendingPackets.push(message);
        }
      },
      registerHandler: (handler: (packet: any) => void) => {
        this.rpcHandler = handler;
      },
      unregisterHandler: () => {
        this.rpcHandler = undefined;
      }
    };
  }

  receiveMessageFromBun(message: unknown) {
    this.rpcHandler?.(message);
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

  static defineRPC<Schema extends BuniteRPCSchema>(
    config: BuniteRPCConfig<Schema, "webview">
  ) {
    const rpc = defineBuniteRPC("webview", config);
    new BuniteView({ rpc });
    return rpc;
  }
}

export { log, type LogLevel } from "../shared/log";

export type {
  BuniteRPCConfig,
  BuniteRPCSchema,
  RPCSchema
};
