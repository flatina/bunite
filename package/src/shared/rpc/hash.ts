import {
  type Schema,
  type CapDef,
  type MethodDef,
  type DisposalSpec,
  type AnyCapToken,
  type ReturnsKind,
  isCallDef,
  isStreamDef,
  isCapRef,
  isCapArray,
  isCapRecord,
  _bindTopologyHash,
} from "./schema";

type CanonicalReturns =
  | { kind: "type" }
  | { kind: "cap" | "capArray" | "capRecord"; capIndex: number };

type CanonicalMethod =
  | { name: string; kind: "call"; idempotent: boolean; returns: CanonicalReturns }
  | { name: string; kind: "stream" };

type CanonicalCap = {
  methods: CanonicalMethod[];
  disposal?: { method: string; async: boolean };
};

type CanonicalRoot = {
  name: string;
  capIndex: number;
};

type CanonicalSchema = {
  v: 1;
  roots: CanonicalRoot[];
  caps: CanonicalCap[];
};

export function canonicalize(schema: Schema<any>): CanonicalSchema {
  const capIndex = new Map<CapDef<any, any>, number>();
  const caps: CanonicalCap[] = [];

  for (const declared of schema.caps) {
    if (capIndex.has(declared)) continue;
    capIndex.set(declared, caps.length);
    caps.push(null as unknown as CanonicalCap);
  }

  const intern = (c: CapDef<any, any>): number => {
    const existing = capIndex.get(c);
    if (existing !== undefined) return existing;
    const idx = caps.length;
    capIndex.set(c, idx);
    caps.push(null as unknown as CanonicalCap);
    return idx;
  };

  for (let i = 0; i < caps.length; i++) {
    if (caps[i] !== null) continue;
    const declared = schema.caps[i];
    caps[i] = capToCanonical(declared, intern);
  }

  const roots: CanonicalRoot[] = Object.keys(schema.roots).map((name) => ({
    name,
    capIndex: intern(schema.roots[name]),
  }));

  for (let i = 0; i < caps.length; i++) {
    if (caps[i] !== null) continue;
    const cap = [...capIndex.keys()][i];
    caps[i] = capToCanonical(cap, intern);
  }

  return { v: 1, roots, caps };
}

function capToCanonical(c: CapDef<any, any>, intern: (c: CapDef<any, any>) => number): CanonicalCap {
  const methods: CanonicalMethod[] = Object.keys(c.methods).map((name) => {
    const m = c.methods[name] as MethodDef;
    if (isCallDef(m)) {
      return {
        name,
        kind: "call",
        idempotent: m.idempotent,
        returns: returnsToCanonical(m.returns, intern),
      };
    }
    if (isStreamDef(m)) {
      return { name, kind: "stream" };
    }
    throw new Error(`Unknown method def for "${name}"`);
  });

  const result: CanonicalCap = { methods };
  const disposal = c.disposal as DisposalSpec | undefined;
  if (disposal) {
    result.disposal = { method: disposal.method, async: !!disposal.async };
  }
  return result;
}

function returnsToCanonical(
  ret: AnyCapToken | undefined,
  intern: (c: CapDef<any, any>) => number
): CanonicalReturns {
  if (!ret) return { kind: "type" };
  if (isCapRef(ret)) return { kind: "cap", capIndex: intern(ret.cap) };
  if (isCapArray(ret)) return { kind: "capArray", capIndex: intern(ret.cap) };
  if (isCapRecord(ret)) return { kind: "capRecord", capIndex: intern(ret.cap) };
  return { kind: "type" };
}

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJSON).join(",") + "]";
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value as object).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON((value as Record<string, unknown>)[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

export async function topologyHash(schema: Schema<any>): Promise<string> {
  const canonical = canonicalize(schema);
  const json = canonicalJSON(canonical);
  const bytes = new TextEncoder().encode(json);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

_bindTopologyHash(topologyHash);
