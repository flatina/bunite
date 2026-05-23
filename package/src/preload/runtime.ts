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

// --- console capture ----------------------------------------------------
// page → host event sink via PageReportingCap. 16ms coalesce batch. Errors
// during RPC are swallowed — proxy NEVER throws inside `console.log` (would
// corrupt page semantics).
//
// page-side ring buffer is keyed by Symbol.for so user-page code can't trivially
// collide / shadow. `evaluate("window[Symbol.for('bunite.console.buffer')]")`
// remains accessible as a retrospective fallback.

type ConsoleLevel = "log" | "warn" | "error" | "info" | "debug";
type ConsoleEntry = { level: ConsoleLevel; args: string[]; ts: number };

const CONSOLE_BUFFER_KEY = Symbol.for("bunite.console.buffer");
const PAGE_RING_LIMIT = 200;
const BATCH_INTERVAL_MS = 16;
const BATCH_SIZE_THRESHOLD = 50;

(w as any)[CONSOLE_BUFFER_KEY] = [] as ConsoleEntry[];
const pageBuffer = (w as any)[CONSOLE_BUFFER_KEY] as ConsoleEntry[];

function serializeArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack ?? a.message;
  try { return JSON.stringify(a); } catch { return String(a); }
}

let reportingCap: Promise<{ reportConsoleBatch(args: { entries: ConsoleEntry[] }): Promise<void> | void }> | null = null;
// Circuit breaker: after a failed cap fetch, hold off for a cooldown so a
// permanently-disconnected host doesn't burn a retry per batch (16ms cadence).
let nextRetryMs = 0;
const RETRY_COOLDOWN_MS = 1000;
function getReporting() {
  if (reportingCap) return reportingCap;
  if (Date.now() < nextRetryMs) return Promise.reject(new Error("reporting cap cooldown"));
  reportingCap = (async () => {
    const r = await (w.host as { runtime(): Promise<any> }).runtime();
    return r.reporting();
  })();
  reportingCap.catch(() => {
    reportingCap = null;
    nextRetryMs = Date.now() + RETRY_COOLDOWN_MS;
  });
  return reportingCap;
}

let batch: ConsoleEntry[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;

function flushBatch() {
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
  if (batch.length === 0) return;
  const entries = batch;
  batch = [];
  getReporting()
    .then((rep) => rep.reportConsoleBatch({ entries }))
    .catch(() => {
      // resource_exhausted (RPC over capacity), disconnect, or other RPC error.
      // The page-side ring buffer still has these entries; consumers can fetch
      // via `evaluate(...)` if the host stream missed them.
    });
}

function scheduleFlush() {
  if (batch.length >= BATCH_SIZE_THRESHOLD) {
    flushBatch();
    return;
  }
  if (batchTimer) return;
  batchTimer = setTimeout(flushBatch, BATCH_INTERVAL_MS);
}

function installConsoleProxy() {
  for (const level of ["log", "warn", "error", "info", "debug"] as const) {
    const original = (console as Record<ConsoleLevel, (...a: unknown[]) => void>)[level].bind(console);
    (console as Record<ConsoleLevel, (...a: unknown[]) => void>)[level] = (...args: unknown[]) => {
      // Original console first — preserve page-author dev experience even if
      // the bunite plumbing throws further down (shouldn't, but defensive).
      try { original(...args); } catch { /* extreme: original throws */ }
      try {
        const entry: ConsoleEntry = {
          level,
          args: args.map(serializeArg),
          ts: Date.now(),
        };
        pageBuffer.push(entry);
        if (pageBuffer.length > PAGE_RING_LIMIT) {
          pageBuffer.splice(0, pageBuffer.length - PAGE_RING_LIMIT);
        }
        batch.push(entry);
        scheduleFlush();
      } catch { /* never propagate to page */ }
    };
  }
}

installConsoleProxy();

// --- custom titlebar drag region (Tauri-style data attribute) -----------
// `data-bunite-drag-region` → window move on left mousedown; a nearer
// `data-bunite-no-drag` ancestor opts out. dblclick → toggle maximize.
// Data attribute (not `-webkit-app-region` CSS) because that CSS property is
// not exposed to JS via getComputedStyle.
let _windowCap: Promise<{ beginMoveDrag(): unknown; toggleMaximize(): unknown }> | null = null;
function windowCap() {
  if (!_windowCap) {
    _windowCap = (async () => {
      const rt = await (w.host as { runtime(): Promise<any> }).runtime();
      const wc = await rt.window();
      return await wc.current();
    })();
    _windowCap.catch(() => { _windowCap = null; });
  }
  return _windowCap;
}
function isDragHit(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null;
  while (el) {
    if (el.hasAttribute("data-bunite-no-drag")) return false;
    if (el.hasAttribute("data-bunite-drag-region")) return true;
    el = el.parentElement;
  }
  return false;
}
// Pre-warm the window cap so the first drag's beginMoveDrag is a single cached
// call — lazy resolution (bootstrap + window + current) would otherwise miss
// the drag's first frames while the cursor has already moved.
void windowCap();
document.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || window.self !== window.top || !isDragHit(e.target)) return;
  windowCap().then((c) => c.beginMoveDrag()).catch(() => {});
}, true);
document.addEventListener("dblclick", (e) => {
  if (e.button !== 0 || window.self !== window.top || !isDragHit(e.target)) return;
  windowCap().then((c) => c.toggleMaximize()).catch(() => {});
}, true);

import "../webview/native";
