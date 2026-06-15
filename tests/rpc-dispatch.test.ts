import { describe, expect, test } from "bun:test";
import {
  type Attestation,
  type Connection,
  call,
  cap,
  createConnection,
  defineCap,
  defineSchema,
  type Frame,
  type ImplOf,
  IpcError,
  stream,
  type Transport,
} from "../package/src/rpc/index";
import { Stream } from "../package/src/rpc/stream";

function loopback(): [Transport, Transport] {
  let a: ((f: Frame) => void) | undefined;
  let b: ((f: Frame) => void) | undefined;
  // Resolve `h` at microtask time (not call time) so pre-setReceive sends are not lost.
  const enqueue = (getH: () => ((f: Frame) => void) | undefined, f: Frame) => {
    queueMicrotask(() => {
      const h = getH();
      if (h) h(f);
    });
  };
  const left: Transport = {
    send: (f) => enqueue(() => b, f),
    setReceive: (h) => {
      a = h;
    },
    close: () => {},
  };
  const right: Transport = {
    send: (f) => enqueue(() => a, f),
    setReceive: (h) => {
      b = h;
    },
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

const counterCap = defineCap("test.counter", {
  getCount: call<void, { count: number }>(),
  increment: call<{ delta?: number }, { count: number }>(),
  reset: call<void, { count: number }>({ idempotent: true }),
  watch: stream<void, CounterTick>(),
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
    server.serve(counterCap, makeCounterServer());
    const counter = await client.bootstrap(counterCap);

    expect(await counter.getCount()).toEqual({ count: 0 });
    expect(await counter.increment({ delta: 5 })).toEqual({ count: 5 });
    expect(await counter.increment({ delta: -2 })).toEqual({ count: 3 });
    expect(await counter.reset()).toEqual({ count: 0 });
  });

  test("bootstrap with schema returns grouped proxies", async () => {
    const otherCap = defineCap("test.other", { ping: call<void, { ok: true }>() });
    const schema = defineSchema({ counter: counterCap, other: otherCap });
    const { client, server } = pair();
    server.serveAll(schema, {
      counter: makeCounterServer(),
      other: { ping: () => ({ ok: true as const }) },
    });
    const grouped = await client.bootstrap(schema);
    expect(await grouped.counter.getCount()).toEqual({ count: 0 });
    expect(await grouped.other.ping()).toEqual({ ok: true });
  });

  test("bootstrap unknown cap → not_found", async () => {
    const otherCap = defineCap("test.unknown", { ping: call<void, void>() });
    const { client } = pair();
    await expect(client.bootstrap(otherCap)).rejects.toMatchObject({ code: "not_found" });
  });

  test("version mismatch fails bootstrap (both sides specify)", async () => {
    const serverCap = defineCap("test.versioned", { ping: call<void, void>() }, { version: "1" });
    const clientCap = defineCap("test.versioned", { ping: call<void, void>() }, { version: "2" });
    const { client, server } = pair();
    server.serve(serverCap, { ping: () => {} });
    await expect(client.bootstrap(clientCap)).rejects.toMatchObject({
      code: "failed_precondition",
      details: { reason: "version_mismatch" },
    });
  });

  test("unversioned bucket: server-only version → OK", async () => {
    const serverCap = defineCap(
      "test.bucket",
      { ping: call<void, { v: string }>() },
      { version: "2" },
    );
    const clientCap = defineCap("test.bucket", { ping: call<void, { v: string }>() });
    const { client, server } = pair();
    server.serve(serverCap, { ping: () => ({ v: "ok" }) });
    const c = await client.bootstrap(clientCap);
    expect(await c.ping()).toEqual({ v: "ok" });
  });

  test("streaming method delivers chunks", async () => {
    const { client, server } = pair();
    server.serve(counterCap, makeCounterServer());
    const counter = await client.bootstrap(counterCap);

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
    const PlotCap = defineCap(
      "test.Plot2",
      {
        render: call<void, { svg: string }>(),
        dispose: call<void, void>(),
      },
      { disposal: { method: "dispose" } },
    );

    const plotsRoot = defineCap("test.plotRoot", {
      createPlot: call<{ name: string }, typeof PlotCap>({ returns: cap(PlotCap) }),
    });

    type RootImpl = ImplOf<typeof plotsRoot>;

    const disposed: string[] = [];
    const rootImpl: RootImpl = {
      createPlot: async ({ name }, ctx) => {
        return ctx.exportCap(PlotCap, {
          render: () => ({ svg: `<svg id="${name}"/>` }),
          dispose: () => {
            disposed.push(name);
          },
        });
      },
    };

    const { client, server } = pair();
    server.serve(plotsRoot, rootImpl);
    const plot = await client.bootstrap(plotsRoot);

    {
      using p = await plot.createPlot({ name: "alpha" });
      expect(await p.render()).toEqual({ svg: '<svg id="alpha"/>' });
    }
    await new Promise((r) => setTimeout(r, 5));
    expect(disposed).toEqual(["alpha"]);
  });

  test("server throwing IpcError propagates code", async () => {
    const errCap = defineCap("test.err", { fail: call<void, void>() });
    const { client, server } = pair();
    server.serve(errCap, {
      fail: () => {
        throw new IpcError({
          code: "failed_precondition",
          message: "nope",
          details: { reason: "unauthorized" },
        });
      },
    });
    const api = await client.bootstrap(errCap);
    await expect(api.fail()).rejects.toMatchObject({
      code: "failed_precondition",
      message: "nope",
    });
  });

  test("framework name prefix is reserved", () => {
    const reserved = defineCap("bunite.evil", { x: call<void, void>() });
    const { server } = pair();
    expect(() => server.serve(reserved, { x: () => {} })).toThrow();
  });

  test("ifExists:replace swaps impl", async () => {
    const c = defineCap("test.replace", { val: call<void, number>() });
    const { client, server } = pair();
    server.serve(c, { val: () => 1 });
    const p1 = await client.bootstrap(c);
    expect(await p1.val()).toBe(1);
    server.serve(c, { val: () => 2 }, { ifExists: "replace" });
    const p2 = await client.bootstrap(c);
    expect(await p2.val()).toBe(2);
  });

  test("ifExists:skip is no-op when present", () => {
    const c = defineCap("test.skip", { val: call<void, void>() });
    const { server } = pair();
    server.serve(c, { val: () => {} });
    expect(() => server.serve(c, { val: () => {} }, { ifExists: "skip" })).not.toThrow();
  });

  test("ifExists:skip returns empty handle — unserve does not revoke someone else's registration", async () => {
    const c = defineCap("test.skipOwnership", { ping: call<void, { ok: true }>() });
    const { client, server } = pair();
    // first owner serves the cap
    server.serve(c, { ping: () => ({ ok: true as const }) });
    // second caller tries to serve but skips (cap already present)
    const skipped = server.serve(c, { ping: () => ({ ok: true as const }) }, { ifExists: "skip" });
    server.unserve(skipped); // must NOT revoke the first owner
    const proxy = await client.bootstrap(c);
    expect(await proxy.ping()).toEqual({ ok: true });
  });

  test("ifExists:throw (default) collides", () => {
    const c = defineCap("test.throwdup", { val: call<void, void>() });
    const { server } = pair();
    server.serve(c, { val: () => {} });
    expect(() => server.serve(c, { val: () => {} })).toThrow();
  });

  test("unserve fails active client streams ('revoked wins' for streams)", async () => {
    const c = defineCap("test.revokeStream", {
      tick: stream<void, { n: number }>(),
    });
    const { client, server } = pair();
    const handle = server.serve(c, {
      tick: () =>
        Stream.from<{ n: number }>((emit, signal) => {
          let i = 0;
          const id = setInterval(() => emit({ n: ++i }), 5);
          signal.addEventListener("abort", () => clearInterval(id));
          return () => clearInterval(id);
        }),
    });
    const proxy = await client.bootstrap(c);
    const iter = proxy.tick();
    const seen: number[] = [];
    let caught: unknown = null;
    const reader = (async () => {
      try {
        for await (const t of iter) {
          seen.push(t.n);
          if (seen.length === 1) server.unserve(handle);
        }
      } catch (e) {
        caught = e;
      }
    })();
    await reader;
    expect((caught as { code?: string; details?: { reason?: string } } | null)?.code).toBe(
      "failed_precondition",
    );
    expect(
      (caught as { code?: string; details?: { reason?: string } } | null)?.details?.reason,
    ).toBe("revoked");
  });

  test("revokedCapIds is bounded — at-cap retains victim, over-cap evicts oldest", async () => {
    const [t1, t2] = loopback();
    const client = createConnection({ transport: t1, mode: "native", origin: "test://lru-c" });
    createConnection({ transport: t2, mode: "native", origin: "test://lru-s" });
    const internalSend = (capId: number) =>
      (
        client as unknown as {
          sendCallTyped: (capId: number, m: string, a: unknown, d: unknown) => Promise<unknown>;
        }
      ).sendCallTyped(capId, "ping", undefined, undefined);
    const send = (capIds: number[]) =>
      (t2.send as (f: Frame) => void)({ op: "cap_revoked", capIds });

    const victim = 999_999;
    // Boundary case: size = REVOKED_CACHE_SIZE (= 4096) → no eviction; victim still revoked.
    send([victim]);
    send(Array.from({ length: 4095 }, (_, i) => 100_000 + i)); // total 4096
    await new Promise((r) => setTimeout(r, 30));
    await expect(internalSend(victim)).rejects.toMatchObject({
      code: "failed_precondition",
      details: { reason: "revoked" },
    });

    // Over-cap: one more entry → size 4097 triggers eviction; victim (oldest) drops out.
    // Now the call reaches the server (no cap-table entry there) → not_found.
    send([200_000]);
    await new Promise((r) => setTimeout(r, 30));
    await expect(internalSend(victim)).rejects.toMatchObject({ code: "not_found" });
  });

  test("ServeHandle is Disposable — `using` auto-unservers at scope exit", async () => {
    const c = defineCap("test.using", { ping: call<void, { ok: true }>() });
    const { client, server } = pair();
    {
      using _h = server.serve(c, { ping: () => ({ ok: true as const }) });
      const proxy = await client.bootstrap(c);
      expect(await proxy.ping()).toEqual({ ok: true });
      void _h;
    }
    // After scope exit, the cap is unserved.
    await expect(client.bootstrap(c)).rejects.toMatchObject({ code: "not_found" });
  });

  test("replace emits revoke event with the bound cap-id", async () => {
    const c = defineCap("test.replaceEvent", { val: call<void, number>() });
    const { client, server } = pair();
    server.serve(c, { val: () => 1 });
    const events: { capIds: number[]; reason: string }[] = [];
    server.on("revoke", (e) => events.push(e));
    const p = await client.bootstrap(c);
    void p;
    server.replace(c, { val: () => 2 });
    expect(events.length).toBe(1);
    expect(events[0].reason).toBe("replace");
    expect(events[0].capIds.length).toBe(1);
  });

  test("unserve emits cap_revoked and fails subsequent calls", async () => {
    const c = defineCap("test.unserve", { ping: call<void, { ok: true }>() });
    const { client, server } = pair();
    const handle = server.serve(c, { ping: () => ({ ok: true as const }) });
    const proxy = await client.bootstrap(c);
    expect(await proxy.ping()).toEqual({ ok: true });
    server.unserve(handle);
    await new Promise((r) => setTimeout(r, 5));
    await expect(proxy.ping()).rejects.toMatchObject({
      code: "failed_precondition",
      details: { reason: "revoked" },
    });
  });

  test.each([
    ["undefined (falsy)", () => undefined],
    ["null (falsy)", () => null],
    ['"yes" (truthy string)', () => "yes"],
    ["1 (truthy number)", () => 1],
    ["new Boolean(false) (truthy object)", () => new Boolean(false)],
    ["Promise<truthy> resolves to non-boolean", () => Promise.resolve(1)],
  ])("policy returning %s is surfaced as internal (not silently denied/allowed)", async (_label, ret) => {
    const c = defineCap(`test.policyNonBool.${_label.replace(/\W/g, "_")}`, {
      ping: call<void, void>(),
    });
    const [t1, t2] = loopback();
    const client = createConnection({ transport: t1, mode: "native", origin: "test://c" });
    const server = createConnection({
      transport: t2,
      mode: "native",
      origin: "test://s",
      policy: ret as unknown as (n: string, a: Attestation) => boolean,
    });
    server.serve(c, { ping: () => {} });
    const errors: { phase: string; error: Error }[] = [];
    const bootstraps: { result: string }[] = [];
    server.on("error", (e) => errors.push(e));
    server.on("bootstrap", (e) => bootstraps.push({ result: e.result }));
    await expect(client.bootstrap(c)).rejects.toMatchObject({ code: "internal" });
    expect(errors.some((e) => e.phase === "policy")).toBe(true);
    expect(bootstraps.some((b) => b.result === "internal")).toBe(true);
  });

  test("policy denies bootstrap", async () => {
    const c = defineCap("test.policy", { ping: call<void, void>() });
    const [t1, t2] = loopback();
    const client = createConnection({ transport: t1, mode: "native", origin: "test://c" });
    const server = createConnection({
      transport: t2,
      mode: "native",
      origin: "test://s",
      policy: (name) => name !== "test.policy",
    });
    server.serve(c, { ping: () => {} });
    await expect(client.bootstrap(c)).rejects.toMatchObject({
      code: "failed_precondition",
      details: { reason: "unauthorized" },
    });
  });

  test("bidirectional — both peers serve and bootstrap (renderer-as-server)", async () => {
    // Bidirectional: host serves a coordinator cap, renderer serves a panel
    // cap, both bootstrap each other.
    const hostCoordCap = defineCap("test.host.coord", {
      requestPanel: call<{ panelId: string }, { ok: true }>(),
    });
    const renderPanelCap = defineCap("test.render.panel", {
      render: call<{ frame: number }, { svg: string }>(),
    });
    const [t1, t2] = loopback();
    const renderer = createConnection({ transport: t1, mode: "native", origin: "test://renderer" });
    const host = createConnection({ transport: t2, mode: "native", origin: "test://host" });

    const requested: string[] = [];
    host.serve(hostCoordCap, {
      requestPanel: ({ panelId }) => {
        requested.push(panelId);
        return { ok: true as const };
      },
    });
    renderer.serve(renderPanelCap, {
      render: ({ frame }) => ({ svg: `<svg frame="${frame}"/>` }),
    });

    // host bootstraps renderer's cap
    const panel = await host.bootstrap(renderPanelCap);
    expect(await panel.render({ frame: 1 })).toEqual({ svg: '<svg frame="1"/>' });

    // renderer bootstraps host's cap
    const coord = await renderer.bootstrap(hostCoordCap);
    expect(await coord.requestPanel({ panelId: "p1" })).toEqual({ ok: true });
    expect(requested).toEqual(["p1"]);
  });

  test("observability hooks fire", async () => {
    const c = defineCap("test.obs", { ping: call<void, { ok: true }>() });
    const { client, server } = pair();
    server.serve(c, { ping: () => ({ ok: true as const }) });
    const calls: string[] = [];
    server.on("bootstrap", (e) => calls.push(`bootstrap:${e.result}`));
    server.on("call", (e) => calls.push(`call:${e.method}:${e.result}`));
    const p = await client.bootstrap(c);
    await p.ping();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toContain("bootstrap:ok");
    expect(calls).toContain("call:ping:ok");
  });
});
