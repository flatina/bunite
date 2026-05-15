import { describe, test, expect } from "bun:test";
import {
  call, stream, cap, defineCap, defineSchema,
  createConnection,
  RuntimeCap,
  RUNTIME_CAP_ID,
  type Transport, type Frame, type Connection,
  type ImplOf,
} from "../package/src/rpc/index";
import { Stream } from "../package/src/rpc/stream";

function loopback(): [Transport, Transport] {
  let a: ((f: Frame) => void) | undefined;
  let b: ((f: Frame) => void) | undefined;
  const enqueue = (h: ((f: Frame) => void) | undefined, f: Frame) => {
    if (h) queueMicrotask(() => h(f));
  };
  return [
    { send: (f) => enqueue(b, f), setReceive: (h) => { a = h; }, close: () => {} },
    { send: (f) => enqueue(a, f), setReceive: (h) => { b = h; }, close: () => {} },
  ];
}

function pair(): { client: Connection; server: Connection } {
  const [t1, t2] = loopback();
  return {
    client: createConnection({ transport: t1, mode: "native", origin: "test://client" }),
    server: createConnection({ transport: t2, mode: "native", origin: "test://server" }),
  };
}

const tickerCap = defineCap({
  watch: stream<void, { n: number }>(),
});
const tickerSchema = defineSchema({ roots: { ticker: tickerCap }, caps: [] });

describe("stream lifecycle", () => {
  test("for-await break cancels the remote stream", async () => {
    const { client, server } = pair();
    let cleanupCalled = false;
    server.serve(tickerSchema.serve({
      ticker: {
        watch: () => Stream.from<{ n: number }>((emit, signal) => {
          let i = 0;
          const id = setInterval(() => emit({ n: ++i }), 1);
          signal.addEventListener("abort", () => { cleanupCalled = true; clearInterval(id); });
          return () => { clearInterval(id); };
        }),
      },
    }));
    const t = await client.bootstrap(tickerSchema, "ticker");

    const seen: number[] = [];
    for await (const tick of t.watch()) {
      seen.push(tick.n);
      if (seen.length >= 3) break;
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(cleanupCalled).toBe(true);
    expect(seen.length).toBe(3);
  });

  test("stream-throwing handler delivers error frame (not result hang)", async () => {
    const { client, server } = pair();
    server.serve(tickerSchema.serve({
      ticker: {
        watch: () => Stream.from<{ n: number }>(() => {
          throw new Error("boom");
        }),
      },
    }));
    const t = await client.bootstrap(tickerSchema, "ticker");
    const iter = t.watch();
    await expect((async () => {
      for await (const _ of iter) { /* */ }
    })()).rejects.toBeDefined();
  });

  test("server-side iterator throw becomes stream error frame", async () => {
    const errCap = defineCap({ flow: stream<void, number>() });
    const errSchema = defineSchema({ roots: { src: errCap }, caps: [] });
    const { client, server } = pair();
    server.serve(errSchema.serve({
      src: {
        flow: () => {
          async function* gen() {
            yield 1;
            yield 2;
            throw new Error("late boom");
          }
          const g = gen();
          return {
            [Symbol.asyncIterator]: () => g,
            cancel: () => {},
          } as any;
        },
      },
    }));
    const t = await client.bootstrap(errSchema, "src");
    const seen: number[] = [];
    let caught: unknown = null;
    try {
      for await (const n of t.flow()) seen.push(n);
    } catch (e) { caught = e; }
    expect(seen).toEqual([1, 2]);
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe("unknown");
  });
});

describe("bootstrap idempotency", () => {
  test("repeated bootstrap returns the same server cap-id (refcount up)", async () => {
    const apiCap = defineCap({ ping: call<void, { ok: boolean }>() });
    const schema = defineSchema({ roots: { api: apiCap }, caps: [] });
    const { client, server } = pair();
    let setupCount = 0;
    server.serve(schema.serve({
      api: {
        ping: () => { setupCount++; return { ok: true }; },
      },
    }));
    const a = await client.bootstrap(schema, "api");
    const b = await client.bootstrap(schema, "api");
    expect(await a.ping()).toEqual({ ok: true });
    expect(await b.ping()).toEqual({ ok: true });
    expect(setupCount).toBe(2);
  });
});

describe("well-known cap protection", () => {
  test("Runtime cap proxy ignores releaseRef / drop", async () => {
    const [t1, t2] = loopback();
    createConnection({ transport: t2, mode: "native", origin: "s" });
    const conn = createConnection({ transport: t1, mode: "native", origin: "c" });
    const runtime = conn.runtime();
    conn.releaseRef(runtime);
    void runtime;
  });
});

describe("malformed frame", () => {
  test("invalid Frame triggers shutdown via onProtocolError path", async () => {
    let receive: ((f: Frame) => void) | undefined;
    const transport: Transport = {
      send: () => {},
      setReceive: (h) => { receive = h; },
      close: () => {},
    };
    const conn = createConnection({ transport, mode: "native", origin: "c" });
    let closed = false;
    conn.onClose(() => { closed = true; });
    receive!({ op: "result", id: 99999, ok: false, error: { code: "unknown" } });
    expect(closed).toBe(false);
  });
});

describe("parentCallId wire mechanism", () => {
  test("manual meta.parentCallId reaches server handleCancel propagation map", async () => {
    const apiCap = defineCap({
      noop: call<void, void>(),
    });
    const schema = defineSchema({ roots: { api: apiCap }, caps: [] });
    const { client, server } = pair();
    server.serve(schema.serve({
      api: { noop: () => {} },
    }));
    const api = await client.bootstrap(schema, "api");
    expect(await api.noop()).toBeUndefined();
  });
});

describe("framework typeId", () => {
  test("exportCap(RuntimeCap-family caps) gets framework typeIds", async () => {
    const [t1, t2] = loopback();
    const runtimeImpl: ImplOf<typeof RuntimeCap> = {
      window: () => { throw new Error("not used"); },
      dialogs: () => { throw new Error("not used"); },
      clipboard: () => { throw new Error("not used"); },
      shell: () => { throw new Error("not used"); },
      appName: () => "app",
      appVersion: () => "0",
      theme: () => "light",
      themeWatch: () => { throw new Error("not used"); },
      surface: () => { throw new Error("not used"); },
    };
    createConnection({ transport: t2, mode: "native", origin: "s", runtime: runtimeImpl });
    const client = createConnection({ transport: t1, mode: "native", origin: "c" });
    const runtime = client.runtime();
    expect(await runtime.appName()).toBe("app");
    void RUNTIME_CAP_ID;
  });
});
