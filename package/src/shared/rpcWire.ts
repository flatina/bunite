import { pack, unpack } from "msgpackr";
import type { RpcPacket } from "./rpc";
import {
  RPC_AUTH_TAG_LENGTH,
  RPC_FRAME_VERSION,
  RPC_IV_LENGTH
} from "./rpcWireConstants";

export function encodeRpcPacket(packet: RpcPacket): Uint8Array {
  return pack(packet) as Uint8Array;
}

export function decodeRpcPacket(data: Uint8Array): RpcPacket {
  return unpack(data) as RpcPacket;
}

export function createEncryptedRpcFrame(
  iv: Uint8Array,
  encryptedPayload: Uint8Array
): Uint8Array {
  if (iv.byteLength !== RPC_IV_LENGTH) {
    throw new Error(`Invalid RPC IV length: expected ${RPC_IV_LENGTH}, got ${iv.byteLength}`);
  }

  const frame = new Uint8Array(1 + RPC_IV_LENGTH + encryptedPayload.byteLength);
  frame[0] = RPC_FRAME_VERSION;
  frame.set(iv, 1);
  frame.set(encryptedPayload, 1 + RPC_IV_LENGTH);
  return frame;
}

export function parseEncryptedRpcFrame(frame: Uint8Array) {
  if (frame.byteLength < 1 + RPC_IV_LENGTH + RPC_AUTH_TAG_LENGTH) {
    throw new Error("Invalid RPC frame: payload is too short.");
  }
  if (frame[0] !== RPC_FRAME_VERSION) {
    throw new Error(`Unsupported RPC frame version: ${frame[0]}`);
  }

  return {
    iv: frame.subarray(1, 1 + RPC_IV_LENGTH),
    encryptedPayload: frame.subarray(1 + RPC_IV_LENGTH)
  };
}

export function asUint8Array(data: ArrayBuffer | ArrayBufferView | Uint8Array): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}
