import { BuniteEvent } from "../events/event";
import { buniteEventEmitter } from "../events/eventEmitter";
import { ensureNativeRuntime, getNativeLibrary, toCString } from "../proc/native";
import { BrowserView, type BrowserViewOptions } from "./BrowserView";
import type { RPCWithTransport } from "../../shared/rpc";
import { getNextWindowId } from "./windowIds";
import { resolveDefaultAppResRoot } from "../../shared/paths";

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
  appresRoot: string | null;
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
  appresRoot: null,
  titleBarStyle: "default",
  transparent: false,
  hidden: false,
  navigationRules: null,
  sandbox: false
};

const BrowserWindowMap: Record<number, BrowserWindow<any>> = {};

export class BrowserWindow<T extends RPCWithTransport = RPCWithTransport> {
  id = getNextWindowId();
  private nativeAttached = false;
  title: string;
  frame: WindowOptionsType["frame"];
  url: string | null;
  html: string | null;
  preload: string | null;
  appresRoot: string | null;
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
    this.nativeAttached = false;
    BrowserView.getById(this.webviewId)?.detachFromNative();
    delete BrowserWindowMap[this.id];
    buniteEventEmitter.off(`move-${this.id}`, this.handleNativeMove);
    buniteEventEmitter.off(`resize-${this.id}`, this.handleNativeResize);
    buniteEventEmitter.off(`close-${this.id}`, this.handleNativeClose);
    buniteEventEmitter.removeAllListeners(`close-requested-${this.id}`);
  };

  constructor(options: Partial<WindowOptionsType<T>> = {}) {
    ensureNativeRuntime();

    this.title = options.title ?? defaultOptions.title;
    this.frame = { ...defaultOptions.frame, ...options.frame };
    this.url = options.url ?? defaultOptions.url;
    this.html = options.html ?? defaultOptions.html;
    this.preload = options.preload ?? defaultOptions.preload;
    this.appresRoot = options.appresRoot ?? defaultOptions.appresRoot ?? resolveDefaultAppResRoot();
    this.titleBarStyle = options.titleBarStyle ?? defaultOptions.titleBarStyle;
    this.transparent = options.transparent ?? defaultOptions.transparent;
    this.hidden = options.hidden ?? defaultOptions.hidden!;
    this.navigationRules = options.navigationRules ?? defaultOptions.navigationRules;
    this.sandbox = options.sandbox ?? defaultOptions.sandbox;

    const native = getNativeLibrary();
    this.nativeAttached =
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
      ) ?? false;

    BrowserWindowMap[this.id] = this;
    buniteEventEmitter.on(`move-${this.id}`, this.handleNativeMove);
    buniteEventEmitter.on(`resize-${this.id}`, this.handleNativeResize);
    buniteEventEmitter.on(`close-${this.id}`, this.handleNativeClose);

    const webview = new BrowserView({
      url: this.url,
      html: this.html,
      preload: this.preload,
      appresRoot: this.appresRoot,
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

  static getAll() {
    return Object.values(BrowserWindowMap);
  }

  get webview() {
    return BrowserView.getById(this.webviewId) as BrowserView<T>;
  }

  show() {
    this.hidden = false;
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_window_show(this.id);
    }
  }

  close() {
    if (this.closed) {
      return;
    }
    if (this.nativeAttached) {
      // Triggers WM_CLOSE → "close-requested" event → vetoable
      getNativeLibrary()?.symbols.bunite_window_close(this.id);
    } else {
      this.destroy();
    }
  }

  destroy() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    BrowserView.getById(this.webviewId)?.detachFromNative();
    const hadNative = this.nativeAttached;
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_window_destroy(this.id);
      this.nativeAttached = false;
    }
    delete BrowserWindowMap[this.id];
    buniteEventEmitter.off(`move-${this.id}`, this.handleNativeMove);
    buniteEventEmitter.off(`resize-${this.id}`, this.handleNativeResize);
    buniteEventEmitter.off(`close-${this.id}`, this.handleNativeClose);
    buniteEventEmitter.removeAllListeners(`close-requested-${this.id}`);
    if (!hadNative) {
      buniteEventEmitter.emitEvent(buniteEventEmitter.events.window.close({ id: this.id }), this.id);
    }
  }

  maximize() {
    if (!this.nativeAttached) {
      this.frame.maximized = true;
      this.frame.minimized = false;
      return;
    }

    const native = getNativeLibrary();
    if (!native) {
      return;
    }

    native.symbols.bunite_window_maximize(this.id);
    this.frame.minimized = native.symbols.bunite_window_is_minimized(this.id);
    this.frame.maximized = native.symbols.bunite_window_is_maximized(this.id);
  }

  unmaximize() {
    if (!this.nativeAttached) {
      this.frame.maximized = false;
      return;
    }

    const native = getNativeLibrary();
    if (!native) {
      return;
    }

    native.symbols.bunite_window_unmaximize(this.id);
    this.frame.minimized = native.symbols.bunite_window_is_minimized(this.id);
    this.frame.maximized = native.symbols.bunite_window_is_maximized(this.id);
  }

  isMaximized() {
    if (!this.nativeAttached) {
      return Boolean(this.frame.maximized);
    }

    const maximized = getNativeLibrary()?.symbols.bunite_window_is_maximized(this.id) ?? false;
    this.frame.maximized = maximized;
    return maximized;
  }

  minimize() {
    if (!this.nativeAttached) {
      this.restoreMaximizedAfterMinimize = Boolean(this.frame.maximized);
      this.frame.minimized = true;
      this.frame.maximized = false;
      return;
    }

    const native = getNativeLibrary();
    if (!native) {
      return;
    }

    native.symbols.bunite_window_minimize(this.id);
    this.frame.minimized = native.symbols.bunite_window_is_minimized(this.id);
    this.frame.maximized = native.symbols.bunite_window_is_maximized(this.id);
  }

  unminimize() {
    if (!this.nativeAttached) {
      this.frame.minimized = false;
      this.frame.maximized = this.restoreMaximizedAfterMinimize;
      this.restoreMaximizedAfterMinimize = false;
      return;
    }

    const native = getNativeLibrary();
    if (!native) {
      return;
    }

    native.symbols.bunite_window_unminimize(this.id);
    this.frame.minimized = native.symbols.bunite_window_is_minimized(this.id);
    this.frame.maximized = native.symbols.bunite_window_is_maximized(this.id);
  }

  isMinimized() {
    if (!this.nativeAttached) {
      return Boolean(this.frame.minimized);
    }

    const minimized = getNativeLibrary()?.symbols.bunite_window_is_minimized(this.id) ?? false;
    this.frame.minimized = minimized;
    return minimized;
  }

  setTitle(title: string) {
    this.title = title;
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_window_set_title(this.id, toCString(title));
    }
  }

  setFrame(x: number, y: number, width: number, height: number) {
    this.frame = { ...this.frame, x, y, width, height };
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_window_set_frame(this.id, x, y, width, height);
    }
  }

  getFrame() {
    return this.frame;
  }

  on(name: "close-requested" | "close" | "focus" | "blur" | "move" | "resize", handler: (event: unknown) => void) {
    const specificName = `${name}-${this.id}`;
    buniteEventEmitter.on(specificName, handler);
    return () => buniteEventEmitter.off(specificName, handler);
  }
}
