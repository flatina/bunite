import { describe, test, expect } from "bun:test";
import { createRPC, type RPCPacket, type RPCTransport, type RPCSchema } from "../package/src/shared/rpc";
import { createTransportDemuxer } from "../package/src/shared/rpcDemux";

// Loopback pair: each side has an RPCTransport whose `send` pushes into the peer's handler.
function createLoopbackPair(): { left: RPCTransport; right: RPCTransport } {
  let leftHandler: ((p: RPCPacket) => void) | undefined;
  let rightHandler: ((p: RPCPacket) => void) | undefined;

  return {
    left: {
      send: (packet) => Promise.resolve().then(() => rightHandler?.(packet)),
      registerHandler: (h) => { leftHandler = h; },
      unregisterHandler: () => { leftHandler = undefined; }
    },
    right: {
      send: (packet) => Promise.resolve().then(() => leftHandler?.(packet)),
      registerHandler: (h) => { rightHandler = h; },
      unregisterHandler: () => { rightHandler = undefined; }
    }
  };
}

type SchemaA = RPCSchema<{
  requests: { echo: { params: { msg: string }; response: { msg: string } } };
  messages: { ping: { n: number } };
}>;

type SchemaB = RPCSchema<{
  requests: { add: { params: { a: number; b: number }; response: number } };
  messages: { tick: void };
}>;

const tick = () => new Promise(r => setTimeout(r, 0));

