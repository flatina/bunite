import type { Pointer } from "bun:ffi";
import { BuniteEvent } from "../events/event";
import { buniteEventEmitter } from "../events/eventEmitter";
import { ensureNativeRuntime, getNativeLibrary, toCString } from "../proc/native";
import { BrowserView, type BrowserViewOptions } from "./BrowserView";
import type { RPCWithTransport } from "../../shared/rpc";
import { getNextWindowId } from "./windowIds";
import { resolveDefaultViewsRoot } from "../../shared/paths";

export type WindowOptionsType<T = undefined> = {
  title: string;
  frame: {
    x: number;
    y: number;
    width: number;
    height: number;
    maximized?: boolean;
    minimized?: boolean;
  };
  url: string | null;
  html: string | null;
  preload: string | null;
  viewsRoot: string | null;
  rpc?: T;
  titleBarStyle: "hidden" | "hiddenInset" | "default";
  transparent: boolean;
  hidden?: boolean;
  navigationRules: string[] | null;
  sandbox: boolean;
};

const defaultOptions: WindowOptionsType = {
  title: "bunite",
  frame: {
    x: 80,
    y: 80,
    width: 1280,
    height: 900
  },
  url: null,
  html: null,
  preload: null,
  viewsRoot: null,
  titleBarStyle: "default",
  transparent: false,
  hidden: false,
  navigationRules: null,
  sandbox: false
};

const BrowserWindowMap: Record<number, BrowserWindow<any>> = {};

export class BrowserWindow<T extends RPCWithTransport = RPCWithTransport> {
  id = getNextWindowId();
  ptr: Pointer | null = null;
  title: string;
  frame: WindowOptionsType["frame"];
  url: string | null;
  html: string | null;
  preload: string | null;
  viewsRoot: string | null;
  titleBarStyle: WindowOptionsType["titleBarStyle"];
  transparent: boolean;
  hidden: boolean;
  navigationRules: string[] | null;
  sandbox: boolean;
  webviewId: number;
  private closed = false;
  private restoreMaximizedAfterMinimize = false;
  private readonly handleNativeMove = (event: unknown) => {
    const data = (event as {
      data?: { x?: number; y?: number; maximized?: boolean; minimized?: boolean };
    }).data;
    if (!data) {
      return;
    }

    this.frame = {
      ...this.frame,
      x: data.x ?? this.frame.x,
      y: data.y ?? this.frame.y,
      maximized: data.maximized ?? this.frame.maximized,
      minimized: data.minimized ?? this.frame.minimized
    };
  };
  private readonly handleNativeResize = (event: unknown) => {
    const data = (event as {
      data?: { x?: number; y?: number; width?: number; height?: number; maximized?: boolean; minimized?: boolean };
    }).data;
    if (!data) {
      return;
    }

    this.frame = {
      ...this.frame,
      x: data.x ?? this.frame.x,
      y: data.y ?? this.frame.y,
      width: data.width ?? this.frame.width,
      height: data.height ?? this.frame.height,
      maximized: data.maximized ?? this.frame.maximized,
      minimized: data.minimized ?? this.frame.minimized
    };
  };
  private readonly handleNativeClose = () => {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.ptr = null;
    BrowserView.getById(this.webviewId)?.detachFromNative();
    delete BrowserWindowMap[this.id];
    buniteEventEmitter.off(`move-${this.id}`, this.handleNativeMove);
    buniteEventEmitter.off(`resize-${this.id}`, this.handleNativeResize);
    buniteEventEmitter.off(`close-${this.id}`, this.handleNativeClose);
  };

  constructor(options: Partial<WindowOptionsType<T>> = {}) {
    ensureNativeRuntime();

    this.title = options.title ?? defaultOptions.title;
    this.frame = { ...defaultOptions.frame, ...options.frame };
    this.url = options.url ?? defaultOptions.url;
    this.html = options.html ?? defaultOptions.html;
    this.preload = options.preload ?? defaultOptions.preload;
    this.viewsRoot = options.viewsRoot ?? defaultOptions.viewsRoot ?? resolveDefaultViewsRoot();
    this.titleBarStyle = options.titleBarStyle ?? defaultOptions.titleBarStyle;
    this.transparent = options.transparent ?? defaultOptions.transparent;
    this.hidden = options.hidden ?? defaultOptions.hidden!;
    this.navigationRules = options.navigationRules ?? defaultOptions.navigationRules;
    this.sandbox = options.sandbox ?? defaultOptions.sandbox;

    const native = getNativeLibrary();
    this.ptr =
      native?.symbols.bunite_window_create(
        this.id,
        this.frame.x,
        this.frame.y,
        this.frame.width,
        this.frame.height,
        toCString(this.title),
        toCString(this.titleBarStyle),
        this.transparent,
        this.hidden,
        Boolean(this.frame.minimized),
        Boolean(this.frame.maximized)
      ) ?? null;

    BrowserWindowMap[this.id] = this;
    buniteEventEmitter.on(`move-${this.id}`, this.handleNativeMove);
    buniteEventEmitter.on(`resize-${this.id}`, this.handleNativeResize);
    buniteEventEmitter.on(`close-${this.id}`, this.handleNativeClose);

    const webview = new BrowserView({
      url: this.url,
      html: this.html,
      preload: this.preload,
      viewsRoot: this.viewsRoot,
      windowPtr: this.ptr,
      frame: {
        x: 0,
        y: 0,
        width: this.frame.width,
        height: this.frame.height
      },
      rpc: options.rpc as BrowserViewOptions<T>["rpc"],
      windowId: this.id,
      navigationRules: this.navigationRules,
      sandbox: this.sandbox
    });

    this.webviewId = webview.id;
  }

