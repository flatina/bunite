import { describe, test, expect } from "bun:test";
import {
  call, stream, cap, defineCap, defineSchema,
  createConnection,
  type ImplOf, type ClientOf,
  type Connection, type Transport, type Frame,
  IpcError,
} from "../package/src/shared/rpc/index";
import { Stream } from "../package/src/shared/rpc/server";

function loopback(): [Transport, Transport] {
  let a: ((f: Frame) => void) | undefined;
  let b: ((f: Frame) => void) | undefined;
  const enqueue = (h: ((f: Frame) => void) | undefined, f: Frame) => {
    if (h) queueMicrotask(() => h(f));
  };
  const left: Transport = {
    send: (f) => enqueue(b, f),
    setReceive: (h) => { a = h; },
    close: () => {},
  };
  const right: Transport = {
    send: (f) => enqueue(a, f),
    setReceive: (h) => { b = h; },
    close: () => {},
  };
  return [left, right];
}

function pair(): { client: Connection; server: Connection } {
  const [t1, t2] = loopback();
  return {
    client: createConnection({ transport: t1, mode: "native", origin: "test://client" }),
    server: createConnection({ transport: t2, mode: "native", origin: "test://server" }),
  };
}

type CounterTick = { count: number };

const counterCap = defineCap({
  getCount: call<void, { count: number }>(),
  increment: call<{ delta?: number }, { count: number }>(),
  reset: call<void, { count: number }>({ idempotent: true }),
  watch: stream<void, CounterTick>(),
});

const schema = defineSchema({
  roots: { counter: counterCap },
  caps: [],
});

function makeCounterServer(): ImplOf<typeof counterCap> {
  let count = 0;
  const subs = new Set<(tick: CounterTick) => void>();
  return {
    getCount: () => ({ count }),
    increment: ({ delta = 1 } = {}) => {
      count += Math.trunc(delta);
      for (const s of subs) s({ count });
      return { count };
    },
    reset: () => {
      count = 0;
      for (const s of subs) s({ count });
      return { count };
    },
    watch: (_, ctx) =>
      Stream.from<CounterTick>((emit, signal) => {
        emit({ count });
        subs.add(emit);
        signal.addEventListener("abort", () => subs.delete(emit));
        void ctx;
      }),
  };
}

describe("end-to-end dispatch", () => {
  test("bootstrap + plain call round-trip", async () => {
    const { client, server } = pair();
    server.serve(schema.serve({ counter: makeCounterServer() }));
    const counter = await client.bootstrap(schema, "counter");

    expect(await counter.getCount()).toEqual({ count: 0 });
    expect(await counter.increment({ delta: 5 })).toEqual({ count: 5 });
    expect(await counter.increment({ delta: -2 })).toEqual({ count: 3 });
    expect(await counter.reset()).toEqual({ count: 0 });
  });

  test("topologyHash mismatch fails bootstrap", async () => {
    const { client, server } = pair();
    const altCap = defineCap({
      different: call<void, void>(),
    });
    const altSchema = defineSchema({ roots: { counter: altCap }, caps: [] });
    server.serve(altSchema.serve({ counter: { different: () => {} } as ImplOf<typeof altCap> }));

    await expect(client.bootstrap(schema, "counter")).rejects.toMatchObject({ code: "failed_precondition" });
  });

  test("streaming method delivers chunks", async () => {
    const { client, server } = pair();
    server.serve(schema.serve({ counter: makeCounterServer() }));
    const counter = await client.bootstrap(schema, "counter");

    const ticks: number[] = [];
    const iter = counter.watch();
    const reader = (async () => {
      for await (const tick of iter) {
        ticks.push(tick.count);
        if (ticks.length >= 3) break;
      }
    })();

    await new Promise((r) => setTimeout(r, 10));
    await counter.increment({ delta: 1 });
    await counter.increment({ delta: 2 });
    await reader;

    expect(ticks).toEqual([0, 1, 3]);
  });

  test("cap-returning method yields disposable proxy", async () => {
    const PlotCap = defineCap({
      render: call<void, { svg: string }>(),
      dispose: call<void, void>(),
    }, { disposal: { method: "dispose", async: true } });

    const plotsRoot = defineCap({
      createPlot: call<{ name: string }, typeof PlotCap>({ returns: cap(PlotCap) }),
    });

    const plotSchema = defineSchema({ roots: { plot: plotsRoot }, caps: [PlotCap] });

    type RootImpl = ImplOf<typeof plotsRoot>;

    const disposed: string[] = [];
    const rootImpl: RootImpl = {
      createPlot: async ({ name }, ctx) => {
        return ctx.exportCap(PlotCap, {
          render: () => ({ svg: `<svg id="${name}"/>` }),
          dispose: () => { disposed.push(name); },
        });
      },
    };

    const { client, server } = pair();
    server.serve(plotSchema.serve({ plot: rootImpl }));
    const plot = await client.bootstrap(plotSchema, "plot");

    {
      await using p = await plot.createPlot({ name: "alpha" });
      expect(await p.render()).toEqual({ svg: '<svg id="alpha"/>' });
    }
    await new Promise((r) => setTimeout(r, 5));
    expect(disposed).toEqual(["alpha"]);
  });

  test("server throwing IpcError propagates code", async () => {
    const errSchema = defineSchema({
      roots: {
        api: defineCap({
          fail: call<void, void>(),
        }),
      },
      caps: [],
    });
    const { client, server } = pair();
    server.serve(errSchema.serve({
      api: {
        fail: () => {
          throw new IpcError({ code: "permission_denied", message: "nope" });
        },
      },
    }));
    const api = await client.bootstrap(errSchema, "api");
    await expect(api.fail()).rejects.toMatchObject({ code: "permission_denied", message: "nope" });
  });
});