describe("rpcDemux", () => {
  test("per-channel routing — packets on channel A do not leak to channel B", async () => {
    const { left, right } = createLoopbackPair();
    const demuxL = createTransportDemuxer(left);
    const demuxR = createTransportDemuxer(right);

    const serverA = createRPC<SchemaA>({
      transport: demuxR.channel("A"),
      requestHandler: { echo: ({ msg }) => ({ msg: `A:${msg}` }) }
    });
    const serverB = createRPC<SchemaB>({
      transport: demuxR.channel("B"),
      requestHandler: { add: ({ a, b }) => a + b }
    });

    const clientA = createRPC<SchemaA>({ transport: demuxL.channel("A") });
    const clientB = createRPC<SchemaB>({ transport: demuxL.channel("B") });

    const [a, b] = await Promise.all([
      clientA.request("echo", { msg: "hi" }),
      clientB.request("add", { a: 2, b: 3 })
    ]);

    expect(a).toEqual({ msg: "A:hi" });
    expect(b).toBe(5);

    // suppress unused server vars
    void serverA; void serverB;
  });

  test("independent request id space — same id across channels does not collide", async () => {
    const { left, right } = createLoopbackPair();
    const demuxL = createTransportDemuxer(left);
    const demuxR = createTransportDemuxer(right);

    let delayedResolve: ((v: unknown) => void) | undefined;

    createRPC<SchemaA>({
      transport: demuxR.channel("A"),
      requestHandler: {
        echo: () => new Promise<{ msg: string }>(r => {
          delayedResolve = r as (v: unknown) => void;
        })
      }
    });
    createRPC<SchemaB>({
      transport: demuxR.channel("B"),
      requestHandler: { add: ({ a, b }) => a + b }
    });

    const clientA = createRPC<SchemaA>({ transport: demuxL.channel("A") });
    const clientB = createRPC<SchemaB>({ transport: demuxL.channel("B") });

    // Both RPC instances assign id=1 to their first request. Demuxer must keep them separate.
    const pendingA = clientA.request("echo", { msg: "x" });
    const resultB = await clientB.request("add", { a: 10, b: 20 });

    expect(resultB).toBe(30);

    delayedResolve?.({ msg: "done" });
    expect(await pendingA).toEqual({ msg: "done" });
  });

  test("partial dispose — one channel teardown does not affect the other", async () => {
    const { left, right } = createLoopbackPair();
    const demuxL = createTransportDemuxer(left);
    const demuxR = createTransportDemuxer(right);

    // Force an in-flight window so dispose races response delivery, not scheduling.
    createRPC<SchemaA>({
      transport: demuxR.channel("A"),
      requestHandler: { echo: async ({ msg }) => { await tick(); return { msg }; } }
    });
    createRPC<SchemaB>({
      transport: demuxR.channel("B"),
      requestHandler: { add: ({ a, b }) => a + b }
    });

    const clientA = createRPC<SchemaA>({ transport: demuxL.channel("A") });
    const clientB = createRPC<SchemaB>({ transport: demuxL.channel("B") });

    const inflight = clientA.request("echo", { msg: "x" });
    clientA.dispose();
    await expect(inflight).rejects.toThrow(/disposed/);

    expect(await clientB.request("add", { a: 1, b: 2 })).toBe(3);
  });

  test("duplicate channel registration throws instead of silently overwriting", () => {
    const { left } = createLoopbackPair();
    const demux = createTransportDemuxer(left);

    createRPC<SchemaA>({ transport: demux.channel("A") });
    expect(() => createRPC<SchemaB>({ transport: demux.channel("A") })).toThrow(/already has a handler/);
  });

  test("same channel supports concurrent pending requests with independent ids", async () => {
    const { left, right } = createLoopbackPair();
    const demuxL = createTransportDemuxer(left);
    const demuxR = createTransportDemuxer(right);

    let resolve1: ((v: { msg: string }) => void) | undefined;
    let resolve2: ((v: { msg: string }) => void) | undefined;
    const calls: Array<{ msg: string; r: (v: { msg: string }) => void }> = [];

    createRPC<SchemaA>({
      transport: demuxR.channel("A"),
      requestHandler: {
        echo: ({ msg }) => new Promise<{ msg: string }>((r) => {
          calls.push({ msg, r });
        })
      }
    });

    const client = createRPC<SchemaA>({ transport: demuxL.channel("A") });
    const p1 = client.request("echo", { msg: "first" });
    const p2 = client.request("echo", { msg: "second" });

    await tick();
    [resolve1, resolve2] = calls.map(c => c.r);
    // Resolve out of order — different request ids must route correctly.
    resolve2!({ msg: "SECOND" });
    resolve1!({ msg: "FIRST" });

    expect(await p1).toEqual({ msg: "FIRST" });
    expect(await p2).toEqual({ msg: "SECOND" });
  });

  test("base transport without send or registerHandler is rejected at construction", () => {
    expect(() => createTransportDemuxer({})).toThrow(/registerHandler/);
    expect(() => createTransportDemuxer({ send: () => {} })).toThrow(/registerHandler/);
    expect(() => createTransportDemuxer({ registerHandler: () => {} })).toThrow(/send/);
  });

  test("unknown channel — packet dropped silently, no throw", async () => {
    const { left, right } = createLoopbackPair();
    const demuxL = createTransportDemuxer(left);
    const demuxR = createTransportDemuxer(right);

    createRPC<SchemaA>({
      transport: demuxR.channel("A"),
      requestHandler: { echo: ({ msg }) => ({ msg }) }
    });

    // Send to channel "B" which has no registered handler on the server side.
    const ghost = demuxL.channel("B");
    expect(() => ghost.send?.({ type: "message", id: "tick", payload: undefined })).not.toThrow();

    await tick();
    // No assertion needed — absence of crash is the contract.
  });

  test("demuxer dispose — unregisters base handler and clears channels", async () => {
    const { left, right } = createLoopbackPair();
    const demuxL = createTransportDemuxer(left);
    const demuxR = createTransportDemuxer(right);

    const receivedOnA: unknown[] = [];
    createRPC<SchemaA>({
      transport: demuxR.channel("A"),
      requestHandler: { echo: () => ({ msg: "ok" }) }
    }).addMessageListener("ping", (p: unknown) => receivedOnA.push(p));

    const clientA = createRPC<SchemaA>({ transport: demuxL.channel("A") });
    clientA.send("ping", { n: 1 });
    await tick();
    expect(receivedOnA).toHaveLength(1);

    demuxR.dispose();

    clientA.send("ping", { n: 2 });
    await tick();
    expect(receivedOnA).toHaveLength(1); // no new deliveries after dispose
  });
});
