import { ptr } from "bun:ffi";
import { buildViewPreloadScript } from "../preloadBundle";
import { log } from "../log";
import { buniteEventEmitter } from "../events/eventEmitter";
import {
  createConnection,
  createFrameTransport,
  type Connection,
  type BytesPipe,
} from "../../rpc/index";
import type { EvaluateResult, SurfaceCapabilities, ScreenshotResult, Modifier } from "../../rpc/framework";
import { encodeModifiers, resolveKey } from "./inputDispatch";
import { createEncryptedPipe } from "../encryptedPipe";
import {
  ensureNativeRuntime, getNativeLibrary, toCString, waitForViewReady, cancelWaitForViewReady,
  setEvaluateResultHandler, type NativeEvaluateResult,
  setScreenshotResultHandler, type NativeScreenshotResult,
} from "../native";
import { attachBrowserViewRegistry, getRpcPort } from "./Socket";
import { getAppRuntimeOrThrow } from "./App";
import { randomBytes } from "node:crypto";
import { resolveDefaultAppResRoot } from "../paths";
import { removeSurfacesForHostView } from "./SurfaceRegistry";

const BrowserViewMap: Record<number, BrowserView> = {};
let nextWebviewId = 1;

// Evaluate request plumbing — native fires `evaluate-result` events keyed by
// requestId. Each pending entry records its viewId so detachFromNative can
// reject any in-flight Promises for that view (otherwise the resolver leaks
// when the view is destroyed mid-evaluate).
type EvaluatePending = { viewId: number; resolve: (result: EvaluateResult) => void };
let nextEvaluateRequestId = 1;
const evaluateResolvers = new Map<number, EvaluatePending>();

function registerEvaluateRequest(viewId: number, resolve: (result: EvaluateResult) => void): number {
  const id = nextEvaluateRequestId++;
  evaluateResolvers.set(id, { viewId, resolve });
  return id;
}

function rejectEvaluatesForView(viewId: number) {
  for (const [reqId, entry] of evaluateResolvers) {
    if (entry.viewId === viewId) {
      evaluateResolvers.delete(reqId);
      entry.resolve({ ok: false, code: "not_supported", message: "view destroyed" });
    }
  }
}

// Screenshot resolvers — parallel to evaluate. Native fires `screenshot-result`
// keyed by requestId; payload carries base64 data which TS decodes to Uint8Array.
type ScreenshotPending = { viewId: number; resolve: (result: ScreenshotResult) => void };
let nextScreenshotRequestId = 1;
const screenshotResolvers = new Map<number, ScreenshotPending>();

function registerScreenshotRequest(viewId: number, resolve: (result: ScreenshotResult) => void): number {
  const id = nextScreenshotRequestId++;
  screenshotResolvers.set(id, { viewId, resolve });
  return id;
}

