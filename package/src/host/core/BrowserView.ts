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
import type {
  EvaluateResult, SurfaceCapabilities, ScreenshotResult, Modifier,
  AccessibilitySnapshotResult, AxNode, ListFramesResult,
} from "../../rpc/framework";
import { encodeModifiers, resolveKey } from "./inputDispatch";
import { createEncryptedPipe } from "../encryptedPipe";
import {
  ensureNativeRuntime, getNativeLibrary, toCString, waitForViewReady, cancelWaitForViewReady,
  setEvaluateResultHandler, type NativeEvaluateResult,
  setScreenshotResultHandler, type NativeScreenshotResult,
  setAccessibilityResultHandler, type NativeAccessibilityResult,
  setListFramesResultHandler, type NativeListFramesResult,
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

type AxPending = { viewId: number; resolve: (result: AccessibilitySnapshotResult) => void; interestingOnly: boolean };
let nextAxRequestId = 1;
const axResolvers = new Map<number, AxPending>();

function registerAxRequest(viewId: number, resolve: (result: AccessibilitySnapshotResult) => void, interestingOnly: boolean): number {
  const id = nextAxRequestId++;
  axResolvers.set(id, { viewId, resolve, interestingOnly });
  return id;
}

function rejectAxForView(viewId: number) {
  for (const [reqId, entry] of axResolvers) {
    if (entry.viewId === viewId) {
      axResolvers.delete(reqId);
      entry.resolve({ ok: false, code: "not_supported", message: "view destroyed" });
    }
  }
}

// CDP `Accessibility.getFullAXTree` returns `{nodes: [flat]}` with `childIds`
// references — build a nested tree from the first node. When `interestingOnly`
// is true, ignored nodes are dropped and their children reparent up.
function convertAxTree(cdpResult: { nodes?: any[] } | undefined, interestingOnly: boolean): AxNode {
  const flat = cdpResult?.nodes ?? [];
  if (flat.length === 0) return { nodeId: "", role: "", name: "" };
  const byId = new Map<string, any>();
  for (const n of flat) if (n?.nodeId != null) byId.set(String(n.nodeId), n);
  // Walk childIds skipping ignored nodes (when filtering) and produce a flat list
  // of "interesting" descendants for the given node.
  const seen = new Set<string>();
  const interestingDescendants = (cdpNode: any): any[] => {
    const out: any[] = [];
    if (!Array.isArray(cdpNode?.childIds)) return out;
    for (const cid of cdpNode.childIds) {
      const child = byId.get(String(cid));
      if (!child) continue;
      if (interestingOnly && child.ignored === true) {
        out.push(...interestingDescendants(child));
      } else {
        out.push(child);
      }
    }
    return out;
  };
  const build = (n: any): AxNode => {
    const id = String(n?.nodeId ?? "");
    if (id && seen.has(id)) return { nodeId: id, role: "", name: "" };  // cycle guard
    if (id) seen.add(id);
    const props = new Map<string, unknown>();
    if (Array.isArray(n?.properties)) {
      for (const p of n.properties) {
        if (p?.name && p.value && "value" in p.value) props.set(p.name, p.value.value);
      }
    }
    const out: AxNode = {
      nodeId: id,
      role: String(n?.role?.value ?? ""),
      name: String(n?.name?.value ?? ""),
    };
    if (n?.value?.value !== undefined) out.value = String(n.value.value);
    if (n?.description?.value !== undefined) out.description = String(n.description.value);
    const level = props.get("level"); if (typeof level === "number") out.level = level;
    const checked = props.get("checked"); if (checked === true || checked === false || checked === "mixed") out.checked = checked;
    const pressed = props.get("pressed"); if (pressed === true || pressed === false || pressed === "mixed") out.pressed = pressed;
    const expanded = props.get("expanded"); if (typeof expanded === "boolean") out.expanded = expanded;
    const disabled = props.get("disabled"); if (typeof disabled === "boolean") out.disabled = disabled;
    const focused = props.get("focused"); if (typeof focused === "boolean") out.focused = focused;
    const invalid = props.get("invalid"); if (typeof invalid === "boolean") out.invalid = invalid;
    const required = props.get("required"); if (typeof required === "boolean") out.required = required;
    const selected = props.get("selected"); if (typeof selected === "boolean") out.selected = selected;
    const kids = interestingDescendants(n).map(build);
    if (kids.length > 0) out.children = kids;
    return out;
  };
  // Root node skips ignored-filter (always include even if ignored).
  return build(flat[0]);
}

type FramesPending = { viewId: number; resolve: (result: ListFramesResult) => void };
let nextFramesRequestId = 1;
const framesResolvers = new Map<number, FramesPending>();
function registerFramesRequest(viewId: number, resolve: (result: ListFramesResult) => void): number {
  const id = nextFramesRequestId++;
  framesResolvers.set(id, { viewId, resolve });
  return id;
}
function rejectFramesForView(viewId: number) {
  for (const [reqId, entry] of framesResolvers) {
    if (entry.viewId === viewId) {
      framesResolvers.delete(reqId);
      entry.resolve({ ok: false, code: "not_supported", message: "view destroyed" });
    }
  }
}

function flattenFrameTree(raw: any): { frameId: string; parentFrameId: string | null; origin: string; url: string; name?: string }[] {
  const out: { frameId: string; parentFrameId: string | null; origin: string; url: string; name?: string }[] = [];
  const walk = (node: any, parent: string | null) => {
    const f = node?.frame;
    if (!f) return;
    const entry: { frameId: string; parentFrameId: string | null; origin: string; url: string; name?: string } = {
      frameId: String(f.id ?? ""),
      parentFrameId: parent,
      origin: String(f.securityOrigin ?? ""),
      url: String(f.url ?? ""),
    };
    if (typeof f.name === "string" && f.name.length > 0) entry.name = f.name;
    out.push(entry);
    if (Array.isArray(node.childFrames)) for (const c of node.childFrames) walk(c, entry.frameId);
  };
  const root = raw?.frameTree;
  if (root) walk(root, null);
  return out;
}

setListFramesResultHandler((viewId, raw: NativeListFramesResult) => {
  const entry = framesResolvers.get(raw.requestId);
  if (!entry || entry.viewId !== viewId) return;
  framesResolvers.delete(raw.requestId);
  if (raw.ok && raw.raw) {
    try {
      const frames = flattenFrameTree(raw.raw);
      entry.resolve({ ok: true, frames });
    } catch (e) {
      entry.resolve({ ok: false, code: "runtime_error", message: `frame tree flatten failed: ${(e as Error).message}` });
    }
  } else {
    entry.resolve({
      ok: false,
      code: (raw.code as "not_supported" | "runtime_error") ?? "runtime_error",
      message: raw.message ?? "list frames failed",
    });
  }
});

setAccessibilityResultHandler((viewId, raw: NativeAccessibilityResult) => {
  const entry = axResolvers.get(raw.requestId);
  if (!entry || entry.viewId !== viewId) return;
  axResolvers.delete(raw.requestId);
  if (raw.ok && raw.tree) {
    try { entry.resolve({ ok: true, tree: convertAxTree(raw.tree as any, entry.interestingOnly) }); }
    catch (e) { entry.resolve({ ok: false, code: "runtime_error", message: `ax tree convert failed: ${(e as Error).message}` }); }
  } else {
    entry.resolve({
      ok: false,
      code: (raw.code as "not_supported" | "runtime_error" | "timeout") ?? "runtime_error",
      message: raw.message ?? "accessibility snapshot failed",
    });
  }
});

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
const CAP_MOUSE                = 1 << 11;
const CAP_DIALOGS              = 1 << 12;
const CAP_CONSOLE              = 1 << 13;
const CAP_AX                   = 1 << 15;
const CAP_BOUNDING_RECT        = 1 << 16;
const CAP_FRAMES               = 1 << 17;
const CAP_DOWNLOADS            = 1 << 18;
const CAP_POPUPS               = 1 << 19;

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
    mouse: !!(bits & CAP_MOUSE),
    dialogs: !!(bits & CAP_DIALOGS),
    console: !!(bits & CAP_CONSOLE),
    screenshot: !!(bits & CAP_SCREENSHOT),
    accessibilitySnapshot: !!(bits & CAP_AX),
    getBoundingRect: !!(bits & CAP_BOUNDING_RECT),
    frames: !!(bits & CAP_FRAMES),
    downloads: !!(bits & CAP_DOWNLOADS),
    popups: !!(bits & CAP_POPUPS),
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

  /** Wrap a pre-existing native view (popup mint). Skips `bunite_view_create`;
   *  the new view is then attached to the host window via `bunite_view_popup_accept`. */
  static adopt(args: {
    nativeViewId: number;
    hostWindowId: number;
    bounds: { x: number; y: number; width: number; height: number };
    appresRoot: string | null;
  }): BrowserView {
    return new BrowserView({
      adoptNativeViewId: args.nativeViewId,
      windowId: args.hostWindowId,
      frame: args.bounds,
      appresRoot: args.appresRoot,
      autoResize: false,
    } as Partial<BrowserViewOptions> & { adoptNativeViewId: number });
  }

  static dismissPopupById(newSurfaceId: number) {
    getNativeLibrary()?.symbols.bunite_view_popup_dismiss(newSurfaceId);
  }

  constructor(options: Partial<BrowserViewOptions> & { adoptNativeViewId?: number }) {
    ensureNativeRuntime();

    const adopting = options.adoptNativeViewId != null;
    if (adopting) {
      this.id = options.adoptNativeViewId!;
      // Adopted IDs live in the upper u32 half (popup namespace). Keep TS's
      // sequential allocator untouched so normal creates stay below 0x80000000.
    }
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
    if (adopting) {
      // Native popup mint already created the view; bind to host window + bounds.
      const lib = getNativeLibrary();
      lib?.symbols.bunite_view_popup_accept(
        this.id, this.windowId,
        this.frame.x, this.frame.y, this.frame.width, this.frame.height,
      );
      this.nativeAttached = true;
    } else {
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
    }

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

  evaluate(script: string, frameId?: string): Promise<EvaluateResult> {
    if (!this.nativeAttached) {
      return Promise.resolve({ ok: false, code: "not_supported", message: "native runtime unavailable" });
    }
    return new Promise<EvaluateResult>((resolve) => {
      const requestId = registerEvaluateRequest(this.id, resolve);
      const lib = getNativeLibrary();
      if (frameId) {
        lib?.symbols.bunite_view_evaluate_in_frame(this.id, requestId, toCString(script), toCString(frameId));
      } else {
        lib?.symbols.bunite_view_evaluate(this.id, requestId, toCString(script));
      }
    });
  }

  setDownloadPolicy(policy: "auto" | "ask" | "block", downloadDir?: string) {
    if (!this.nativeAttached) return;
    const policyCode = policy === "auto" ? 0 : policy === "ask" ? 1 : 2;
    getNativeLibrary()?.symbols.bunite_view_set_download_policy(
      this.id, policyCode, toCString(downloadDir ?? "")
    );
  }

  listFrames(): Promise<ListFramesResult> {
    if (!this.nativeAttached) {
      return Promise.resolve({ ok: false, code: "not_supported", message: "native runtime unavailable" });
    }
    return new Promise<ListFramesResult>((resolve) => {
      const requestId = registerFramesRequest(this.id, resolve);
      const timer = setTimeout(() => {
        if (framesResolvers.delete(requestId)) {
          resolve({ ok: false, code: "runtime_error", message: "list frames timed out after 10s" });
        }
      }, 10_000);
      const wrappedResolve = (r: ListFramesResult) => { clearTimeout(timer); resolve(r); };
      framesResolvers.set(requestId, { viewId: this.id, resolve: wrappedResolve });
      getNativeLibrary()?.symbols.bunite_view_list_frames(this.id, requestId);
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

  mouse(args: {
    action: "move" | "down" | "up";
    x: number; y: number;
    button?: "left" | "middle" | "right";
    modifiers?: Modifier[];
  }) {
    if (!this.nativeAttached) return;
    const action = args.action === "move" ? 0 : args.action === "down" ? 1 : 2;
    const button = args.button === "right" ? 2 : args.button === "middle" ? 1 : 0;
    getNativeLibrary()?.symbols.bunite_view_mouse(
      this.id, action, args.x, args.y, button, encodeModifiers(args.modifiers)
    );
  }

  respondToDialog(requestId: number, accept: boolean, text?: string) {
    if (!this.nativeAttached) return;
    getNativeLibrary()?.symbols.bunite_view_respond_dialog(
      this.id, requestId, accept, toCString(text ?? "")
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

  accessibilitySnapshot(interestingOnly: boolean): Promise<AccessibilitySnapshotResult> {
    if (!this.nativeAttached) {
      return Promise.resolve({ ok: false, code: "not_supported", message: "native runtime unavailable" });
    }
    return new Promise<AccessibilitySnapshotResult>((resolve) => {
      const requestId = registerAxRequest(this.id, resolve, interestingOnly);
      const timer = setTimeout(() => {
        if (axResolvers.delete(requestId)) {
          resolve({ ok: false, code: "timeout", message: "accessibility snapshot timed out after 30s" });
        }
      }, 30_000);
      const wrappedResolve = (r: AccessibilitySnapshotResult) => { clearTimeout(timer); resolve(r); };
      axResolvers.set(requestId, { viewId: this.id, resolve: wrappedResolve, interestingOnly });
      // Native flag is currently unused (filter is TS-side); kept for ABI shape stability.
      getNativeLibrary()?.symbols.bunite_view_accessibility_snapshot(this.id, requestId, interestingOnly ? 1 : 0);
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
    rejectAxForView(this.id);
    rejectFramesForView(this.id);
    this.nativeAttached = false;
    for (const eventName of [
      "will-navigate", "did-navigate", "dom-ready", "new-window-open", "permission-requested", "title-changed"
    ]) {
      buniteEventEmitter.removeAllListeners(`${eventName}-${this.id}`);
    }
    delete BrowserViewMap[this.id];
  }

  on(
    name: "will-navigate" | "did-navigate" | "dom-ready" | "new-window-open" | "permission-requested" | "title-changed" | "load-start" | "load-finish" | "load-fail" | "dialog" | "console-message" | "download-event" | "popup-requested",
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
