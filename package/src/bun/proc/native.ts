import { CString, dlopen, FFIType, JSCallback, ptr, type Pointer } from "bun:ffi";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { buniteEventEmitter } from "../events/eventEmitter";
import { resolveNativeArtifacts, type ResolvedNativeArtifacts } from "../../shared/paths";
import { log } from "../../shared/log";

export type NativeBootstrapOptions = {
  allowStub?: boolean;
  hideConsole?: boolean;
  popupBlocking?: boolean;
  chromiumFlags?: Record<string, string | boolean>;
};

export type NativeRuntimeState = {
  initialized: boolean;
  usingStub: boolean;
  nativeLoaded: boolean;
  artifacts: ResolvedNativeArtifacts;
};

type CStringPointer = Pointer;

type NativeSymbols = {
  bunite_set_log_level: (level: number) => void;
  bunite_init: (
    processHelperPath: CStringPointer,
    cefDir: CStringPointer,
    hideConsole: boolean,
    popupBlocking: boolean,
    chromiumFlagsJson: CStringPointer
  ) => boolean;
  bunite_run_loop: () => void;
  bunite_quit: () => void;
  bunite_free_cstring: (value: Pointer) => void;
  bunite_window_create: (
    windowId: number,
    x: number,
    y: number,
    width: number,
    height: number,
    title: CStringPointer,
    titleBarStyle: CStringPointer,
    transparent: boolean,
    hidden: boolean,
    minimized: boolean,
    maximized: boolean
  ) => boolean;
  bunite_window_destroy: (windowId: number) => void;
  bunite_window_reset_close_pending: (windowId: number) => void;
  bunite_window_show: (windowId: number) => void;
  bunite_window_close: (windowId: number) => void;
  bunite_window_set_title: (windowId: number, title: CStringPointer) => void;
  bunite_window_minimize: (windowId: number) => void;
  bunite_window_unminimize: (windowId: number) => void;
  bunite_window_is_minimized: (windowId: number) => boolean;
  bunite_window_maximize: (windowId: number) => void;
  bunite_window_unmaximize: (windowId: number) => void;
  bunite_window_is_maximized: (windowId: number) => boolean;
  bunite_window_set_frame: (
    windowId: number,
    x: number,
    y: number,
    width: number,
    height: number
  ) => void;
  bunite_view_create: (
    viewId: number,
    windowId: number,
    url: CStringPointer,
    html: CStringPointer,
    preload: CStringPointer,
    viewsRoot: CStringPointer,
    navigationRulesJson: CStringPointer,
    x: number,
    y: number,
    width: number,
    height: number,
    autoResize: boolean,
    sandbox: boolean
  ) => boolean;
  bunite_register_view_route: (path: CStringPointer) => void;
  bunite_unregister_view_route: (path: CStringPointer) => void;
  bunite_complete_route_request: (requestId: number, html: CStringPointer) => void;
  bunite_view_set_visible: (viewId: number, visible: boolean) => void;
  bunite_view_bring_to_front: (viewId: number) => void;
  bunite_view_set_bounds: (viewId: number, x: number, y: number, width: number, height: number) => void;
  bunite_view_set_anchor: (viewId: number, mode: number, inset: number) => void;
  bunite_view_go_back: (viewId: number) => void;
  bunite_view_reload: (viewId: number) => void;
  bunite_view_load_url: (viewId: number, url: CStringPointer) => void;
  bunite_view_load_html: (viewId: number, html: CStringPointer) => void;
  bunite_view_remove: (viewId: number) => void;
  bunite_view_open_devtools: (viewId: number) => void;
  bunite_view_close_devtools: (viewId: number) => void;
  bunite_view_toggle_devtools: (viewId: number) => void;
  bunite_complete_permission_request: (requestId: number, state: number) => void;
  bunite_show_message_box: (
    type: CStringPointer,
    title: CStringPointer,
    message: CStringPointer,
    detail: CStringPointer,
    buttons: CStringPointer,
    defaultId: number,
    cancelId: number
  ) => number;
  bunite_show_browser_message_box: (
    type: CStringPointer,
    title: CStringPointer,
    message: CStringPointer,
    detail: CStringPointer,
    buttons: CStringPointer,
    defaultId: number,
    cancelId: number
  ) => number;
  bunite_cancel_browser_message_box: (requestId: number) => void;
  bunite_set_webview_event_handler: (handler: JSCallback) => void;
  bunite_set_window_event_handler: (handler: JSCallback) => void;
};