function rejectScreenshotsForView(viewId: number) {
  for (const [reqId, entry] of screenshotResolvers) {
    if (entry.viewId === viewId) {
      screenshotResolvers.delete(reqId);
      entry.resolve({ ok: false, code: "not_supported", message: "view destroyed" });
    }
  }
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

setScreenshotResultHandler((viewId, raw: NativeScreenshotResult) => {
  const entry = screenshotResolvers.get(raw.requestId);
  if (!entry) return;
  if (entry.viewId !== viewId) return;
  screenshotResolvers.delete(raw.requestId);
  if (raw.ok && raw.dataBase64 && raw.format && raw.mime) {
    try {
      entry.resolve({ ok: true, data: decodeBase64(raw.dataBase64), mime: raw.mime, format: raw.format });
    } catch (e) {
      entry.resolve({ ok: false, code: "runtime_error", message: `base64 decode failed: ${(e as Error).message}` });
    }
  } else {
    entry.resolve({
      ok: false,
      code: (raw.code as "not_supported" | "runtime_error" | "timeout") ?? "runtime_error",
      message: raw.message ?? "screenshot failed",
    });
  }
});

setEvaluateResultHandler((viewId, raw: NativeEvaluateResult) => {
  const entry = evaluateResolvers.get(raw.requestId);
  if (!entry) return;
  if (entry.viewId !== viewId) return;  // foreign event — ignore
  evaluateResolvers.delete(raw.requestId);
  if (raw.ok && raw.value !== undefined) {
    try {
      entry.resolve({ ok: true, value: JSON.parse(raw.value) });
    } catch (e) {
      entry.resolve({ ok: false, code: "runtime_error", message: `result JSON parse failed: ${(e as Error).message}` });
    }
  } else {
    entry.resolve({
      ok: false,
      code: (raw.code as EvaluateResult extends { code: infer C } ? C : never) ?? "runtime_error",
      message: raw.message ?? "evaluate failed",
    });
  }
});

// Bit positions match the native enum in `ffi_exports.h` (BuniteCapBit).
const CAP_EVALUATE             = 1 << 0;
const CAP_CROSS_ORIGIN_EVAL    = 1 << 1;
const CAP_SURFACE_EVENTS       = 1 << 2;
const CAP_NATIVE_INPUT_TRUSTED = 1 << 3;
const CAP_CLICK                = 1 << 4;
const CAP_TYPE                 = 1 << 5;
const CAP_PRESS                = 1 << 6;
const CAP_SCROLL               = 1 << 7;
const CAP_SCREENSHOT           = 1 << 8;
const CAP_FORMAT_PNG           = 1 << 9;
const CAP_FORMAT_JPEG          = 1 << 10;

function decodeCapabilityBits(bits: number): SurfaceCapabilities {
  const formats: ("png" | "jpeg")[] = [];
  if (bits & CAP_FORMAT_PNG) formats.push("png");
  if (bits & CAP_FORMAT_JPEG) formats.push("jpeg");
  return {
    evaluate: !!(bits & CAP_EVALUATE),
    crossOriginEval: !!(bits & CAP_CROSS_ORIGIN_EVAL),
    surfaceEvents: !!(bits & CAP_SURFACE_EVENTS),
    nativeInputTrusted: !!(bits & CAP_NATIVE_INPUT_TRUSTED),
    click: !!(bits & CAP_CLICK),
    type: !!(bits & CAP_TYPE),
    press: !!(bits & CAP_PRESS),
    scroll: !!(bits & CAP_SCROLL),
    screenshot: !!(bits & CAP_SCREENSHOT),
    ...(formats.length > 0 ? { formats } : {}),
  };
}

export type BrowserViewOptions = {
  url: string | null;
  html: string | null;
  preload: string | null;
  appresRoot: string | null;
  preloadOrigins?: string[];
  partition: string | null;
  frame: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** Setup callback fired when a renderer connection attaches. Use `conn.serve(cap, impl)` or `conn.serveAll(schema, impls)`. */
  serve?: (conn: Connection) => void;
  windowId: number;
  autoResize: boolean;
  navigationRules: string[] | null;
  sandbox: boolean;
};

const defaultOptions: BrowserViewOptions = {
  url: null,
  html: null,
  preload: null,
  appresRoot: null,
  preloadOrigins: undefined,
  partition: null,
  frame: { x: 0, y: 0, width: 800, height: 600 },
  windowId: 0,
  autoResize: true,
  navigationRules: null,
  sandbox: false
};

export class BrowserView {
  id = nextWebviewId++;
  private nativeAttached = false;
  private _readyPromise: Promise<void>;
  windowId: number;
  url: string | null;
  html: string | null;
  preload: string | null;
  appresRoot: string | null;
  preloadOrigins?: string[];
  partition: string | null;
  frame: BrowserViewOptions["frame"];
  readonly serveSetup?: (conn: Connection) => void;
  private connection: Connection | null = null;
  private connectionGeneration = 0;
  autoResize: boolean;
  navigationRules: string[] | null;
  sandbox: boolean;
  secretKey: Uint8Array;

  constructor(options: Partial<BrowserViewOptions>) {
    ensureNativeRuntime();

    this.windowId = options.windowId ?? defaultOptions.windowId;
    this.url = options.url ?? defaultOptions.url;
    this.html = options.html ?? defaultOptions.html;
    this.preload = options.preload ?? defaultOptions.preload;
    this.appresRoot = options.appresRoot ?? defaultOptions.appresRoot ?? resolveDefaultAppResRoot();
    this.preloadOrigins = options.preloadOrigins ?? defaultOptions.preloadOrigins;
    this.partition = options.partition ?? defaultOptions.partition;
    this.frame = options.frame ?? defaultOptions.frame;
    this.serveSetup = options.serve;
    this.autoResize = options.autoResize ?? defaultOptions.autoResize;
    this.navigationRules = options.navigationRules ?? defaultOptions.navigationRules;
    this.sandbox = options.sandbox ?? defaultOptions.sandbox;
    this.secretKey = new Uint8Array(randomBytes(32));

    if (this.sandbox) {
      throw new Error("sandboxed BrowserView is not implemented yet.");
    }
    if (this.partition) {
      log.warn("BrowserView.partition is not implemented yet.");
    }

    const preloadScript = buildViewPreloadScript({
      preload: this.preload,
      appresRoot: this.appresRoot,
      webviewId: this.id,
      rpcSocketPort: getRpcPort(),
      secretKey: this.secretKey
    });

    BrowserViewMap[this.id] = this;
    this._readyPromise = waitForViewReady(this.id);
    this.nativeAttached =
      getNativeLibrary()?.symbols.bunite_view_create(
        this.id,
        this.windowId,
        toCString(this.url ?? ""),
        toCString(this.html ?? ""),
        toCString(preloadScript),
        toCString(this.appresRoot ?? ""),
        toCString(this.navigationRules ? JSON.stringify(this.navigationRules) : ""),
        this.frame.x,
        this.frame.y,
        this.frame.width,
        this.frame.height,
        this.autoResize,
        this.sandbox,
        toCString(this.preloadOrigins ? JSON.stringify(this.preloadOrigins) : "")
      ) ?? false;

    if (this.nativeAttached) {
      this.on("did-navigate", (event: any) => {
        this.url = event.data?.detail ?? this.url;
        removeSurfacesForHostView(this.id);
      });
    } else {
      cancelWaitForViewReady(this.id);
      this._readyPromise = Promise.reject(new Error("Native view creation failed"));
      this._readyPromise.catch(() => {});
    }
  }

  whenReady(timeoutMs = 8000): Promise<void> {
    return Promise.race([
      this._readyPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Browser creation timed out for view ${this.id}`)), timeoutMs)
      )
    ]);
  }

  static getById(id: number) {
    return BrowserViewMap[id];
  }

  static getAll() {
    return Object.values(BrowserViewMap);
  }

  async attachNewConnection(pipe: BytesPipe): Promise<void> {
    this.connectionGeneration += 1;
    const myGen = this.connectionGeneration;
    if (this.connection) {
      try { (this.connection as { transport?: { close?(): void } }).transport?.close?.(); } catch { /* swallow */ }
      this.connection = null;
    }
    const encPipe = await createEncryptedPipe(pipe, this.secretKey);
    if (myGen !== this.connectionGeneration) {
      try { encPipe.close(); } catch { /* swallow */ }
      return;
    }
    const runtime = getAppRuntimeOrThrow().createViewRuntime(this.id);
    this.connection = createConnection({
      transport: createFrameTransport(encPipe),
      mode: "native",
      origin: "appres://app.internal",
      runtime,
      attestation: {
        origin: "appres://app.internal",
        topOrigin: "appres://app.internal",
        partition: this.partition ?? "default",
        isAppRes: true,
        isMainFrame: true,
        userGesture: false,
        level: "app-internal",
      },
    });
    this.serveSetup?.(this.connection);
  }

  detachNewConnection(): void {
    this.connectionGeneration += 1;
    if (this.connection) {
      try { (this.connection as { transport?: { close?(): void } }).transport?.close?.(); } catch { /* swallow */ }
      this.connection = null;
    }
  }

  get rpcConnection(): Connection | null {
    return this.connection;
  }

  get rpcPort() {
    return getRpcPort();
  }

  executeJavaScript(script: string) {
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_view_execute_javascript(this.id, toCString(script));
    }
  }

  evaluate(script: string): Promise<EvaluateResult> {
    if (!this.nativeAttached) {
      return Promise.resolve({ ok: false, code: "not_supported", message: "native runtime unavailable" });
    }
    return new Promise<EvaluateResult>((resolve) => {
      const requestId = registerEvaluateRequest(this.id, resolve);
      getNativeLibrary()?.symbols.bunite_view_evaluate(this.id, requestId, toCString(script));
    });
  }

  capabilities(): SurfaceCapabilities {
    if (!this.nativeAttached) return decodeCapabilityBits(0);
    const bits = getNativeLibrary()?.symbols.bunite_view_capabilities(this.id) ?? 0;
    return decodeCapabilityBits(bits);
  }

  // High-level automation API — same shape as `SurfaceCap` RPC + element
  // `send*` methods. Modifier translation + key resolution happen inside;
  // callers never touch the FFI int contract.
  click(args: {
    x: number; y: number;
    button?: "left" | "middle" | "right";
    clickCount?: number;
    modifiers?: Modifier[];
  }) {
    if (!this.nativeAttached) return;
    const button = args.button === "right" ? 2 : args.button === "middle" ? 1 : 0;
    getNativeLibrary()?.symbols.bunite_view_click(
      this.id, args.x, args.y, button, args.clickCount ?? 1, encodeModifiers(args.modifiers)
    );
  }

  type(text: string) {
    if (!this.nativeAttached) return;
    getNativeLibrary()?.symbols.bunite_view_type(this.id, toCString(text));
  }

  press(key: string, modifiers?: Modifier[], action?: "down" | "up" | "both") {
    if (!this.nativeAttached) return;
    const r = resolveKey(key);
    const a = action === "down" ? 0 : action === "up" ? 1 : 2;
    getNativeLibrary()?.symbols.bunite_view_press(
      this.id, r.windowsVkCode, r.macKeyCode,
      toCString(r.key), toCString(r.code), toCString(r.character),
      encodeModifiers(modifiers), a, r.extended, r.location
    );
  }

  scroll(args: {
    dx: number; dy: number; x?: number; y?: number;
    modifiers?: Modifier[];
  }) {
    if (!this.nativeAttached) return;
    getNativeLibrary()?.symbols.bunite_view_scroll(
      this.id, args.dx, args.dy, args.x ?? 0, args.y ?? 0, encodeModifiers(args.modifiers)
    );
  }

  screenshot(format: "png" | "jpeg", quality: number): Promise<ScreenshotResult> {
    if (!this.nativeAttached) {
      return Promise.resolve({ ok: false, code: "not_supported", message: "native runtime unavailable" });
    }
    return new Promise<ScreenshotResult>((resolve) => {
      const requestId = registerScreenshotRequest(this.id, resolve);
      // Timeout — guards against silent hangs (e.g. CEF compositor never delivers).
      const timer = setTimeout(() => {
        if (screenshotResolvers.delete(requestId)) {
          resolve({ ok: false, code: "timeout", message: "screenshot timed out after 30s" });
        }
      }, 30_000);
      const wrappedResolve = (r: ScreenshotResult) => { clearTimeout(timer); resolve(r); };
      // Replace the registered resolver so the timeout-clearing wrapper runs on success.
      screenshotResolvers.set(requestId, { viewId: this.id, resolve: wrappedResolve });
      getNativeLibrary()?.symbols.bunite_view_screenshot(this.id, requestId, toCString(format), quality);
    });
  }

  goBack() {
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_view_go_back(this.id);
    }
  }

  reload() {
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_view_reload(this.id);
    }
  }

  setVisible(visible: boolean) {
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_view_set_visible(this.id, visible);
    }
  }

  setInputPassthrough(passthrough: boolean) {
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_view_set_input_passthrough(this.id, passthrough);
    }
  }

  setMaskRegion(rects: Array<{ x: number; y: number; w: number; h: number }>) {
    if (!this.nativeAttached) return;
    if (rects.length === 0) {
      getNativeLibrary()?.symbols.bunite_view_set_mask_region(this.id, null as any, 0);
      return;
    }
    const buf = new Float64Array(rects.length * 4);
    for (let i = 0; i < rects.length; i++) {
      buf[i * 4] = rects[i].x;
      buf[i * 4 + 1] = rects[i].y;
      buf[i * 4 + 2] = rects[i].w;
      buf[i * 4 + 3] = rects[i].h;
    }
    getNativeLibrary()?.symbols.bunite_view_set_mask_region(
      this.id, ptr(buf.buffer), rects.length
    );
  }

  bringToFront() {
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_view_bring_to_front(this.id);
    }
  }

  setBounds(x: number, y: number, width: number, height: number) {
    this.frame = { x, y, width, height };
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_view_set_bounds(this.id, x, y, width, height);
    }
  }

  setBoundsAsync(x: number, y: number, width: number, height: number) {
    this.frame = { x, y, width, height };
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_view_set_bounds_async(this.id, x, y, width, height);
    }
  }

  loadURL(url: string) {
    this.url = url;
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_view_load_url(this.id, toCString(url));
    }
  }

  loadHTML(html: string) {
    this.html = html;
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_view_load_html(this.id, toCString(html));
    }
  }

  remove() {
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_view_remove(this.id);
    }
    this.detachFromNative();
  }

  openDevTools() {
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_view_open_devtools(this.id);
    }
  }

  closeDevTools() {
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_view_close_devtools(this.id);
    }
  }

  toggleDevTools() {
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_view_toggle_devtools(this.id);
    }
  }

  detachFromNative() {
    removeSurfacesForHostView(this.id);
    cancelWaitForViewReady(this.id);
    rejectEvaluatesForView(this.id);
    rejectScreenshotsForView(this.id);
    this.nativeAttached = false;
    for (const eventName of [
      "will-navigate", "did-navigate", "dom-ready", "new-window-open", "permission-requested", "title-changed"
    ]) {
      buniteEventEmitter.removeAllListeners(`${eventName}-${this.id}`);
    }
    delete BrowserViewMap[this.id];
  }

  on(
    name: "will-navigate" | "did-navigate" | "dom-ready" | "new-window-open" | "permission-requested" | "title-changed" | "load-start" | "load-finish" | "load-fail",
    handler: (event: unknown) => void
  ) {
    const specificName = `${name}-${this.id}`;
    buniteEventEmitter.on(specificName, handler);
    return () => buniteEventEmitter.off(specificName, handler);
  }
}

attachBrowserViewRegistry({
  getById(id) { return BrowserView.getById(id); }
});
