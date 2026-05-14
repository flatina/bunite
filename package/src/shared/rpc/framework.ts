import { call, defineCap, stream, cap } from "./schema";

export const BrowserWindowCap = defineCap({
  focus: call<void, void>(),
  close: call<void, void>(),
  setBounds: call<{ x: number; y: number; w: number; h: number }, void>(),
  setTitle: call<{ title: string }, void>(),
  id: call<void, number>({ idempotent: true }),
  label: call<void, string>({ idempotent: true }),
});

export const WindowCap = defineCap({
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

export const FileRefCap = defineCap({
  text: call<void, string>({ idempotent: true }),
  bytes: call<void, Uint8Array>({ idempotent: true }),
  path: call<void, string>({ idempotent: true }),
  revoke: call<void, void>(),
}, { disposal: { method: "revoke", async: true } });

export const DialogsCap = defineCap({
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

export const ClipboardCap = defineCap({
  readText: call<void, string>({ idempotent: true }),
  writeText: call<{ text: string }, void>(),
  readBytes: call<{ mime: string }, Uint8Array>({ idempotent: true }),
  writeBytes: call<{ mime: string; data: Uint8Array }, void>(),
});

export const ShellCap = defineCap({
  openExternal: call<{ url: string }, boolean>(),
  showItemInFolder: call<{ path: string }, void>(),
});

export const RuntimeCap = defineCap({
  window: call<void, typeof WindowCap>({ returns: cap(WindowCap), idempotent: true }),
  dialogs: call<void, typeof DialogsCap>({ returns: cap(DialogsCap), idempotent: true }),
  clipboard: call<void, typeof ClipboardCap>({ returns: cap(ClipboardCap), idempotent: true }),
  shell: call<void, typeof ShellCap>({ returns: cap(ShellCap), idempotent: true }),
  appName: call<void, string>({ idempotent: true }),
  appVersion: call<void, string>({ idempotent: true }),
  theme: call<void, "light" | "dark">({ idempotent: true }),
  themeWatch: stream<void, "light" | "dark">(),
});

export const FRAMEWORK_TYPE_IDS = {
  Runtime: 1,
  Window: 2,
  Dialogs: 3,
  FileRef: 4,
  Clipboard: 5,
  Shell: 6,
  BrowserWindow: 7,
} as const;

import type { CapDef } from "./schema";

const FRAMEWORK_CAP_TYPE_IDS = new Map<CapDef<any, any>, number>([
  [RuntimeCap, FRAMEWORK_TYPE_IDS.Runtime],
  [WindowCap, FRAMEWORK_TYPE_IDS.Window],
  [DialogsCap, FRAMEWORK_TYPE_IDS.Dialogs],
  [FileRefCap, FRAMEWORK_TYPE_IDS.FileRef],
  [ClipboardCap, FRAMEWORK_TYPE_IDS.Clipboard],
  [ShellCap, FRAMEWORK_TYPE_IDS.Shell],
  [BrowserWindowCap, FRAMEWORK_TYPE_IDS.BrowserWindow],
]);

export function frameworkTypeIdOf(cap: CapDef<any, any>): number | undefined {
  return FRAMEWORK_CAP_TYPE_IDS.get(cap);
}
