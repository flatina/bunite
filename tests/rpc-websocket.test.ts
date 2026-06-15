import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { createBunWebSocketServerHandler } from "../package/src/host/serveWeb";
import {
  type Connection,
  call,
  createConnection,
  createFrameTransport,
  createWebSocketPipe,
  defineCap,
  type ImplOf,
  stream,
} from "../package/src/rpc/index";
import { Stream } from "../package/src/rpc/stream";

const counterCap = defineCap("test.wscounter", {
  getCount: call<void, { count: number }>(),
  increment: call<{ delta?: number }, { count: number }>(),
  watch: stream<void, { count: number }>(),
});

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
    watch: () =>
      Stream.from<{ count: number }>((emit, signal) => {
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
      conn.serve(counterCap, counterImpl);
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
  test("serveWeb passes upgrade-enriched data to setup callback", async () => {
    interface AuthData {
      origin: string;
      userId: string;
    }
    const authedCap = defineCap("test.authed", { whoami: call<void, string>() });
    const { serveWeb } = await import("../package/src/host/serveWeb");
    const srv = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      ...serveWeb<AuthData>(
        (conn, data) => {
          conn.serve(authedCap, { whoami: () => data.userId });
        },
        {
          onUpgrade: (req) => ({ userId: req.headers.get("x-user-id") ?? "anonymous" }),
        },
      ),
    });
    const port = srv.port ?? 0;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
      headers: { "x-user-id": "alice" },
    } as unknown as undefined);
    ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
    });
    const conn = createConnection({
      transport: createFrameTransport(createWebSocketPipe(ws as never)),
      mode: "native",
      origin: "ws://client",
    });
    const api = await conn.bootstrap(authedCap);
    expect(await api.whoami()).toBe("alice");
    ws.close();
    srv.stop(true);
  });

  test("bootstrap + call round-trip", async () => {
    const { conn, ws } = await connect();
    const counter = await conn.bootstrap(counterCap);
    const before = await counter.getCount();
    const after = await counter.increment({ delta: 3 });
    expect(after.count).toBe(before.count + 3);
    ws.close();
  });

  test("stream delivers chunks then ends on break", async () => {
    const { conn, ws } = await connect();
    const counter = await conn.bootstrap(counterCap);

    const seen: number[] = [];
    let first = true;
    for await (const tick of counter.watch()) {
      seen.push(tick.count);
      if (first) {
        first = false;
        await counter.increment({ delta: 1 });
      }
      if (seen.length >= 2) break;
    }
    expect(seen.length).toBe(2);
    ws.close();
  });
});
