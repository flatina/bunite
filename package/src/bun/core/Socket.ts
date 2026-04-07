import type { Server, ServerWebSocket } from "bun";
import type { BrowserView } from "./BrowserView";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { RPCPacket } from "../../shared/rpc";
import {
  asUint8Array,
  createEncryptedRPCFrame,
  decodeRPCPacket,
  encodeRPCPacket,
  parseEncryptedRPCFrame
} from "../../shared/rpcWire";
import { RPC_AUTH_TAG_LENGTH } from "../../shared/rpcWireConstants";

type ViewRegistry = {
  getById(id: number): BrowserView | undefined;
};

type WebSocketData = {
  webviewId: number;
};

let rpcServer: Server<WebSocketData> | null = null;
let rpcPort = 0;

const socketMap: Record<number, ServerWebSocket<WebSocketData> | null> = {};
let registry: ViewRegistry | null = null;

function encrypt(secretKey: Uint8Array, payload: Uint8Array) {
  const iv = new Uint8Array(randomBytes(12));
  const cipher = createCipheriv("aes-256-gcm", secretKey, iv);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  return createEncryptedRPCFrame(iv, new Uint8Array(encrypted));
}

function decrypt(secretKey: Uint8Array, frame: Uint8Array) {
  const { iv, encryptedPayload } = parseEncryptedRPCFrame(frame);
  const ciphertext = encryptedPayload.subarray(0, encryptedPayload.byteLength - RPC_AUTH_TAG_LENGTH);
  const tag = encryptedPayload.subarray(encryptedPayload.byteLength - RPC_AUTH_TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", secretKey, iv);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
}

function normalizeIncomingBinaryMessage(
  message: string | ArrayBuffer | Uint8Array | Buffer
): Uint8Array | null {
  if (typeof message === "string") {
    return null;
  }
  return asUint8Array(message);
}

export function attachBrowserViewRegistry(nextRegistry: ViewRegistry) {
  registry = nextRegistry;
}

export function ensureRPCServer() {
  if (rpcServer) {
    return { rpcServer, rpcPort };
  }

  let port = 45000;
  while (port <= 65535) {
    try {
      rpcServer = Bun.serve<WebSocketData>({
        hostname: "127.0.0.1",
        port,
        fetch(req, server) {
          const url = new URL(req.url);
          if (url.pathname !== "/socket") {
            return new Response("Not found", { status: 404 });
          }

          const webviewId = Number(url.searchParams.get("webviewId"));
          if (!Number.isFinite(webviewId)) {
            return new Response("Missing webviewId", { status: 400 });
          }
          if (!registry?.getById(webviewId)) {
            return new Response("Unknown webviewId", { status: 403 });
          }

          const upgraded = server.upgrade(req, {
            data: { webviewId }
          });
          return upgraded ? undefined : new Response("Upgrade failed", { status: 500 });
        },
        websocket: {
          open(ws) {
            socketMap[ws.data.webviewId] = ws;
          },
          close(ws) {
            socketMap[ws.data.webviewId] = null;
          },
          message(ws, message) {
            const view = registry?.getById(ws.data.webviewId);
            const binaryMessage = normalizeIncomingBinaryMessage(message);
            if (!view || !binaryMessage) {
              return;
            }
            try {
              const decryptedMessage = decrypt(view.secretKey, binaryMessage);
              view.handleIncomingRPC(decodeRPCPacket(decryptedMessage));
            } catch (error) {
              console.error("[bunite] Failed to parse RPC payload", error);
            }
          }
        }
      });
      rpcPort = port;
      break;
    } catch (error: any) {
      if (error?.code === "EADDRINUSE") {
        port += 1;
        continue;
      }
      throw error;
    }
  }

  if (!rpcServer) {
    throw new Error("Could not start bunite RPC server.");
  }

  return { rpcServer, rpcPort };
}

export function getRPCPort(): number {
  return rpcPort;
}

export function sendMessageToView(viewId: number, message: RPCPacket): boolean {
  const socket = socketMap[viewId];
  const view = registry?.getById(viewId);
  if (!socket || socket.readyState !== WebSocket.OPEN || !view) {
    return false;
  }

  const encrypted = encrypt(view.secretKey, encodeRPCPacket(message));
  socket.send(encrypted);
  return true;
}
