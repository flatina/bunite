import { ptr } from "bun:ffi";
import { buildViewPreloadScript } from "../preloadBundle";
import { log } from "../log";
import { buniteEventEmitter } from "../events/eventEmitter";
import {
  createConnection,
  createFrameTransport,
  createEncryptedPipe,
  importAesGcmKey,
  type Connection,
  type BytesPipe,
  type SchemaShape,
  type ServerDescriptor,
} from "../../rpc/index";
import { ensureNativeRuntime, getNativeLibrary, toCString, waitForViewReady, cancelWaitForViewReady } from "../native";
import { attachBrowserViewRegistry, getRpcPort } from "./Socket";
import { getAppRuntimeOrThrow } from "./App";
import { randomBytes } from "node:crypto";
import { resolveDefaultAppResRoot } from "../paths";
import { removeSurfacesForHostView } from "./SurfaceRegistry";

const BrowserViewMap: Record<number, BrowserView<any>> = {};
let nextWebviewId = 1;

export type BrowserViewOptions<S extends SchemaShape = SchemaShape> = {
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
  serve?: ServerDescriptor<S>;
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

export class BrowserView<S extends SchemaShape = SchemaShape> {
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
  readonly serveDescriptor?: ServerDescriptor<S>;
  private connection: Connection | null = null;
  private connectionGeneration = 0;
  autoResize: boolean;
  navigationRules: string[] | null;
  sandbox: boolean;
  secretKey: Uint8Array;

  constructor(options: Partial<BrowserViewOptions<S>>) {
    ensureNativeRuntime();

    this.windowId = options.windowId ?? defaultOptions.windowId;
    this.url = options.url ?? defaultOptions.url;
    this.html = options.html ?? defaultOptions.html;
    this.preload = options.preload ?? defaultOptions.preload;
    this.appresRoot = options.appresRoot ?? defaultOptions.appresRoot ?? resolveDefaultAppResRoot();
    this.preloadOrigins = options.preloadOrigins ?? defaultOptions.preloadOrigins;
    this.partition = options.partition ?? defaultOptions.partition;
    this.frame = options.frame ?? defaultOptions.frame;
    this.serveDescriptor = options.serve;
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
    const key = await importAesGcmKey(this.secretKey);
    if (myGen !== this.connectionGeneration) {
      try { pipe.close(); } catch { /* swallow */ }
      return;
    }
    const encPipe = createEncryptedPipe(pipe, key);
    const runtime = getAppRuntimeOrThrow().createViewRuntime(this.id);
    this.connection = createConnection({
      transport: createFrameTransport(encPipe),
      mode: "native",
      origin: "appres://app.internal",
      runtime,
    });
    if (this.serveDescriptor) {
      this.connection.serve(this.serveDescriptor);
    }
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

  setAnchor(mode: "none" | "fill" | "top" | "below-top", inset = 0) {
    const modeInt = { none: 0, fill: 1, top: 2, "below-top": 3 }[mode];
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_view_set_anchor(this.id, modeInt, inset);
    }
  }

  executeJavaScript(script: string) {
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_view_execute_javascript(this.id, toCString(script));
    }
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
    this.nativeAttached = false;
    for (const eventName of [
      "will-navigate", "did-navigate", "dom-ready", "new-window-open", "permission-requested"
    ]) {
      buniteEventEmitter.removeAllListeners(`${eventName}-${this.id}`);
    }
    delete BrowserViewMap[this.id];
  }

  on(
    name: "will-navigate" | "did-navigate" | "dom-ready" | "new-window-open" | "permission-requested",
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
