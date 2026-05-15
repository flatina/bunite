import {
  createConnection,
  createFrameTransport,
  createWebSocketPipe,
  type Connection,
  type Schema,
  type SchemaShape,
  type ClientOf,
  type ServerDescriptor,
  type WebSocketLike,
} from "./index";

declare global {
  interface Window {
    host?: {
      bootstrap<S extends SchemaShape, K extends keyof S["roots"] & string>(
        schema: Schema<S>,
        name: K
      ): Promise<ClientOf<S["roots"][K]>>;
      serve<S extends SchemaShape>(descriptor: ServerDescriptor<S>): Promise<void>;
      runtime(): Promise<ClientOf<typeof import("./framework").RuntimeCap>>;
      releaseRef(proxy: unknown): Promise<void>;
    };
  }
}

export * from "./index";
export { Stream } from "./stream";

let _webConn: Connection | null = null;
let _webConnPromise: Promise<Connection> | null = null;

function isNative(): boolean {
  return typeof (globalThis as { __buniteWebviewId?: number }).__buniteWebviewId === "number";
}

function ensureWebConnection(path = "/rpc"): Promise<Connection> {
  if (_webConn) return Promise.resolve(_webConn);
  if (_webConnPromise) return _webConnPromise;
  const attempt = (async () => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}${path}`);
    ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("web RPC ws connect failed")), { once: true });
    });
    const conn = createConnection({
      transport: createFrameTransport(createWebSocketPipe(ws as unknown as WebSocketLike)),
      mode: "web",
      origin: location.origin,
    });
    _webConn = conn;
    return conn;
  })();
  _webConnPromise = attempt;
  attempt.catch(() => {
    if (_webConnPromise === attempt) _webConnPromise = null;
  });
  return attempt;
}

export async function bootstrap<S extends SchemaShape, K extends keyof S["roots"] & string>(
  schema: Schema<S>,
  name: K
): Promise<ClientOf<S["roots"][K]>> {
  if (isNative()) {
    if (!window.host?.bootstrap) throw new Error("host preload not ready");
    return window.host.bootstrap(schema, name);
  }
  const conn = await ensureWebConnection();
  return conn.bootstrap(schema, name);
}

export async function serve<S extends SchemaShape>(descriptor: ServerDescriptor<S>): Promise<void> {
  if (isNative()) {
    if (!window.host?.serve) throw new Error("host preload not ready");
    return window.host.serve(descriptor);
  }
  const conn = await ensureWebConnection();
  conn.serve(descriptor);
}
