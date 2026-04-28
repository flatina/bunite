import { describe, test, expect } from "bun:test";
import { createRpc, type RpcPacket, type RpcTransport, type RpcSchema } from "../package/src/shared/rpc";
import { createRpcTransportDemuxer } from "../package/src/shared/rpcDemux";

// Loopback pair: each side has an RpcTransport whose `send` pushes into the peer's handler.
function createLoopbackPair(): { left: RpcTransport; right: RpcTransport } {
  let leftHandler: ((p: RpcPacket) => void) | undefined;
  let rightHandler: ((p: RpcPacket) => void) | undefined;

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

type SchemaA = RpcSchema<{
  requests: { echo: { params: { msg: string }; response: { msg: string } } };
  messages: { ping: { n: number } };
}>;

type SchemaB = RpcSchema<{
  requests: { add: { params: { a: number; b: number }; response: number } };
  messages: { tick: void };
}>;

const tick = () => new Promise(r => setTimeout(r, 0));

describe("rpcDemux", () => {
  test("per-channel routing — packets on channel A do not leak to channel B", async () => {
    const { left, right } = createLoopbackPair();
    const demuxL = createRpcTransportDemuxer(left);
    const demuxR = createRpcTransportDemuxer(right);

    const serverA = createRpc<SchemaA>({ requestHandler: { echo: ({ msg }) => ({ msg: `A:${msg}` }) } });
    const serverB = createRpc<SchemaB>({ requestHandler: { add: ({ a, b }) => a + b } });
    demuxR.channel("A").bindTo(serverA);
    demuxR.channel("B").bindTo(serverB);

    const clientA = createRpc<SchemaA>();
    const clientB = createRpc<SchemaB>();
    await Promise.all([
      demuxL.channel("A").bindTo(clientA),
      demuxL.channel("B").bindTo(clientB),
    ]);

    const [a, b] = await Promise.all([
      clientA.request("echo", { msg: "hi" }),
      clientB.request("add", { a: 2, b: 3 })
    ]);

    expect(a).toEqual({ msg: "A:hi" });
    expect(b).toBe(5);
  });

  test("independent request id space — same id across channels does not collide", async () => {
    const { left, right } = createLoopbackPair();
    const demuxL = createRpcTransportDemuxer(left);
    const demuxR = createRpcTransportDemuxer(right);

    let delayedResolve: ((v: unknown) => void) | undefined;

    const serverA = createRpc<SchemaA>({
      requestHandler: {
        echo: () => new Promise<{ msg: string }>(r => {
          delayedResolve = r as (v: unknown) => void;
        })
      }
    });
    const serverB = createRpc<SchemaB>({ requestHandler: { add: ({ a, b }) => a + b } });
    demuxR.channel("A").bindTo(serverA);
    demuxR.channel("B").bindTo(serverB);

    const clientA = createRpc<SchemaA>();
    const clientB = createRpc<SchemaB>();
    await Promise.all([
      demuxL.channel("A").bindTo(clientA),
      demuxL.channel("B").bindTo(clientB),
    ]);

    const pendingA = clientA.request("echo", { msg: "x" });
    const resultB = await clientB.request("add", { a: 10, b: 20 });

    expect(resultB).toBe(30);

    delayedResolve?.({ msg: "done" });
    expect(await pendingA).toEqual({ msg: "done" });
  });

  test("partial dispose — one channel teardown does not affect the other", async () => {
    const { left, right } = createLoopbackPair();
    const demuxL = createRpcTransportDemuxer(left);
    const demuxR = createRpcTransportDemuxer(right);

    const serverA = createRpc<SchemaA>({ requestHandler: { echo: async ({ msg }) => { await tick(); return { msg }; } } });
    const serverB = createRpc<SchemaB>({ requestHandler: { add: ({ a, b }) => a + b } });
    demuxR.channel("A").bindTo(serverA);
    demuxR.channel("B").bindTo(serverB);

    const clientA = createRpc<SchemaA>();
    const clientB = createRpc<SchemaB>();
    await Promise.all([
      demuxL.channel("A").bindTo(clientA),
      demuxL.channel("B").bindTo(clientB),
    ]);

    const inflight = clientA.request("echo", { msg: "x" });
    clientA.dispose();
    await expect(inflight).rejects.toThrow(/disposed/);

    expect(await clientB.request("add", { a: 1, b: 2 })).toBe(3);
  });

  test("duplicate bindTo on same channel throws", () => {
    const { left } = createLoopbackPair();
    const demux = createRpcTransportDemuxer(left);

    const rpc1 = createRpc<SchemaA>();
    const rpc2 = createRpc<SchemaB>();
    demux.channel("A").bindTo(rpc1);
    expect(() => demux.channel("A").bindTo(rpc2)).toThrow(/already has a handler/);
  });

  test("same channel supports concurrent pending requests with independent ids", async () => {
    const { left, right } = createLoopbackPair();
    const demuxL = createRpcTransportDemuxer(left);
    const demuxR = createRpcTransportDemuxer(right);

    const calls: Array<{ msg: string; r: (v: { msg: string }) => void }> = [];

    const server = createRpc<SchemaA>({
      requestHandler: {
        echo: ({ msg }) => new Promise<{ msg: string }>((r) => {
          calls.push({ msg, r });
        })
      }
    });
    demuxR.channel("A").bindTo(server);

    const client = createRpc<SchemaA>();
    await demuxL.channel("A").bindTo(client);

    const p1 = client.request("echo", { msg: "first" });
    const p2 = client.request("echo", { msg: "second" });

    await tick();
    const [resolve1, resolve2] = calls.map(c => c.r);
    resolve2!({ msg: "SECOND" });
    resolve1!({ msg: "FIRST" });

    expect(await p1).toEqual({ msg: "FIRST" });
    expect(await p2).toEqual({ msg: "SECOND" });
  });

  test("base transport without send or registerHandler is rejected at construction", () => {
    expect(() => createRpcTransportDemuxer({})).toThrow(/registerHandler/);
    expect(() => createRpcTransportDemuxer({ send: () => {} })).toThrow(/registerHandler/);
    expect(() => createRpcTransportDemuxer({ registerHandler: () => {} })).toThrow(/send/);
  });

  test("demuxer dispose — unregisters base handler and blocks further sends", async () => {
    const { left, right } = createLoopbackPair();
    const demuxL = createRpcTransportDemuxer(left);
    const demuxR = createRpcTransportDemuxer(right);

    const receivedOnA: unknown[] = [];
    const server = createRpc<SchemaA>({ requestHandler: { echo: () => ({ msg: "ok" }) } });
    server.addMessageListener("ping", (p: unknown) => receivedOnA.push(p));
    demuxR.channel("A").bindTo(server);

    const client = createRpc<SchemaA>();
    await demuxL.channel("A").bindTo(client);

    client.send("ping", { n: 1 });
    await tick();
    expect(receivedOnA).toHaveLength(1);

    demuxL.dispose();
    expect(() => client.send("ping", { n: 2 })).toThrow(/disposed/);
    await tick();
    expect(receivedOnA).toHaveLength(1);
  });

  describe("ready handshake", () => {
    test("bindTo resolves when both sides register", async () => {
      const { left, right } = createLoopbackPair();
      const demuxL = createRpcTransportDemuxer(left);
      const demuxR = createRpcTransportDemuxer(right);

      const rpcL = createRpc<SchemaA>();
      const rpcR = createRpc<SchemaA>({ requestHandler: { echo: ({ msg }) => ({ msg }) } });

      await Promise.all([
        demuxL.channel("A").bindTo(rpcL),
        demuxR.channel("A").bindTo(rpcR),
      ]);
    });

    test("bindTo resolves even when peer registered first (echo wakes late peer)", async () => {
      const { left, right } = createLoopbackPair();
      const demuxL = createRpcTransportDemuxer(left);
      const demuxR = createRpcTransportDemuxer(right);

      // R registers first; its HELLO is dropped by L (no handler yet).
      const rpcR = createRpc<SchemaA>({ requestHandler: { echo: ({ msg }) => ({ msg }) } });
      const readyR = demuxR.channel("A").bindTo(rpcR);

      await tick();

      // L registers later. L's HELLO wakes R which echoes back.
      const rpcL = createRpc<SchemaA>();
      const readyL = demuxL.channel("A").bindTo(rpcL);

      await Promise.all([readyL, readyR]);
    });

    test("first request after awaiting bindTo reaches peer (no drop race)", async () => {
      const { left, right } = createLoopbackPair();
      const demuxL = createRpcTransportDemuxer(left);
      const demuxR = createRpcTransportDemuxer(right);

      const client = createRpc<SchemaA>();
      const ready = demuxL.channel("A").bindTo(client);

      // R registers asynchronously; L's HELLO is dropped initially.
      setTimeout(() => {
        const server = createRpc<SchemaA>({ requestHandler: { echo: ({ msg }) => ({ msg: `R:${msg}` }) } });
        demuxR.channel("A").bindTo(server);
      }, 20);

      await ready;
      expect(await client.request("echo", { msg: "hi" })).toEqual({ msg: "R:hi" });
    });

    test("bindTo rejects on timeout when peer never registers", async () => {
      const { left } = createLoopbackPair();
      const demux = createRpcTransportDemuxer(left, { readyTimeout: 50 });
      const rpc = createRpc<SchemaA>();
      await expect(demux.channel("A").bindTo(rpc)).rejects.toThrow(/timed out/);
    });

    test("bindTo rejects on dispose", async () => {
      const { left } = createLoopbackPair();
      const demux = createRpcTransportDemuxer(left, { readyTimeout: 60_000 });
      const rpc = createRpc<SchemaA>();
      const ready = demux.channel("A").bindTo(rpc);
      demux.dispose();
      await expect(ready).rejects.toThrow(/disposed/);
    });
  });
});