type LoadedNativeLibrary = {
  symbols: NativeSymbols;
};

const messageBoxButtonSeparator = "\x1f";
const unsetCancelId = -1;

const nativeSymbolDefinitions = {
  bunite_set_log_level: {
    args: [FFIType.i32],
    returns: FFIType.void
  },
  bunite_init: {
    args: [FFIType.cstring, FFIType.cstring, FFIType.bool, FFIType.bool, FFIType.cstring],
    returns: FFIType.bool
  },
  bunite_run_loop: {
    args: [],
    returns: FFIType.void
  },
  bunite_quit: {
    args: [],
    returns: FFIType.void
  },
  bunite_free_cstring: {
    args: [FFIType.ptr],
    returns: FFIType.void
  },
  bunite_window_create: {
    args: [
      FFIType.u32,
      FFIType.f64,
      FFIType.f64,
      FFIType.f64,
      FFIType.f64,
      FFIType.cstring,
      FFIType.cstring,
      FFIType.bool,
      FFIType.bool,
      FFIType.bool,
      FFIType.bool
    ],
    returns: FFIType.bool
  },
  bunite_window_destroy: {
    args: [FFIType.u32],
    returns: FFIType.void
  },
  bunite_window_reset_close_pending: {
    args: [FFIType.u32],
    returns: FFIType.void
  },
  bunite_window_show: {
    args: [FFIType.u32],
    returns: FFIType.void
  },
  bunite_window_close: {
    args: [FFIType.u32],
    returns: FFIType.void
  },
  bunite_window_set_title: {
    args: [FFIType.u32, FFIType.cstring],
    returns: FFIType.void
  },
  bunite_window_minimize: {
    args: [FFIType.u32],
    returns: FFIType.void
  },
  bunite_window_unminimize: {
    args: [FFIType.u32],
    returns: FFIType.void
  },
  bunite_window_is_minimized: {
    args: [FFIType.u32],
    returns: FFIType.bool
  },
  bunite_window_maximize: {
    args: [FFIType.u32],
    returns: FFIType.void
  },
  bunite_window_unmaximize: {
    args: [FFIType.u32],
    returns: FFIType.void
  },
  bunite_window_is_maximized: {
    args: [FFIType.u32],
    returns: FFIType.bool
  },
  bunite_window_set_frame: {
    args: [FFIType.u32, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.f64],
    returns: FFIType.void
  },
  bunite_view_create: {
    args: [
      FFIType.u32,
      FFIType.u32,
      FFIType.cstring,
      FFIType.cstring,
      FFIType.cstring,
      FFIType.cstring,
      FFIType.cstring,
      FFIType.f64,
      FFIType.f64,
      FFIType.f64,
      FFIType.f64,
      FFIType.bool,
      FFIType.bool
    ],
    returns: FFIType.bool
  },
  bunite_register_view_route: {
    args: [FFIType.cstring],
    returns: FFIType.void
  },
  bunite_unregister_view_route: {
    args: [FFIType.cstring],
    returns: FFIType.void
  },
  bunite_complete_route_request: {
    args: [FFIType.u32, FFIType.cstring],
    returns: FFIType.void
  },
  bunite_view_set_visible: {
    args: [FFIType.u32, FFIType.bool],
    returns: FFIType.void
  },
  bunite_view_bring_to_front: {
    args: [FFIType.u32],
    returns: FFIType.void
  },
  bunite_view_set_bounds: {
    args: [FFIType.u32, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.f64],
    returns: FFIType.void
  },
  bunite_view_set_anchor: {
    args: [FFIType.u32, FFIType.i32, FFIType.f64],
    returns: FFIType.void
  },
  bunite_view_go_back: {
    args: [FFIType.u32],
    returns: FFIType.void
  },
  bunite_view_reload: {
    args: [FFIType.u32],
    returns: FFIType.void
  },
  bunite_view_load_url: {
    args: [FFIType.u32, FFIType.cstring],
    returns: FFIType.void
  },
  bunite_view_load_html: {
    args: [FFIType.u32, FFIType.cstring],
    returns: FFIType.void
  },
  bunite_view_remove: {
    args: [FFIType.u32],
    returns: FFIType.void
  },
  bunite_view_open_devtools: {
    args: [FFIType.u32],
    returns: FFIType.void
  },
  bunite_view_close_devtools: {
    args: [FFIType.u32],
    returns: FFIType.void
  },
  bunite_view_toggle_devtools: {
    args: [FFIType.u32],
    returns: FFIType.void
  },
  bunite_complete_permission_request: {
    args: [FFIType.u32, FFIType.u32],
    returns: FFIType.void
  },
  bunite_show_message_box: {
    args: [
      FFIType.cstring,
      FFIType.cstring,
      FFIType.cstring,
      FFIType.cstring,
      FFIType.cstring,
      FFIType.i32,
      FFIType.i32
    ],
    returns: FFIType.i32
  },
  bunite_show_browser_message_box: {
    args: [
      FFIType.cstring,
      FFIType.cstring,
      FFIType.cstring,
      FFIType.cstring,
      FFIType.cstring,
      FFIType.i32,
      FFIType.i32
    ],
    returns: FFIType.u32
  },
  bunite_cancel_browser_message_box: {
    args: [FFIType.u32],
    returns: FFIType.void
  },
  bunite_set_webview_event_handler: {
    args: [FFIType.function],
    returns: FFIType.void
  },
  bunite_set_window_event_handler: {
    args: [FFIType.function],
    returns: FFIType.void
  }
} as const;

