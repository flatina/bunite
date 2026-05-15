import {
  createConnection,
  createFrameTransport,
  createWebSocketPipe,
  createEncryptedPipe,
  importAesGcmKey,
  type Connection,
  type Schema,
  type SchemaShape,
  type ClientOf,
  type ServerDescriptor,
  type WebSocketLike,
} from "../shared/rpc/index";

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
    const key = await importAesGcmKey(rawKey);
    const pipe = createEncryptedPipe(createWebSocketPipe(ws as unknown as WebSocketLike), key);
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

w.host.bootstrap = async <S extends SchemaShape, K extends keyof S["roots"] & string>(
  schema: Schema<S>,
  name: K
): Promise<ClientOf<S["roots"][K]>> => (await ensureConnection()).bootstrap(schema, name);

w.host.serve = async <S extends SchemaShape>(descriptor: ServerDescriptor<S>): Promise<void> => {
  (await ensureConnection()).serve(descriptor);
};

w.host.runtime = async () => (await ensureConnection()).runtime();

w.host.releaseRef = async (proxy: unknown): Promise<void> => {
  (await ensureConnection()).releaseRef(proxy);
};

import "./webviewElement";
