import { describe, test, expect } from "bun:test";
import {
  call, defineCap, defineSchema,
  createConnection, createFrameTransport,
  createEncryptedPipe, importAesGcmKey,
  type ImplOf,
  type BytesPipe,
} from "../package/src/rpc/index";

function pipePair(): [BytesPipe, BytesPipe] {
  let aRecv: ((b: Uint8Array) => void) | undefined;
  let bRecv: ((b: Uint8Array) => void) | undefined;
  return [
    { send: (b) => queueMicrotask(() => bRecv?.(b)), setReceive: (h) => { aRecv = h; }, close: () => {} },
    { send: (b) => queueMicrotask(() => aRecv?.(b)), setReceive: (h) => { bRecv = h; }, close: () => {} },
  ];
}

describe("encrypted pipe", () => {
  test("AES-GCM round-trip preserves Frame order through msgpackr sequential codec", async () => {
    const apiCap = defineCap({
      ping: call<{ n: number }, { pong: number }>(),
    });
    const schema = defineSchema({ roots: { api: apiCap }, caps: [] });

    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const key = await importAesGcmKey(rawKey);

    const [a, b] = pipePair();
    const ea = createEncryptedPipe(a, key);
    const eb = createEncryptedPipe(b, key);

    const server = createConnection({
      transport: createFrameTransport(ea),
      mode: "native",
      origin: "test://server",
    });
    server.serve(schema.serve({
      api: {
        ping: ({ n }) => ({ pong: n * 2 }),
      } as ImplOf<typeof apiCap>,
    }));

    const client = createConnection({
      transport: createFrameTransport(eb),
      mode: "native",
      origin: "test://client",
    });
    const api = await client.bootstrap(schema, "api");

    const results = await Promise.all([
      api.ping({ n: 1 }),
      api.ping({ n: 2 }),
      api.ping({ n: 3 }),
      api.ping({ n: 4 }),
      api.ping({ n: 5 }),
    ]);
    expect(results.map((r) => r.pong)).toEqual([2, 4, 6, 8, 10]);
  });

  test("invalid frame version closes the pipe", async () => {
    const key = await importAesGcmKey(crypto.getRandomValues(new Uint8Array(32)));
    let closed = false;
    const base: BytesPipe = {
      send: () => {},
      setReceive: () => {},
      close: () => { closed = true; },
    };
    let recv: ((b: Uint8Array) => void) | undefined;
    base.setReceive = (h) => { recv = h; };
    const enc = createEncryptedPipe(base, key);
    enc.setReceive(() => {});
    recv!(new Uint8Array([99, 0, 0]));
    expect(closed).toBe(true);
  });
});