let state: NativeRuntimeState | null = null;
let nativeLibrary: LoadedNativeLibrary | null = null;
const retainedCStringBuffers: Buffer[] = [];
let webviewEventCallback: JSCallback | null = null;
let windowEventCallback: JSCallback | null = null;
let routeRequestHandler: ((requestId: number, path: string) => void) | null = null;

export function setRouteRequestHandler(handler: (requestId: number, path: string) => void) {
  routeRequestHandler = handler;
}

export function toCString(value: string): CStringPointer {
  const normalized = value.endsWith("\0") ? value : `${value}\0`;
  const buffer = Buffer.from(normalized, "utf8");

  // Keep recent CString buffers alive long enough for native code to copy them.
  // This is not a long-term ownership model for retained native pointers, but it
  // avoids immediate GC hazards across the current FFI call boundary.
  retainedCStringBuffers.push(buffer);
  if (retainedCStringBuffers.length > 1024) {
    retainedCStringBuffers.shift();
  }

  return ptr(buffer);
}

function applyEnvironment(artifacts: ResolvedNativeArtifacts) {
  const cefBinaryDir = artifacts.cefDir && existsSync(join(artifacts.cefDir, "Release", "libcef.dll"))
    ? join(artifacts.cefDir, "Release")
    : artifacts.cefDir;
  const cefResourceDir = artifacts.cefDir && existsSync(join(artifacts.cefDir, "Resources", "resources.pak"))
    ? join(artifacts.cefDir, "Resources")
    : artifacts.cefDir;

  if (cefResourceDir && !process.env.ICU_DATA) {
    process.env.ICU_DATA = cefResourceDir;
  }
  if (cefBinaryDir) {
    const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    if (!pathEntries.includes(cefBinaryDir)) {
      process.env.PATH = [cefBinaryDir, ...pathEntries].join(delimiter);
    }
  }
}

function tryLoadNativeLibrary(artifacts: ResolvedNativeArtifacts) {
  if (!artifacts.nativeLibPath || !existsSync(artifacts.nativeLibPath)) {
    return null;
  }

  try {
    const library = dlopen(artifacts.nativeLibPath, nativeSymbolDefinitions as any);
    return {
      symbols: library.symbols as unknown as NativeSymbols
    } satisfies LoadedNativeLibrary;
  } catch (error) {
    log.warn("Failed to load native library via FFI.", error);
    return null;
  }
}

function maybeParsePayload(payload: string) {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return payload;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return payload;
  }
}

