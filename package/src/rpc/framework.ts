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

export type SurfaceMask = { x: number; y: number; w: number; h: number };

/** Automation feature flags reported per surface. Append-only — consumers
 *  treat missing fields as `false`. Backend-honest: a method may exist on the
 *  RPC surface but return `not_supported` when the backend can't fulfil it. */
export interface SurfaceCapabilities {
  evaluate: boolean;
  crossOriginEval: boolean;
  titleChanged: boolean;
  /** Stage A: always false. Set true when SendInput focus choreography lands. */
  nativeInputTrusted: boolean;
  click: boolean;
  type: boolean;
  press: boolean;
  scroll: boolean;
  screenshot: boolean;
  /** Present only when `screenshot` is true. */
  formats?: ("png" | "jpeg")[];
}

export type EvaluateResult =
  | { ok: true; value: unknown }
  | { ok: false; code: "cross_origin" | "runtime_error" | "not_supported" | "timeout"; message: string };

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
  evaluate: call<{ surfaceId: number; script: string }, EvaluateResult>(),
  capabilities: call<{ surfaceId: number }, SurfaceCapabilities>(),
  didNavigate: stream<void, { surfaceId: number; url: string }>(),
  titleChanged: stream<void, { surfaceId: number; title: string }>(),
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
]);

export function frameworkTypeIdOf(cap: CapDef<any, any>): number | undefined {
  return FRAMEWORK_CAP_TYPE_IDS.get(cap);
}
