import { call, defineCap, stream, cap } from "./schema";
import type { CapDef } from "./schema";

export const BrowserWindowCap = defineCap("bunite.BrowserWindow", {
  focus: call<void, void>(),
  close: call<void, void>(),
  setBounds: call<{ x: number; y: number; w: number; h: number }, void>(),
  setTitle: call<{ title: string }, void>(),
  id: call<void, number>({ idempotent: true }),
  label: call<void, string>({ idempotent: true }),
});

export const WindowCap = defineCap("bunite.Window", {
  create: call<WindowCreateOpts, typeof BrowserWindowCap>({ returns: cap(BrowserWindowCap) }),
  list: call<void, typeof BrowserWindowCap>({ returns: cap.array(BrowserWindowCap), idempotent: true }),
  focus: call<{ id?: number; label?: string }, void>(),
  close: call<{ id?: number; label?: string }, void>(),
});

export interface WindowCreateOpts {
  url: string;
  title?: string;
  bounds?: { x?: number; y?: number; w?: number; h?: number };
  label?: string;
}

export const FileRefCap = defineCap("bunite.FileRef", {
  text: call<void, string>({ idempotent: true }),
  bytes: call<void, Uint8Array>({ idempotent: true }),
  path: call<void, string>({ idempotent: true }),
  revoke: call<void, void>(),
}, { disposal: { method: "revoke" } });

export const DialogsCap = defineCap("bunite.Dialogs", {
  openFile: call<DialogOpenFileOpts, typeof FileRefCap>({ returns: cap.array(FileRefCap) }),
  saveFile: call<DialogSaveFileOpts, typeof FileRefCap>({ returns: cap(FileRefCap) }),
  showMessage: call<DialogMessageOpts, "primary" | "secondary" | "tertiary">(),
});

export interface DialogOpenFileOpts {
  title?: string;
  filters?: { name: string; extensions: string[] }[];
  multiple?: boolean;
  startDir?: string;
}

export interface DialogSaveFileOpts {
  title?: string;
  defaultName?: string;
  filters?: { name: string; extensions: string[] }[];
}

export interface DialogMessageOpts {
  title?: string;
  body: string;
  primary?: string;
  secondary?: string;
  tertiary?: string;
}

export const ClipboardCap = defineCap("bunite.Clipboard", {
  readText: call<void, string>({ idempotent: true }),
  writeText: call<{ text: string }, void>(),
  readBytes: call<{ mime: string }, Uint8Array>({ idempotent: true }),
  writeBytes: call<{ mime: string; data: Uint8Array }, void>(),
});

export const ShellCap = defineCap("bunite.Shell", {
  openExternal: call<{ url: string }, boolean>(),
  showItemInFolder: call<{ path: string }, void>(),
});

/** page → host event sink. Distinct from RuntimeCap (page → host *request* API)
 *  so future arms like `reportError` / `reportPerformance` don't pollute the
 *  runtime cap. Mounted as a sub-cap via `RuntimeCap.reporting()`. */
export const PageReportingCap = defineCap("bunite.PageReporting", {
  /** preload coalesces console calls in a 16ms window and pushes the batch.
   *  Fire-and-forget — preload `.catch`es resource_exhausted to avoid throwing
   *  inside `console.log` (which would corrupt page semantics). */
  reportConsoleBatch: call<{ entries: ConsoleEntry[] }, void>(),
});

export type SurfaceMask = { x: number; y: number; w: number; h: number };

/** Automation feature flags reported per surface. Append-only — consumers
 *  treat missing fields as `false`. Backend-honest: a method may exist on the
 *  RPC surface but return `not_supported` when the backend can't fulfil it. */
