import { Packr, Unpackr, addExtension } from "msgpackr";
import type { IpcStatus } from "./error";

export type u32 = number;
export type u53 = number;

export const CAP_REF_EXT = 0x50;

export class CapRef {
  constructor(public readonly capId: u32) {}
}

export type Target = { kind: "cap"; id: u32 };

export interface CallMeta {
  parentCallId?: u53;
  deadlineMs?: u32;
  context?: Record<string, string>;
}

export type StreamEvent =
  | { ev: "next"; value: unknown }
  | { ev: "credit"; credit: { messages?: u32 } }
  | { ev: "end" }
  | { ev: "error"; error: IpcStatus };

export type Frame =
  | {
      op: "hello";
      v: 1;
      mode: "native" | "web";
      features: string[];
      maxBytes: number;
      origin: string;
    }
  | { op: "goaway"; reason?: string; error?: IpcStatus }
  | {
      op: "call";
      id: u53;
      target: Target;
      method: string;
      args: unknown;
      meta?: CallMeta;
    }
  | { op: "result"; id: u53; ok: true; value: unknown }
  | { op: "result"; id: u53; ok: false; error: IpcStatus }
  | { op: "cancel"; id: u53; reason?: string }
  | ({ op: "stream"; id: u53 } & StreamEvent)
  | { op: "drop"; caps: { id: u32; delta: u32 }[] }
  | { op: "cap_revoked"; capIds: u32[] };

export type CallFrame = Extract<Frame, { op: "call" }>;
export type ResultFrame = Extract<Frame, { op: "result" }>;
export type StreamFrame = Extract<Frame, { op: "stream" }>;
export type CancelFrame = Extract<Frame, { op: "cancel" }>;
export type DropFrame = Extract<Frame, { op: "drop" }>;
export type HelloFrame = Extract<Frame, { op: "hello" }>;
export type GoAwayFrame = Extract<Frame, { op: "goaway" }>;
export type CapRevokedFrame = Extract<Frame, { op: "cap_revoked" }>;

const OPS = new Set<Frame["op"]>([
  "hello",
  "goaway",
  "call",
  "result",
  "cancel",
  "stream",
  "drop",
  "cap_revoked",
]);

export function isFrame(value: unknown): value is Frame {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  const op = f.op;
  if (typeof op !== "string" || !OPS.has(op as Frame["op"])) return false;
  switch (op as Frame["op"]) {
    case "hello":
      return f.v === 1 && (f.mode === "native" || f.mode === "web")
        && Array.isArray(f.features) && typeof f.maxBytes === "number" && typeof f.origin === "string";
    case "goaway":
      return f.reason === undefined || typeof f.reason === "string";
    case "call":
      return typeof f.id === "number" && typeof f.method === "string"
        && typeof f.target === "object" && f.target !== null
        && (f.target as { kind?: unknown }).kind === "cap"
        && typeof (f.target as { id?: unknown }).id === "number";
    case "result":
      return typeof f.id === "number" && (f.ok === true || f.ok === false);
    case "cancel":
      return typeof f.id === "number";
    case "stream":
      return typeof f.id === "number" && typeof f.ev === "string"
        && (f.ev === "next" || f.ev === "credit" || f.ev === "end" || f.ev === "error");
    case "drop":
      return Array.isArray(f.caps);
    case "cap_revoked":
      if (!Array.isArray(f.capIds)) return false;
      for (const id of f.capIds) {
        if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || id > 0xFFFFFFFF) return false;
      }
      return true;
  }
}

let extensionsRegistered = false;
function registerExtensions() {
  if (extensionsRegistered) return;
  extensionsRegistered = true;
  addExtension({
    Class: CapRef,
    type: CAP_REF_EXT,
    pack: (cap: CapRef) => packCapId(cap.capId),
    unpack: (buf: Buffer | Uint8Array) => new CapRef(readVarUint(buf)),
  });
}

export interface CodecPair {
  packr: Packr;
  unpackr: Unpackr;
}

export function createCodec(): CodecPair {
  registerExtensions();
  return {
    packr: new Packr({ useRecords: true, sequential: true, moreTypes: true }),
    unpackr: new Unpackr({ useRecords: true, sequential: true, moreTypes: true }),
  };
}

function packCapId(capId: number): Uint8Array {
  const buf = new Uint8Array(5);
  let n = capId >>> 0;
  let i = 0;
  while (n >= 0x80) {
    buf[i++] = (n & 0x7f) | 0x80;
    n >>>= 7;
  }
  buf[i++] = n & 0x7f;
  return buf.subarray(0, i);
}

const MAX_VARUINT_BYTES = 5;
function readVarUint(buf: Buffer | Uint8Array): number {
  let result = 0;
  let shift = 0;
  const limit = Math.min(buf.length, MAX_VARUINT_BYTES);
  for (let i = 0; i < limit; i++) {
    const byte = buf[i];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result >>> 0;
    shift += 7;
  }
  throw new Error("Truncated or oversize varuint");
}

export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export const PROTOCOL_VERSION = 1;

/** Reserved cap-name prefix for framework caps. User caps starting with this prefix are rejected. */
export const FRAMEWORK_NAME_PREFIX = "bunite.";

/** Synthetic method on cap-id 0 — dispatches to the bootstrap registry. */
export const BOOTSTRAP_METHOD = "bootstrap";
