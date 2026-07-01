import {
  type AnyCapDef,
  type ClientOf,
  type Connection,
  createConnection,
  createFrameTransport,
  createWebSocketPipe,
  type Schema,
  type SchemaRoots,
  type WebSocketLike,
} from "./index";

/** Host-provided web globals — set by the page that owns the main Connection so
 * extension bundles (each carrying its own bunite-core copy) share one ws conn
 * instead of opening their own. Desktop has the same property via the CEF
 * preload-injected `window.host.*`; this is the web equivalent. */
export interface BuniteWebGlobal {
  /** Shared Connection. ensureWebConnection() prefers this over opening a new ws. */
  webConnection?: Connection;
}

declare global {
  interface Window {
    host?: {
      bootstrap<C extends AnyCapDef>(cap: C): Promise<ClientOf<C>>;
      bootstrap<R extends SchemaRoots>(
        schema: Schema<R>,
      ): Promise<{ [K in keyof R]: ClientOf<R[K]> }>;
      runtime(): Promise<ClientOf<typeof import("./framework").RuntimeCap>>;
      releaseRef(proxy: unknown): Promise<void>;
      /** Full Connection for renderer-as-server (serve / serveAll / unserve / replace / on). */
      getConnection(): Promise<Connection>;
    };
    __bunite?: BuniteWebGlobal;
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
  // Drop a closed cached conn so a disconnect (WS close/error → onClose) leads to
  // a fresh reconnect on the next call, instead of handing back a dead connection.
  if (_webConn) {
    if (!_webConn.closed) return Promise.resolve(_webConn);
    _webConn = null;
    _webConnPromise = null;
  }
  // Host-provided shared Connection — cross-bundle reachability for renderer
  // ecosystems (e.g. extension hosts) that bundle bunite-core 0-externals per
  // plugin. Page-author trust applies; bunite policy/attestation still gates.
  if (typeof window !== "undefined") {
    const shared = window.__bunite?.webConnection;
    if (shared && !shared.closed) {
      _webConn = shared;
      return Promise.resolve(shared);
    }
  }
  if (_webConnPromise) return _webConnPromise;
  const attempt = (async () => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}${path}`);
    ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.removeEventListener("error", onError);
        resolve();
      };
      const onError = () => {
        ws.removeEventListener("open", onOpen);
        reject(new Error("web RPC ws connect failed"));
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
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

export function bootstrap<C extends AnyCapDef>(cap: C): Promise<ClientOf<C>>;
export function bootstrap<R extends SchemaRoots>(
  schema: Schema<R>,
): Promise<{ [K in keyof R]: ClientOf<R[K]> }>;
export async function bootstrap(target: AnyCapDef | Schema<any>): Promise<unknown> {
  if (isNative()) {
    if (!window.host?.bootstrap) throw new Error("host preload not ready");
    return (window.host.bootstrap as (t: unknown) => Promise<unknown>)(target);
  }
  const conn = await ensureWebConnection();
  return (conn.bootstrap as (t: unknown) => Promise<unknown>)(target);
}

/** Returns the underlying Connection — for renderer-as-server (`conn.serve(cap, impl)`), observability hooks (`conn.on(...)`), etc. */
export async function getConnection(): Promise<Connection> {
  if (isNative()) {
    if (!window.host?.getConnection) throw new Error("host preload not ready");
    return window.host.getConnection();
  }
  return ensureWebConnection();
}