export interface SurfaceCapabilities {
  evaluate: boolean;
  crossOriginEval: boolean;
  surfaceEvents: boolean;
  /** click/type/press/mouse produce DOM events with `isTrusted=true` on the page.
   *  Does NOT cover scroll/screenshot (those may use CDP path with isTrusted=false). */
  nativeInputTrusted: boolean;
  click: boolean;
  type: boolean;
  press: boolean;
  scroll: boolean;
  /** Raw mouse primitives (move/down/up) — required for drag & hover. */
  mouse: boolean;
  /** Page-initiated dialogs (alert/confirm/prompt/beforeunload) routed through
   *  `dialogs` stream + `respondToDialog`. `beforeunload` is Win-only (WebKit
   *  handles it through navigation-policy delegate, not script-dialog). */
  dialogs: boolean;
  /** Page `console.{log,warn,error,info,debug}` captured via preload proxy.
   *  Only effective for surfaces whose origin is in the preload allowlist
   *  (default `appres://app.internal/*`); cross-origin pages don't get preload
   *  injection, so `consoleEvents` stays empty even though the flag is true. */
  console: boolean;
  screenshot: boolean;
  /** Present only when `screenshot` is true. */
  formats?: ("png" | "jpeg")[];
  accessibilitySnapshot: boolean;
  getBoundingRect: boolean;
  /** `listFrames` works + `evaluate({frameId})` reaches the target frame's
   *  isolated world. Frame-targeted input dispatch is not yet implemented. */
  frames: boolean;
  /** Backend can intercept downloads and emit lifecycle events. When `false`,
   *  every download attempt emits `{kind: "blocked", reason: "not_supported"}`. */
  downloads: boolean;
  /** Backend can intercept popups (window.open / target=_blank / cmd-click) and
   *  mint a new surface with the opener relationship preserved. Host adopts via
   *  `acceptPopup({newSurfaceId, hostViewId, bounds})`. */
  popups: boolean;
  /** Atomic `resolveAndClick(selector)`. Click trust is per-call (see `ResolveAndClickResult`). */
  resolveAndClick: boolean;
}

export interface AxNode {
  nodeId: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  level?: number;
  checked?: boolean | "mixed";
  pressed?: boolean | "mixed";
  expanded?: boolean;
  disabled?: boolean;
  focused?: boolean;
  invalid?: boolean;
  required?: boolean;
  selected?: boolean;
  children?: AxNode[];
}

export interface AccessibilitySnapshotArgs {
  surfaceId: number;
  /** Drop nodes with `ignored:true` (and reparent their children). Default true. */
  interestingOnly?: boolean;
}
export type AccessibilitySnapshotResult =
  | { ok: true; tree: AxNode }
  | { ok: false; code: "not_supported" | "runtime_error" | "timeout"; message: string };

export interface BoundingRectArgs {
  surfaceId: number;
  selector: string;
  /** When set, `rect` is FRAME-LOCAL (the iframe's own viewport). Use frame-local
   *  coords for further `evaluate({frameId})` ops; do not pass to `click({x,y})`
   *  which expects page-viewport coords. */
  frameId?: string;
}
export type BoundingRectResult =
  /** `visible` = rect has size AND intersects the frame's viewport. opacity /
   *  visibility:hidden / occlusion are NOT checked — agent must `evaluate` for those. */
  | { ok: true; rect: { x: number; y: number; width: number; height: number }; visible: boolean }
  | { ok: false; code: "not_found" | "runtime_error" | "cross_origin" | "not_supported"; message: string };

export interface Frame {
  frameId: string;
  parentFrameId: string | null;
  origin: string;
  url: string;
  name?: string;
}

export type ListFramesResult =
  | { ok: true; frames: Frame[] }
  | { ok: false; code: "not_supported" | "runtime_error"; message: string };

export type DownloadPolicy = "auto" | "ask" | "block";

export type DownloadEvent =
  | { kind: "started"; id: string; url: string; suggestedFilename: string; mimeType?: string; sizeBytes?: number }
  | { kind: "progress"; id: string; receivedBytes: number; totalBytes?: number }
  | { kind: "completed"; id: string; localPath: string }
  | { kind: "failed"; id: string; reason: string }
  | { kind: "blocked"; id: string; url: string; reason: "host-policy" | "backend-block" | "mime-blocked" | "not_supported" | "ask-not-implemented" };

export type WaitForDownloadResult =
  | { ok: true; id: string; suggestedFilename: string; url: string; mimeType?: string; sizeBytes?: number; localPath: string }
  | { ok: false; code: "timeout" | "blocked" | "failed" | "not_supported"; message: string };

export interface SetDownloadPolicyArgs {
  surfaceId: number;
  policy: DownloadPolicy;
  /** Absolute path. When omitted, backend keeps current dir (or temp). */
  downloadDir?: string;
}