function registerNativeCallbacks(library: LoadedNativeLibrary) {
  if (!webviewEventCallback) {
    webviewEventCallback = new JSCallback(
      (viewId, eventNamePtr, payloadPtr) => {
        const eventName = new CString(eventNamePtr).toString();
        const payload = new CString(payloadPtr).toString();
        nativeLibrary?.symbols.bunite_free_cstring(eventNamePtr as Pointer);
        nativeLibrary?.symbols.bunite_free_cstring(payloadPtr as Pointer);

        switch (eventName) {
          case "will-navigate":
            buniteEventEmitter.emitEvent(
              buniteEventEmitter.events.webview.willNavigate({ detail: payload }),
              viewId
            );
            break;
          case "did-navigate":
            buniteEventEmitter.emitEvent(
              buniteEventEmitter.events.webview.didNavigate({ detail: payload }),
              viewId
            );
            break;
          case "dom-ready":
            buniteEventEmitter.emitEvent(
              buniteEventEmitter.events.webview.domReady({ detail: payload }),
              viewId
            );
            break;
          case "new-window-open":
            buniteEventEmitter.emitEvent(
              buniteEventEmitter.events.webview.newWindowOpen({
                detail: maybeParsePayload(payload) as string | { url: string }
              }),
              viewId
            );
            break;
          case "permission-requested":
            buniteEventEmitter.emitEvent(
              buniteEventEmitter.events.webview.permissionRequested(
                maybeParsePayload(payload) as { requestId: number; kind: number; url?: string }
              ),
              viewId
            );
            break;
          case "message-box-response":
            buniteEventEmitter.emitEvent(
              buniteEventEmitter.events.webview.messageBoxResponse(
                maybeParsePayload(payload) as { requestId: number; response: number }
              ),
              viewId
            );
            break;
          case "route-request": {
            const parsed = maybeParsePayload(payload) as { requestId: number; path: string };
            routeRequestHandler?.(parsed.requestId, parsed.path);
            break;
          }
        }
      },
      {
        args: [FFIType.u32, FFIType.cstring, FFIType.cstring],
        returns: FFIType.void,
        threadsafe: true
      }
    );
  }

  if (!windowEventCallback) {
    windowEventCallback = new JSCallback(
      (windowId, eventNamePtr, payloadPtr) => {
        const eventName = new CString(eventNamePtr).toString();
        const payload = new CString(payloadPtr).toString();
        nativeLibrary?.symbols.bunite_free_cstring(eventNamePtr as Pointer);
        nativeLibrary?.symbols.bunite_free_cstring(payloadPtr as Pointer);
        const parsedPayload = maybeParsePayload(payload);

        switch (eventName) {
          case "all-windows-closed":
            buniteEventEmitter.emitEvent(
              buniteEventEmitter.events.app.allWindowsClosed()
            );
            break;
          case "close-requested": {
            const crEvent = buniteEventEmitter.events.window.closeRequested({ id: windowId });
            buniteEventEmitter.emitEvent(crEvent, windowId);
            if (crEvent.responseWasSet && crEvent.response?.allow === false) {
              nativeLibrary?.symbols.bunite_window_reset_close_pending(windowId);
            } else {
              queueMicrotask(() => {
                nativeLibrary?.symbols.bunite_window_destroy(windowId);
              });
            }
            break;
          }
          case "close":
            buniteEventEmitter.emitEvent(
              buniteEventEmitter.events.window.close({ id: windowId }),
              windowId
            );
            break;
          case "focus":
            buniteEventEmitter.emitEvent(
              buniteEventEmitter.events.window.focus({ id: windowId }),
              windowId
            );
            break;
          case "blur":
            buniteEventEmitter.emitEvent(
              buniteEventEmitter.events.window.blur({ id: windowId }),
              windowId
            );
            break;
          case "move":
            if (parsedPayload && typeof parsedPayload === "object") {
              const { x = 0, y = 0, maximized = false, minimized = false } = parsedPayload as {
                x?: number;
                y?: number;
                maximized?: boolean;
                minimized?: boolean;
              };
              buniteEventEmitter.emitEvent(
                buniteEventEmitter.events.window.move({ id: windowId, x, y, maximized, minimized }),
                windowId
              );
            }
            break;
          case "resize":
            if (parsedPayload && typeof parsedPayload === "object") {
              const { x = 0, y = 0, width = 0, height = 0, maximized = false, minimized = false } = parsedPayload as {
                x?: number;
                y?: number;
                width?: number;
                height?: number;
                maximized?: boolean;
                minimized?: boolean;
              };
              buniteEventEmitter.emitEvent(
                buniteEventEmitter.events.window.resize({
                  id: windowId,
                  x,
                  y,
                  width,
                  height,
                  maximized,
                  minimized
                }),
                windowId
              );
            }
            break;
        }
      },
      {
        args: [FFIType.u32, FFIType.cstring, FFIType.cstring],
        returns: FFIType.void,
        threadsafe: true
      }
    );
  }

  library.symbols.bunite_set_webview_event_handler(webviewEventCallback);
  library.symbols.bunite_set_window_event_handler(windowEventCallback);
}

