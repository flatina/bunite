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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export class BuniteView<T extends RPCWithTransport> {
  bunSocket?: WebSocket;
  rpc?: T;
  rpcHandler?: (message: unknown) => void;

  constructor(config: { rpc: T }) {
    this.rpc = config.rpc;
    this.init();
  }

  init() {
    this.initSocketToBun();
    buniteWindow.__bunite ??= {};
    buniteWindow.__bunite.receiveMessageFromBun = this.receiveMessageFromBun.bind(this);
    this.rpc?.setTransport(this.createTransport());
  }

  initSocketToBun() {
    if (WEBVIEW_ID == null || RPC_SOCKET_PORT == null) {
      console.warn("[bunite] Preload globals are missing. BuniteView will stay disconnected until native preload wiring is implemented.");
      return;
    }

    const socket = new WebSocket(
      `ws://localhost:${RPC_SOCKET_PORT}/socket?webviewId=${WEBVIEW_ID}`
    );
    socket.binaryType = "arraybuffer";
    this.bunSocket = socket;

    socket.addEventListener("message", async (event) => {
      const binaryMessage = await this.messageToUint8Array(event.data);
      if (!binaryMessage) {
        return;
      }

      try {
        const decrypt = buniteWindow.__bunite_decrypt;
        if (!decrypt) {
          console.error("[bunite] No decrypt function available in preload globals");
          return;
        }
        const decrypted = await decrypt(binaryMessage);
        this.rpcHandler?.(decodeRPCPacket(decrypted));
      } catch (error) {
        console.error("[bunite] Failed to parse message from Bun", error);
      }
    });
  }

  async messageToUint8Array(data: unknown) {
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    if (data instanceof Blob) {
      return new Uint8Array(await data.arrayBuffer());
    }
    if (data instanceof Uint8Array) {
      return data;
    }
    return null;
  }

  createTransport(): RPCTransport {
    return {
      send: (message) => {
        if (this.bunSocket?.readyState === WebSocket.OPEN) {
          void this.bunBridge(message).catch((error) => {
            console.error("[bunite] Failed to send RPC packet", error);
          });
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
    if (this.bunSocket?.readyState !== WebSocket.OPEN) {
      return;
    }

    const encrypt = buniteWindow.__bunite_encrypt;
    if (!encrypt) {
      console.error("[bunite] No encrypt function available in preload globals");
      return;
    }

    const encrypted = await encrypt(encodeRPCPacket(message));
    this.bunSocket.send(toArrayBuffer(encrypted));
  }

  static defineRPC<Schema extends BuniteRPCSchema>(
    config: BuniteRPCConfig<Schema, "webview">
  ) {
    return defineBuniteRPC("webview", config);
  }
}

export type {
  BuniteRPCConfig,
  BuniteRPCSchema,
  RPCSchema
};