export interface AcceptPopupArgs {
  newSurfaceId: number;
  /** The host BrowserView that will own the new surface. */
  hostViewId: number;
  bounds: { x: number; y: number; width: number; height: number };
}
export type AcceptPopupResult =
  | { ok: true }
  | { ok: false; code: "not_found" | "host_view_invalid"; message: string };

export interface ExtendPopupTimeoutArgs {
  newSurfaceId: number;
  /** Reset semantic: new deadline = now + gracePeriodMs. Not cumulative.
   *  Capped at 60s since the popup arm was emitted. */
  gracePeriodMs: number;
}
export type ExtendPopupTimeoutResult =
  | { ok: true; deadlineMs: number }   // epoch ms of the new deadline
  | { ok: false; code: "not_found" | "already_adopted" | "already_dismissed" | "cap_exceeded"; message: string };

/** Surface lifecycle event arm before the surface pipeline stamps `epoch`. */
export type SurfaceEventBase =
  | { type: "navigate"; url: string }
  | { type: "load-start"; url: string }
  | { type: "load-finish"; url: string }
  | { type: "load-fail"; url: string; reason?: string }
  | { type: "title-change"; title: string }
  | {
      type: "popup";
      url: string;
      disposition: "tab" | "window" | "popup";
      openerSurfaceId: number;
      /** Native surface ID minted before the arm is emitted. Host must call
       *  `acceptPopup` (within `popupAdoptionTimeoutMs`, default 5s) to attach,
       *  or `dismissPopup` to close. Auto-dismiss fires on timeout. */
      newSurfaceId: number;
    };

/** Wire form of `SurfaceEventBase`. `epoch` bumps on every `navigate` (incl. SPA
 *  `pushState`); other arms carry the current epoch. See `docs/browser-automation.md`. */
export type SurfaceEvent = SurfaceEventBase & { epoch: number };

export interface NavigationState {
  lastLoadEpoch: number;
  isLoading: boolean;
  currentUrl: string;
}

export type EvaluateResult =
  | { ok: true; value: unknown }
  | { ok: false; code: "cross_origin" | "runtime_error" | "not_supported" | "timeout"; message: string };

/** Modifier bitmask for input dispatch. Backends translate to native form. */
export type Modifier = "alt" | "ctrl" | "meta" | "shift";

export interface ClickArgs {
  surfaceId: number;
  x: number;
  y: number;
  button?: "left" | "middle" | "right";
  clickCount?: number;
  modifiers?: Modifier[];
}
export interface TypeArgs { surfaceId: number; text: string }
export interface PressArgs {
  surfaceId: number;
  key: string;
  modifiers?: Modifier[];
  /** "both" (default) emits down→char→up; "down" / "up" emit only that half.
   *  For Playwright-style modifier-held wrap: keydown → click → keyup. */
  action?: "down" | "up" | "both";
}
export interface MouseArgs {
  surfaceId: number;
  /** "move" produces mouseMove only; "down"/"up" produces a single half of
   *  a mouse-button event. Compose drag = down → move(s) → up. modifiers are
   *  per-call atomic (no sticky state across calls). */
  action: "move" | "down" | "up";
  x: number;
  y: number;
  /** Required for "down"/"up"; ignored for "move". */
  button?: "left" | "middle" | "right";
  modifiers?: Modifier[];
}

/** Page-initiated modal dialog. Backend holds page execution until consumer
 *  calls `respondToDialog` with the matching `requestId`. If no response
 *  arrives within `setDialogTimeout` (default 5000ms; null = wait forever),
 *  host auto-dismisses and emits `{kind: "auto-dismissed", originalKind, message}`
 *  so the consumer learns the page proceeded without explicit answer.
 *
 *  `beforeunload` arm support per backend:
 *  - CEF (Win)         : ✔ — `OnBeforeUnloadDialog`
 *  - WV2 (Win)         : ✔ — `ScriptDialogOpening` with kind `BEFOREUNLOAD`
 *  - WKWebView (mac)   : ✘ — handled by WKNavigationDelegate, surfaced as `will-navigate`
 *  - WebKitGTK (linux) : ✔ — `script-dialog` signal with `BEFORE_UNLOAD_CONFIRM` */