export async function initNativeRuntime(
  options: NativeBootstrapOptions = {}
): Promise<NativeRuntimeState> {
  if (state) {
    return state;
  }

  const allowStub = options.allowStub ?? true;
  const artifacts = resolveNativeArtifacts();
  const hasNativeArtifacts = Boolean(
    artifacts.nativeLibPath &&
      artifacts.processHelperPath &&
      existsSync(artifacts.nativeLibPath) &&
      existsSync(artifacts.processHelperPath)
  );

  applyEnvironment(artifacts);

  if (!hasNativeArtifacts && !allowStub) {
    throw new Error(
      "bunite native runtime packages are missing. Install platform packages or allow stub mode."
    );
  }

  nativeLibrary = hasNativeArtifacts ? tryLoadNativeLibrary(artifacts) : null;

  if (nativeLibrary) {
    registerNativeCallbacks(nativeLibrary);
    const chromiumFlagsJson = options.chromiumFlags
      ? JSON.stringify(options.chromiumFlags)
      : "";
    const initOk = nativeLibrary.symbols.bunite_init(
      toCString(artifacts.processHelperPath ?? ""),
      toCString(artifacts.cefDir ?? ""),
      options.hideConsole ?? false,
      options.popupBlocking ?? false,
      toCString(chromiumFlagsJson)
    );

    if (!initOk) {
      nativeLibrary = null;
      if (!allowStub) {
        throw new Error("bunite native runtime failed to initialize.");
      }
    }
  }

  if (!nativeLibrary) {
    log.warn("Native runtime packages were not found or could not be loaded. Initializing in stub mode.");
  }

  state = {
    initialized: true,
    usingStub: !nativeLibrary,
    nativeLoaded: Boolean(nativeLibrary),
    artifacts
  };
  return state;
}

export function getNativeRuntimeState(): NativeRuntimeState | null {
  return state;
}

export function ensureNativeRuntime(): NativeRuntimeState {
  if (!state) {
    throw new Error("bunite app has not been initialized. Call await app.init() first.");
  }
  return state;
}

export function getNativeLibrary(): LoadedNativeLibrary | null {
  return nativeLibrary;
}

export function setNativeLogLevel(level: number): void {
  nativeLibrary?.symbols.bunite_set_log_level(level);
}

export function completePermissionRequest(requestId: number, stateValue: number): void {
  nativeLibrary?.symbols.bunite_complete_permission_request(requestId, stateValue);
}

export function showNativeMessageBox(params: {
  type?: string;
  title?: string;
  message?: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
}): number {
  const native = getNativeLibrary();
  if (!native) {
    return params.cancelId ?? params.defaultId ?? 0;
  }

  return native.symbols.bunite_show_message_box(
    toCString(params.type ?? "info"),
    toCString(params.title ?? ""),
    toCString(params.message ?? ""),
    toCString(params.detail ?? ""),
    toCString((params.buttons ?? ["OK"]).join(messageBoxButtonSeparator)),
    params.defaultId ?? 0,
    params.cancelId ?? unsetCancelId
  );
}

export function requestBrowserMessageBox(params: {
  type?: string;
  title?: string;
  message?: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
}): number {
  const native = getNativeLibrary();
  if (!native) {
    return 0;
  }

  return native.symbols.bunite_show_browser_message_box(
    toCString(params.type ?? "info"),
    toCString(params.title ?? ""),
    toCString(params.message ?? ""),
    toCString(params.detail ?? ""),
    toCString((params.buttons ?? ["OK"]).join(messageBoxButtonSeparator)),
    params.defaultId ?? 0,
    params.cancelId ?? unsetCancelId
  );
}

export function cancelBrowserMessageBoxRequest(requestId: number): void {
  getNativeLibrary()?.symbols.bunite_cancel_browser_message_box(requestId);
}
