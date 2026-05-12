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

  describe("pre-handler buffering", () => {
    test("packets received before handler registers are drained in order", async () => {
      const { left, right } = createLoopbackPair();
      const demuxL = createRpcTransportDemuxer(left);
      const demuxR = createRpcTransportDemuxer(right);

      // Producer (R) binds first and sends events before consumer (L) is ready.
      const producer = createRpc<SchemaA>();
      demuxR.channel("A").bindTo(producer); // intentionally not awaited

      producer.send("ping", { n: 1 });
      producer.send("ping", { n: 2 });
      producer.send("ping", { n: 3 });
      await tick();

      // Consumer (L) registers later; buffered packets drain on bindTo.
      const received: number[] = [];
      const consumer = createRpc<SchemaA>();
      consumer.addMessageListener("ping", (p: unknown) => { received.push((p as { n: number }).n); });
      await demuxL.channel("A").bindTo(consumer);

      expect(received).toEqual([1, 2, 3]);
    });

    test("bufferSize cap with default drop-oldest policy keeps the most recent N", async () => {
      const { left, right } = createLoopbackPair();
      const demuxL = createRpcTransportDemuxer(left, { bufferSize: 3 });
      const demuxR = createRpcTransportDemuxer(right);

      const producer = createRpc<SchemaA>();
      demuxR.channel("A").bindTo(producer);
      for (let i = 1; i <= 5; i++) producer.send("ping", { n: i });
      await tick();

      const received: number[] = [];
      const consumer = createRpc<SchemaA>();
      consumer.addMessageListener("ping", (p: unknown) => { received.push((p as { n: number }).n); });
      await demuxL.channel("A").bindTo(consumer);

      expect(received).toEqual([3, 4, 5]);
    });

    test("drop-newest policy keeps the first N and discards later packets", async () => {
      const { left, right } = createLoopbackPair();
      const demuxL = createRpcTransportDemuxer(left, { bufferSize: 3, bufferPolicy: "drop-newest" });
      const demuxR = createRpcTransportDemuxer(right);

      const producer = createRpc<SchemaA>();
      demuxR.channel("A").bindTo(producer);
      for (let i = 1; i <= 5; i++) producer.send("ping", { n: i });
      await tick();

      const received: number[] = [];
      const consumer = createRpc<SchemaA>();
      consumer.addMessageListener("ping", (p: unknown) => { received.push((p as { n: number }).n); });
      await demuxL.channel("A").bindTo(consumer);

      expect(received).toEqual([1, 2, 3]);
    });

    test("bufferSize 0 disables buffering — pre-handler packets drop", async () => {
      const { left, right } = createLoopbackPair();
      const demuxL = createRpcTransportDemuxer(left, { bufferSize: 0 });
      const demuxR = createRpcTransportDemuxer(right);

      const producer = createRpc<SchemaA>();
      demuxR.channel("A").bindTo(producer);
      producer.send("ping", { n: 1 });
      producer.send("ping", { n: 2 });
      await tick();

      const received: number[] = [];
      const consumer = createRpc<SchemaA>();
      consumer.addMessageListener("ping", (p: unknown) => { received.push((p as { n: number }).n); });
      await demuxL.channel("A").bindTo(consumer);

      // Send one post-bind to confirm channel is live.
      producer.send("ping", { n: 3 });
      await tick();
      expect(received).toEqual([3]);
    });

    test("packets after handler registers bypass buffer", async () => {
      const { left, right } = createLoopbackPair();
      const demuxL = createRpcTransportDemuxer(left, { bufferSize: 2 });
      const demuxR = createRpcTransportDemuxer(right);

      const received: number[] = [];
      const consumer = createRpc<SchemaA>();
      consumer.addMessageListener("ping", (p: unknown) => { received.push((p as { n: number }).n); });
      const producer = createRpc<SchemaA>();
      await Promise.all([
        demuxL.channel("A").bindTo(consumer),
        demuxR.channel("A").bindTo(producer)
      ]);

      for (let i = 1; i <= 5; i++) producer.send("ping", { n: i });
      await tick();
      expect(received).toEqual([1, 2, 3, 4, 5]);
    });

    test("unregister then re-register drains the second window correctly", async () => {
      const { left, right } = createLoopbackPair();
      const demuxL = createRpcTransportDemuxer(left);
      const demuxR = createRpcTransportDemuxer(right);

      const producer = createRpc<SchemaA>();
      demuxR.channel("A").bindTo(producer);

      const received: number[] = [];
      const consumer1 = createRpc<SchemaA>();
      consumer1.addMessageListener("ping", (p: unknown) => { received.push((p as { n: number }).n); });
      await demuxL.channel("A").bindTo(consumer1);
      consumer1.dispose(); // releases the transport's handler via unregisterHandler

      producer.send("ping", { n: 7 });
      producer.send("ping", { n: 8 });
      await tick();

      const consumer2 = createRpc<SchemaA>();
      consumer2.addMessageListener("ping", (p: unknown) => { received.push((p as { n: number }).n); });
      await demuxL.channel("A").bindTo(consumer2);
      expect(received).toEqual([7, 8]);
    });

    test("negative bufferSize is clamped to 0 (no buffering)", async () => {
      const { left, right } = createLoopbackPair();
      const demuxL = createRpcTransportDemuxer(left, { bufferSize: -10 });
      const demuxR = createRpcTransportDemuxer(right);

      const producer = createRpc<SchemaA>();
      demuxR.channel("A").bindTo(producer);
      producer.send("ping", { n: 1 });
      await tick();

      const received: number[] = [];
      const consumer = createRpc<SchemaA>();
      consumer.addMessageListener("ping", (p: unknown) => { received.push((p as { n: number }).n); });
      await demuxL.channel("A").bindTo(consumer);

      expect(received).toEqual([]); // pre-handler packet dropped, no buffer
    });

    test("dispose drops buffered packets without delivering", async () => {
      const { left, right } = createLoopbackPair();
      const demuxL = createRpcTransportDemuxer(left);
      const demuxR = createRpcTransportDemuxer(right);

      const producer = createRpc<SchemaA>();
      demuxR.channel("A").bindTo(producer);
      producer.send("ping", { n: 1 });
      producer.send("ping", { n: 2 });
      await tick();

      demuxL.dispose();

      const received: number[] = [];
      const consumer = createRpc<SchemaA>();
      consumer.addMessageListener("ping", (p: unknown) => { received.push((p as { n: number }).n); });
      expect(() => demuxL.channel("A").bindTo(consumer)).toThrow(/disposed/);
      expect(received).toEqual([]);
    });
  });
});