export type DialogEvent =
  | {
      kind: "alert" | "confirm" | "prompt" | "beforeunload";
      requestId: number;
      message: string;
      /** Initial text for `prompt` only. */
      defaultPrompt?: string;
    }
  | {
      kind: "auto-dismissed";
      originalKind: "alert" | "confirm" | "prompt" | "beforeunload";
      message: string;
    };

export interface RespondToDialogArgs {
  surfaceId: number;
  requestId: number;
  accept: boolean;
  /** For `prompt` dialogs — the text the page receives. Ignored otherwise. */
  text?: string;
}

export interface SetDialogTimeoutArgs {
  surfaceId: number;
  /** Milliseconds before unanswered dialog is auto-dismissed. `null` disables
   *  the safety net — page hangs until consumer responds. Default 5000. */
  ms: number | null;
}

export interface WaitForSelectorArgs {
  surfaceId: number;
  selector: string;
  /** Default 5000ms. Polled at 50ms intervals via `evaluate`. */
  timeoutMs?: number;
  frameId?: string;
}
export interface WaitForFunctionArgs {
  surfaceId: number;
  /** JS expression returning truthy when satisfied. */
  expression: string;
  /** Default 5000ms. */
  timeoutMs?: number;
  /** Default 50ms. Increase for heavy expressions to reduce IPC load. */
  pollIntervalMs?: number;
  frameId?: string;
}
export type WaitResult =
  | { ok: true }
  | { ok: false; code: "timeout" | "runtime_error" | "cross_origin"; message: string };

export type ConsoleLevel = "log" | "warn" | "error" | "info" | "debug";

export interface ConsoleEntry {
  level: ConsoleLevel;
  /** `.toString()` / JSON.stringify-ed arguments — preload doesn't structured-clone. */
  args: string[];
  /** Page-side `Date.now()` at capture time. */
  ts: number;
}
export interface ScrollArgs {
  surfaceId: number;
  dx: number;
  dy: number;
  x?: number;
  y?: number;
  modifiers?: Modifier[];
}

export interface ScreenshotArgs {
  surfaceId: number;
  format?: "png" | "jpeg";
  /** JPEG only; 0–100. Ignored for PNG. */
  quality?: number;
}
export type ScreenshotResult =
  | { ok: true; data: Uint8Array; mime: string; format: "png" | "jpeg" }
  | { ok: false; code: "not_supported" | "runtime_error" | "timeout" | "black_frame"; message: string };

export interface ResolveAndClickArgs {
  surfaceId: number;
  selector: string;
  /** Same-origin iframe (CEF/WV2). OOPIF → `cross_origin`. mac/linux → `not_supported`. */
  frameId?: string;
  button?: "left" | "middle" | "right";
  clickCount?: number;
  modifiers?: Modifier[];
}
/** rect is viewport-normalized. `isTrustedEvent` is empirical per backend:
 *  CEF false (browser-process CDP), WV2/mac true. */
export type ResolveAndClickResult =
  | { ok: true; rect: { x: number; y: number; width: number; height: number }; isTrustedEvent: boolean }
  | { ok: false; code: "not_found" | "not_visible" | "runtime_error" | "cross_origin" | "not_supported"; message: string };

