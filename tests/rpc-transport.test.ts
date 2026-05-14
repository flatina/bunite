import { describe, test, expect } from "bun:test";
import {
  call, defineCap, defineSchema,
  createConnection, createFrameTransport, createInMemoryPipePair,
  type ImplOf,
} from "../package/src/shared/rpc/index";

describe("frame transport over bytes pipe", () => {
  test("bootstrap + plain call survive msgpackr round-trip", async () => {
    const apiCap = defineCap({
      ping: call<void, { pong: number }>(),
      echo: call<{ msg: string }, { msg: string }>(),
    });
    const schema = defineSchema({ roots: { api: apiCap }, caps: [] });

    const apiImpl: ImplOf<typeof apiCap> = {
      ping: () => ({ pong: 42 }),
      echo: ({ msg }) => ({ msg: msg + "!" }),
    };

    const [pa, pb] = createInMemoryPipePair();
    const server = createConnection({
      transport: createFrameTransport(pa),
      mode: "native",
      origin: "test://server",
    });
    server.serve(schema.serve({ api: apiImpl }));

    const client = createConnection({
      transport: createFrameTransport(pb),
      mode: "native",
      origin: "test://client",
    });
    const api = await client.bootstrap(schema, "api");

    expect(await api.ping()).toEqual({ pong: 42 });
    expect(await api.echo({ msg: "hi" })).toEqual({ msg: "hi!" });
  });

  test("typed arrays survive transport round-trip", async () => {
    const apiCap = defineCap({
      doubleIt: call<{ data: Float32Array }, { result: Float32Array }>(),
    });
    const schema = defineSchema({ roots: { api: apiCap }, caps: [] });

    const [pa, pb] = createInMemoryPipePair();
    const server = createConnection({ transport: createFrameTransport(pa), mode: "native", origin: "s" });
    server.serve(schema.serve({
      api: {
        doubleIt: ({ data }) => ({ result: new Float32Array(data.map((x) => x * 2)) }),
      },
    }));
    const client = createConnection({ transport: createFrameTransport(pb), mode: "native", origin: "c" });
    const api = await client.bootstrap(schema, "api");

    const out = await api.doubleIt({ data: new Float32Array([1.5, 2.5, 3]) });
    expect(out.result).toBeInstanceOf(Float32Array);
    expect(Array.from(out.result)).toEqual([3, 5, 6]);
  });

  test("invalid bytes are dropped silently", async () => {
    const [pa, _pb] = createInMemoryPipePair();
    const t = createFrameTransport(pa);
    let received = 0;
    t.setReceive(() => { received++; });
    pa.send(new Uint8Array([0xff, 0xff, 0xff]));
    await new Promise((r) => queueMicrotask(r));
    expect(received).toBe(0);
  });
});
