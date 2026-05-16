import {
  createConnection,
  createFrameTransport,
  createWebSocketPipe,
  createEncryptedPipe,
  type Connection,
  type CapDef,
  type Schema,
  type SchemaRoots,
  type ClientOf,
  type WebSocketLike,
} from "../rpc/index";

declare const __buniteWebviewId: number;
declare const __buniteRpcSocketPort: number;
declare const __buniteSecretKeyBase64: string;

let _conn: Connection | null = null;
let _connPromise: Promise<Connection> | null = null;

function ensureConnection(): Promise<Connection> {
  if (_conn) return Promise.resolve(_conn);
  if (_connPromise) return _connPromise;
  const attempt = (async () => {
    const ws = new WebSocket(
      `ws://localhost:${__buniteRpcSocketPort}/rpc?webviewId=${__buniteWebviewId}`
    );
    ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("bunite preload ws connect failed")), { once: true });
    });
    const rawKey = Uint8Array.from(atob(__buniteSecretKeyBase64), (c) => c.charCodeAt(0));
    const pipe = await createEncryptedPipe(createWebSocketPipe(ws as unknown as WebSocketLike), rawKey);
    const conn = createConnection({
      transport: createFrameTransport(pipe),
      mode: "native",
      origin: location.origin,
    });
    _conn = conn;
    return conn;
  })();
  _connPromise = attempt;
  attempt.catch(() => {
    if (_connPromise === attempt) _connPromise = null;
  });
  return attempt;
}

const w = window as any;
w.__bunite ??= {};
w.__buniteWebviewId = __buniteWebviewId;
w.__buniteRpcSocketPort = __buniteRpcSocketPort;
w.host ??= {};

w.host.bootstrap = async (target: CapDef<any, any> | Schema<SchemaRoots>): Promise<unknown> => {
  const conn = await ensureConnection();
  return (conn.bootstrap as (t: unknown) => Promise<unknown>)(target);
};

w.host.runtime = async () => (await ensureConnection()).runtime() as ClientOf<typeof import("../rpc/framework").RuntimeCap>;

w.host.releaseRef = async (proxy: unknown): Promise<void> => {
  (await ensureConnection()).releaseRef(proxy);
};

w.host.getConnection = (): Promise<Connection> => ensureConnection();

import "../webview/native";
