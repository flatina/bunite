import { describe, test, expect } from "bun:test";
import {
  call, stream, cap, defineCap, defineSchema,
  topologyHash, canonicalize, returnsKindOf,
  createCodec, CapRef, isFrame, IpcError,
  CapTable, FIRST_USER_CAP_ID, MAX_CAPS_PER_CONNECTION,
  type ClientOf, type ImplOf,
} from "../package/src/rpc/index";

const PlotCap = defineCap({
  setData: call<{ data: Float32Array }, void>(),
  render: call<void, { svg: string }>(),
  watch: stream<void, { tick: number }>(),
  dispose: call<void, void>(),
}, { disposal: { method: "dispose", async: true } });

const counterCap = defineCap({
  getCount: call<void, { count: number }>(),
  increment: call<{ delta?: number }, { count: number }>(),
  reset: call<void, { count: number }>({ idempotent: true }),
  watch: stream<void, { count: number }>(),
  createPlot: call<{ initial: Float32Array }, typeof PlotCap>({ returns: cap(PlotCap) }),
  listPlots: call<void, typeof PlotCap>({ returns: cap.array(PlotCap) }),
  namedPlots: call<void, typeof PlotCap>({ returns: cap.record(PlotCap) }),
});

const schema = defineSchema({
  roots: { counter: counterCap },
  caps: [PlotCap],
});

describe("schema primitives", () => {
  test("call/stream/cap tokens are tagged", () => {
    expect(returnsKindOf(undefined)).toBe("type");
    expect(returnsKindOf(cap(PlotCap))).toBe("cap");
    expect(returnsKindOf(cap.array(PlotCap))).toBe("capArray");
    expect(returnsKindOf(cap.record(PlotCap))).toBe("capRecord");
  });

  test("canonicalize preserves declared caps order then derives roots", () => {
    const c = canonicalize(schema);
    expect(c.v).toBe(1);
    expect(c.caps.length).toBe(2);
    expect(c.caps[0].disposal).toEqual({ method: "dispose", async: true });
    expect(c.caps[1].methods.map((m: { name: string }) => m.name)).toEqual([
      "getCount", "increment", "reset", "watch", "createPlot", "listPlots", "namedPlots",
    ]);
    expect(c.roots).toEqual([{ name: "counter", capIndex: 1 }]);
  });

  test("topologyHash is deterministic", async () => {
    const h1 = await topologyHash(schema);
    const h2 = await topologyHash(schema);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  test("topologyHash differs when method added", async () => {
    const altCap = defineCap({
      getCount: call<void, { count: number }>(),
      increment: call<{ delta?: number }, { count: number }>(),
    });
    const altSchema = defineSchema({ roots: { counter: altCap }, caps: [] });
    expect(await topologyHash(altSchema)).not.toBe(await topologyHash(schema));
  });

  test("topologyHash differs when method order changes", async () => {
    const reordered = defineCap({
      increment: call<{ delta?: number }, { count: number }>(),
      getCount: call<void, { count: number }>(),
    });
    const altSchema = defineSchema({ roots: { counter: reordered }, caps: [] });
    expect(await topologyHash(altSchema)).not.toBe(await topologyHash(schema));
  });
});

describe("wire codec", () => {
  test("CapRef round-trips through ext 0x50", () => {
    const { packr, unpackr } = createCodec();
    const original = new CapRef(42);
    const buf = packr.pack(original);
    const decoded = unpackr.unpack(buf);
    expect(decoded).toBeInstanceOf(CapRef);
    expect(decoded.capId).toBe(42);
  });

  test("CapRef round-trips for large capId", () => {
    const { packr, unpackr } = createCodec();
    const decoded = unpackr.unpack(packr.pack(new CapRef(1_000_000)));
    expect(decoded.capId).toBe(1_000_000);
  });

  test("Float32Array survives msgpackr moreTypes", () => {
    const { packr, unpackr } = createCodec();
    const arr = new Float32Array([1.5, 2.5, 3.5]);
    const decoded = unpackr.unpack(packr.pack(arr));
    expect(decoded).toBeInstanceOf(Float32Array);
    expect(Array.from(decoded)).toEqual([1.5, 2.5, 3.5]);
  });

  test("isFrame validates op tag", () => {
    expect(isFrame({ op: "call", id: 1, target: { kind: "cap", id: 0 }, method: 0, args: null })).toBe(true);
    expect(isFrame({ op: "bogus" })).toBe(false);
    expect(isFrame(null)).toBe(false);
  });
});

describe("IpcError", () => {
  test("preserves code/details/retry", () => {
    const err = new IpcError({
      code: "failed_precondition",
      message: "cap disposed",
      details: { reason: "cap_disposed" },
      retry: { kind: "after-resync" },
    });
    expect(err.code).toBe("failed_precondition");
    expect(err.message).toBe("cap disposed");
    expect(err.details).toEqual({ reason: "cap_disposed" });
    expect(err.retry).toEqual({ kind: "after-resync" });
  });
});

describe("cap-table", () => {
  test("install reserves well-known ids", () => {
    const t = new CapTable();
    t.install(0, { typeId: 0, cap: null, impl: null, refCount: 1 });
    t.install(1, { typeId: 1, cap: null, impl: null, refCount: 1 });
    expect(t.get(0)?.typeId).toBe(0);
    expect(t.get(1)?.typeId).toBe(1);
    expect(() => t.install(0, { typeId: 0, cap: null, impl: null, refCount: 1 })).toThrow();
  });

  test("allocate starts after well-known reservation", () => {
    const t = new CapTable();
    const e = t.allocate({ typeId: 128, cap: null, impl: null, refCount: 1 });
    expect(e.capId).toBe(FIRST_USER_CAP_ID);
    expect(t.allocate({ typeId: 128, cap: null, impl: null, refCount: 1 }).capId).toBe(FIRST_USER_CAP_ID + 1);
  });

  test("release drops user caps but not well-known", () => {
    const t = new CapTable();
    t.install(0, { typeId: 0, cap: null, impl: null, refCount: 1 });
    const e = t.allocate({ typeId: 128, cap: null, impl: null, refCount: 1 });
    expect(t.release(e.capId)).toBe(true);
    expect(t.get(e.capId)).toBeUndefined();
    expect(t.release(0)).toBe(false);
    expect(t.get(0)).toBeDefined();
  });

  test("allocate throws past capLimit", () => {
    const t = new CapTable(3);
    t.allocate({ typeId: 128, cap: null, impl: null, refCount: 1 });
    t.allocate({ typeId: 128, cap: null, impl: null, refCount: 1 });
    t.allocate({ typeId: 128, cap: null, impl: null, refCount: 1 });
    expect(() => t.allocate({ typeId: 128, cap: null, impl: null, refCount: 1 })).toThrow();
  });

  test("Stage 1 default limit constant", () => {
    expect(MAX_CAPS_PER_CONNECTION).toBe(1024);
  });
});

describe("type inference (compile-time)", () => {
  test("ClientOf<counterCap> shape (smoke)", () => {
    type Counter = ClientOf<typeof counterCap>;
    const _check: Counter = {} as Counter;
    void _check;
    expect(true).toBe(true);
  });

  test("ImplOf<counterCap> shape (smoke)", () => {
    type CounterImpl = ImplOf<typeof counterCap>;
    const _check: CounterImpl = {} as CounterImpl;
    void _check;
    expect(true).toBe(true);
  });
});