  static getById(id: number) {
    return BrowserWindowMap[id];
  }

  get webview() {
    return BrowserView.getById(this.webviewId) as BrowserView<T>;
  }

  show() {
    this.hidden = false;
    if (this.ptr) {
      getNativeLibrary()?.symbols.bunite_window_show(this.ptr);
    }
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const hadNativePtr = Boolean(this.ptr);
    if (this.ptr) {
      getNativeLibrary()?.symbols.bunite_window_close(this.ptr);
      this.ptr = null;
    } else {
      BrowserView.getById(this.webviewId)?.remove();
    }
    delete BrowserWindowMap[this.id];
    buniteEventEmitter.off(`move-${this.id}`, this.handleNativeMove);
    buniteEventEmitter.off(`resize-${this.id}`, this.handleNativeResize);
    buniteEventEmitter.off(`close-${this.id}`, this.handleNativeClose);
    if (!hadNativePtr) {
      buniteEventEmitter.emitEvent(buniteEventEmitter.events.window.close({ id: this.id }), this.id);
    }
  }

  maximize() {
    if (!this.ptr) {
      this.frame.maximized = true;
      this.frame.minimized = false;
      return;
    }

    const native = getNativeLibrary();
    if (!native) {
      return;
    }

    native.symbols.bunite_window_maximize(this.ptr);
    this.frame.minimized = native.symbols.bunite_window_is_minimized(this.ptr);
    this.frame.maximized = native.symbols.bunite_window_is_maximized(this.ptr);
  }

  unmaximize() {
    if (!this.ptr) {
      this.frame.maximized = false;
      return;
    }

    const native = getNativeLibrary();
    if (!native) {
      return;
    }

    native.symbols.bunite_window_unmaximize(this.ptr);
    this.frame.minimized = native.symbols.bunite_window_is_minimized(this.ptr);
    this.frame.maximized = native.symbols.bunite_window_is_maximized(this.ptr);
  }

  isMaximized() {
    if (!this.ptr) {
      return Boolean(this.frame.maximized);
    }

    const maximized = getNativeLibrary()?.symbols.bunite_window_is_maximized(this.ptr) ?? false;
    this.frame.maximized = maximized;
    return maximized;
  }

  minimize() {
    if (!this.ptr) {
      this.restoreMaximizedAfterMinimize = Boolean(this.frame.maximized);
      this.frame.minimized = true;
      this.frame.maximized = false;
      return;
    }

    const native = getNativeLibrary();
    if (!native) {
      return;
    }

    native.symbols.bunite_window_minimize(this.ptr);
    this.frame.minimized = native.symbols.bunite_window_is_minimized(this.ptr);
    this.frame.maximized = native.symbols.bunite_window_is_maximized(this.ptr);
  }

  unminimize() {
    if (!this.ptr) {
      this.frame.minimized = false;
      this.frame.maximized = this.restoreMaximizedAfterMinimize;
      this.restoreMaximizedAfterMinimize = false;
      return;
    }

    const native = getNativeLibrary();
    if (!native) {
      return;
    }

    native.symbols.bunite_window_unminimize(this.ptr);
    this.frame.minimized = native.symbols.bunite_window_is_minimized(this.ptr);
    this.frame.maximized = native.symbols.bunite_window_is_maximized(this.ptr);
  }

  isMinimized() {
    if (!this.ptr) {
      return Boolean(this.frame.minimized);
    }

    const minimized = getNativeLibrary()?.symbols.bunite_window_is_minimized(this.ptr) ?? false;
    this.frame.minimized = minimized;
    return minimized;
  }

  setTitle(title: string) {
    this.title = title;
    if (this.ptr) {
      getNativeLibrary()?.symbols.bunite_window_set_title(this.ptr, toCString(title));
    }
  }

  setFrame(x: number, y: number, width: number, height: number) {
    this.frame = { ...this.frame, x, y, width, height };
    if (this.ptr) {
      getNativeLibrary()?.symbols.bunite_window_set_frame(this.ptr, x, y, width, height);
    }
  }

  getFrame() {
    return this.frame;
  }

  on(name: "close" | "focus" | "blur" | "move" | "resize", handler: (event: unknown) => void) {
    const specificName = `${name}-${this.id}`;
    buniteEventEmitter.on(specificName, handler);
    return () => buniteEventEmitter.off(specificName, handler);
  }
}