export const SurfaceCap = defineCap("bunite.Surface", {
  init: call<{
    src: string;
    x: number;
    y: number;
    width: number;
    height: number;
    hidden?: boolean;
  }, { surfaceId: number }>(),
  resize: call<{ surfaceId: number; x: number; y: number; w: number; h: number }, void>(),
  remove: call<{ surfaceId: number }, void>(),
  setHidden: call<{ surfaceId: number; hidden: boolean }, void>(),
  setMasks: call<{ surfaceId: number; masks: SurfaceMask[] }, void>(),
  setAllPassthrough: call<{ passthrough: boolean }, void>(),
  bringAllVisiblesToFront: call<void, void>(),
  navigate: call<{ surfaceId: number; url: string }, void>(),
  goBack: call<{ surfaceId: number }, void>(),
  reload: call<{ surfaceId: number }, void>(),
  evaluate: call<{ surfaceId: number; script: string; frameId?: string }, EvaluateResult>(),
  capabilities: call<{ surfaceId: number }, SurfaceCapabilities>(),
  click: call<ClickArgs, void>(),
  type: call<TypeArgs, void>(),
  press: call<PressArgs, void>(),
  scroll: call<ScrollArgs, void>(),
  mouse: call<MouseArgs, void>(),
  screenshot: call<ScreenshotArgs, ScreenshotResult>(),
  waitForSelector: call<WaitForSelectorArgs, WaitResult>(),
  waitForFunction: call<WaitForFunctionArgs, WaitResult>(),
  respondToDialog: call<RespondToDialogArgs, void>(),
  setDialogTimeout: call<SetDialogTimeoutArgs, void>(),
  getConsoleBuffer: call<{ surfaceId: number; clear?: boolean }, ConsoleEntry[]>({ idempotent: true }),
  surfaceEvents: stream<{ surfaceId: number }, SurfaceEvent>(),
  dialogs: stream<{ surfaceId: number }, DialogEvent>(),
  consoleEvents: stream<{ surfaceId: number }, ConsoleEntry>(),
  getNavigationState: call<{ surfaceId: number }, NavigationState>({ idempotent: true }),
  accessibilitySnapshot: call<AccessibilitySnapshotArgs, AccessibilitySnapshotResult>(),
  getBoundingRect: call<BoundingRectArgs, BoundingRectResult>({ idempotent: true }),
  listFrames: call<{ surfaceId: number }, ListFramesResult>({ idempotent: true }),
  downloadEvents: stream<{ surfaceId: number }, DownloadEvent>(),
  waitForDownload: call<{ surfaceId: number; timeoutMs?: number }, WaitForDownloadResult>(),
  setDownloadPolicy: call<SetDownloadPolicyArgs, void>(),
  acceptPopup: call<AcceptPopupArgs, AcceptPopupResult>(),
  dismissPopup: call<{ newSurfaceId: number }, void>(),
  extendPopupTimeout: call<ExtendPopupTimeoutArgs, ExtendPopupTimeoutResult>(),
  resolveAndClick: call<ResolveAndClickArgs, ResolveAndClickResult>(),
});

export const RuntimeCap = defineCap("bunite.Runtime", {
  window: call<void, typeof WindowCap>({ returns: cap(WindowCap), idempotent: true }),
  dialogs: call<void, typeof DialogsCap>({ returns: cap(DialogsCap), idempotent: true }),
  clipboard: call<void, typeof ClipboardCap>({ returns: cap(ClipboardCap), idempotent: true }),
  shell: call<void, typeof ShellCap>({ returns: cap(ShellCap), idempotent: true }),
  appName: call<void, string>({ idempotent: true }),
  appVersion: call<void, string>({ idempotent: true }),
  theme: call<void, "light" | "dark">({ idempotent: true }),
  themeWatch: stream<void, "light" | "dark">(),
  surface: call<void, typeof SurfaceCap>({ returns: cap(SurfaceCap), idempotent: true }),
  reporting: call<void, typeof PageReportingCap>({ returns: cap(PageReportingCap), idempotent: true }),
});

export const FRAMEWORK_TYPE_IDS = {
  Runtime: 1,
  Window: 2,
  Dialogs: 3,
  FileRef: 4,
  Clipboard: 5,
  Shell: 6,
  BrowserWindow: 7,
  Surface: 8,
  PageReporting: 9,
} as const;

const FRAMEWORK_CAP_TYPE_IDS = new Map<CapDef<any, any>, number>([
  [RuntimeCap, FRAMEWORK_TYPE_IDS.Runtime],
  [WindowCap, FRAMEWORK_TYPE_IDS.Window],
  [DialogsCap, FRAMEWORK_TYPE_IDS.Dialogs],
  [FileRefCap, FRAMEWORK_TYPE_IDS.FileRef],
  [ClipboardCap, FRAMEWORK_TYPE_IDS.Clipboard],
  [ShellCap, FRAMEWORK_TYPE_IDS.Shell],
  [BrowserWindowCap, FRAMEWORK_TYPE_IDS.BrowserWindow],
  [SurfaceCap, FRAMEWORK_TYPE_IDS.Surface],
  [PageReportingCap, FRAMEWORK_TYPE_IDS.PageReporting],
]);

export function frameworkTypeIdOf(cap: CapDef<any, any>): number | undefined {
  return FRAMEWORK_CAP_TYPE_IDS.get(cap);
}
