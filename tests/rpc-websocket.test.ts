import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import {
  call, stream, defineCap, defineSchema,
  createConnection, createFrameTransport, createWebSocketPipe,
  createBunWebSocketServerHandler,
  type ImplOf, type Connection,
} from "../package/src/shared/rpc/index";
import { Stream } from "../package/src/shared/rpc/server";

const counterCap = defineCap({
  getCount: call<void, { count: number }>(),
  increment: call<{ delta?: number }, { count: number }>(),
  watch: stream<void, { count: number }>(),
});
const schema = defineSchema({ roots: { counter: counterCap }, caps: [] });

function makeCounterImpl(): ImplOf<typeof counterCap> {
  let count = 0;
  const subs = new Set<(t: { count: number }) => void>();
  return {
    getCount: () => ({ count }),
    increment: ({ delta = 1 } = {}) => {
      count += delta;
      for (const s of subs) s({ count });
      return { count };
    },
    watch: () => Stream.from<{ count: number }>((emit, signal) => {
      emit({ count });
      subs.add(emit);
      signal.addEventListener("abort", () => subs.delete(emit));
    }),
  };
}

let server: Server<object> | null = null;
let serverPort = 0;
const counterImpl = makeCounterImpl();

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      if (new URL(req.url).pathname !== "/rpc") return new Response("nf", { status: 404 });
      const upgraded = srv.upgrade(req, { data: {} });
      return upgraded ? undefined : new Response("upgrade failed", { status: 500 });
    },
    websocket: createBunWebSocketServerHandler((_ws, pipe) => {
      const conn = createConnection({
        transport: createFrameTransport(pipe),
        mode: "native",
        origin: "ws://server",
      });
      conn.serve(schema.serve({ counter: counterImpl }));
    }),
  });
  serverPort = server.port ?? 0;
});

afterAll(() => {
  server?.stop(true);
  server = null;
});

function connect(): Promise<{ conn: Connection; ws: WebSocket }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/rpc`);
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => {
      const conn = createConnection({
        transport: createFrameTransport(createWebSocketPipe(ws as never)),
        mode: "native",
        origin: "ws://client",
      });
      resolve({ conn, ws });
    });
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
}

describe("rpc over Bun.serve websocket", () => {
  test("bootstrap + call round-trip", async () => {
    const { conn, ws } = await connect();
    const counter = await conn.bootstrap(schema, "counter");
    const before = await counter.getCount();
    const after = await counter.increment({ delta: 3 });
    expect(after.count).toBe(before.count + 3);
    ws.close();
  });

  test("stream delivers chunks then ends on break", async () => {
    const { conn, ws } = await connect();
    const counter = await conn.bootstrap(schema, "counter");

    const seen: number[] = [];
    let first = true;
    for await (const tick of counter.watch()) {
      seen.push(tick.count);
      if (first) { first = false; await counter.increment({ delta: 1 }); }
      if (seen.length >= 2) break;
    }
    expect(seen.length).toBe(2);
    ws.close();
  });
});
