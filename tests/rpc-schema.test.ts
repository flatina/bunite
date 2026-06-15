import { describe, expect, test } from "bun:test";
import {
  CapRef,
  CapTable,
  type ClientOf,
  call,
  cap,
  createCodec,
  defineCap,
  FIRST_USER_CAP_ID,
  type ImplOf,
  IpcError,
  isFrame,
  MAX_CAPS_PER_CONNECTION,
  returnsKindOf,
  stream,
} from "../package/src/rpc/index";

const PlotCap = defineCap(
  "test.Plot",
  {
    setData: call<{ data: Float32Array }, void>(),
    render: call<void, { svg: string }>(),
    watch: stream<void, { tick: number }>(),
    dispose: call<void, void>(),
  },
  { disposal: { method: "dispose" } },
);

const counterCap = defineCap("test.counter", {
  getCount: call<void, { count: number }>(),
  increment: call<{ delta?: number }, { count: number }>(),
  reset: call<void, { count: number }>({ idempotent: true }),
  watch: stream<void, { count: number }>(),
  createPlot: call<{ initial: Float32Array }, typeof PlotCap>({ returns: cap(PlotCap) }),
  listPlots: call<void, typeof PlotCap>({ returns: cap.array(PlotCap) }),
  namedPlots: call<void, typeof PlotCap>({ returns: cap.record(PlotCap) }),
});

describe("schema primitives", () => {
  test("call/stream/cap tokens are tagged", () => {
    expect(returnsKindOf(undefined)).toBe("type");
    expect(returnsKindOf(cap(PlotCap))).toBe("cap");
    expect(returnsKindOf(cap.array(PlotCap))).toBe("capArray");
    expect(returnsKindOf(cap.record(PlotCap))).toBe("capRecord");
  });

  test("defineCap carries name + optional version", () => {
    expect(counterCap.name).toBe("test.counter");
    expect(counterCap.version).toBeUndefined();
    const v2 = defineCap("test.versioned", { x: call<void, void>() }, { version: 2 });
    expect(v2.version).toBe("2");
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

  test("isFrame validates op tag and method-as-string", () => {
    expect(
      isFrame({ op: "call", id: 1, target: { kind: "cap", id: 0 }, method: "ping", args: null }),
    ).toBe(true);
    expect(
      isFrame({ op: "call", id: 1, target: { kind: "cap", id: 0 }, method: 7, args: null }),
    ).toBe(false);
    expect(isFrame({ op: "cap_revoked", capIds: [1, 2] })).toBe(true);
    expect(isFrame({ op: "bogus" })).toBe(false);
    expect(isFrame(null)).toBe(false);
  });
});

describe("IpcError", () => {
  test("preserves code/details/retry", () => {
    const err = new IpcError({
      code: "failed_precondition",
      message: "cap revoked",
      details: { reason: "revoked" },
      retry: { kind: "after-resync" },
    });
    expect(err.code).toBe("failed_precondition");
    expect(err.message).toBe("cap revoked");
    expect(err.details).toEqual({ reason: "revoked" });
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
    expect(t.allocate({ typeId: 128, cap: null, impl: null, refCount: 1 }).capId).toBe(
      FIRST_USER_CAP_ID + 1,
    );
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
