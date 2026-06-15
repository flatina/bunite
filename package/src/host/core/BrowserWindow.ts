import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Connection } from "../../rpc/index";
import { buniteEventEmitter } from "../events/eventEmitter";
import { ensureNativeRuntime, getNativeLibrary, toCString } from "../native";
import { getBaseDir, resolveDefaultAppResRoot } from "../paths";
import { BrowserView } from "./BrowserView";
import { getNextWindowId } from "./windowIds";

export type WindowOptionsType = {
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
  preloadOrigins?: string[];
  label?: string;
  /** Setup callback fired when the window's renderer connection attaches. */
  serve?: (conn: Connection) => void;
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
    height: 900,
  },
  url: null,
  html: null,
  preload: null,
  appresRoot: null,
  preloadOrigins: undefined,
  titleBarStyle: "default",
  transparent: false,
  hidden: false,
  navigationRules: null,
  sandbox: false,
};

const BrowserWindowMap: Record<number, BrowserWindow> = {};

let lastFocusedWindowId: number | null = null;

export function getLastFocusedWindowId(): number | null {
  return lastFocusedWindowId;
}

export class BrowserWindow {
  id = getNextWindowId();
  private nativeAttached = false;
  title: string;
  label = "";
  frame: WindowOptionsType["frame"];
  url: string | null;
  html: string | null;
  preload: string | null;
  appresRoot: string | null;
  preloadOrigins?: string[];
  titleBarStyle: WindowOptionsType["titleBarStyle"];
  transparent: boolean;
  hidden: boolean;
  navigationRules: string[] | null;
  sandbox: boolean;
  webviewId: number;
  private closed = false;
  private restoreMaximizedAfterMinimize = false;
  private _focused = false;
  private readonly handleNativeFocus = () => {
    lastFocusedWindowId = this.id;
    this._focused = true;
  };
  private readonly handleNativeBlur = () => {
    this._focused = false;
  };
  private readonly handleNativeMove = (event: unknown) => {
    const data = (
      event as {
        data?: { x?: number; y?: number; maximized?: boolean; minimized?: boolean };
      }
    ).data;
    if (!data) {
      return;
    }

    this.frame = {
      ...this.frame,
      x: data.x ?? this.frame.x,
      y: data.y ?? this.frame.y,
      maximized: data.maximized ?? this.frame.maximized,
      minimized: data.minimized ?? this.frame.minimized,
    };
  };
  private readonly handleNativeResize = (event: unknown) => {
    const data = (
      event as {
        data?: {
          x?: number;
          y?: number;
          width?: number;
          height?: number;
          maximized?: boolean;
          minimized?: boolean;
        };
      }
    ).data;
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
      minimized: data.minimized ?? this.frame.minimized,
    };
  };
  private readonly handleNativeClose = () => {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.nativeAttached = false;
    if (lastFocusedWindowId === this.id) {
      lastFocusedWindowId = null;
    }
    BrowserView.getById(this.webviewId)?.detachFromNative();
    delete BrowserWindowMap[this.id];
    buniteEventEmitter.off(`focus-${this.id}`, this.handleNativeFocus);
    buniteEventEmitter.off(`blur-${this.id}`, this.handleNativeBlur);
    buniteEventEmitter.off(`move-${this.id}`, this.handleNativeMove);
    buniteEventEmitter.off(`resize-${this.id}`, this.handleNativeResize);
    buniteEventEmitter.off(`close-${this.id}`, this.handleNativeClose);
    buniteEventEmitter.removeAllListeners(`close-requested-${this.id}`);
  };

  constructor(options: Partial<WindowOptionsType> = {}) {
    ensureNativeRuntime();

    this.title = options.title ?? defaultOptions.title;
    this.label = options.label ?? "";
    this.frame = { ...defaultOptions.frame, ...options.frame };
    this.html = options.html ?? defaultOptions.html;
    this.preload = options.preload ?? defaultOptions.preload;
    this.preloadOrigins = options.preloadOrigins ?? defaultOptions.preloadOrigins;

    const baseDir = getBaseDir();

    let url = options.url ?? defaultOptions.url;
    let appresRoot = options.appresRoot ?? defaultOptions.appresRoot;
    if (appresRoot && !isAbsolute(appresRoot)) {
      appresRoot = resolve(baseDir, appresRoot);
    }
    if (url && !url.includes("://")) {
      const resolved = isAbsolute(url) ? url : resolve(baseDir, url);
      if (!appresRoot) {
        appresRoot = dirname(resolved);
      }
      const rel = relative(appresRoot!, resolved).replaceAll(sep, "/");
      url = `appres://app.internal/${rel}`;
    }
    this.url = url;
    this.appresRoot = appresRoot ?? resolveDefaultAppResRoot();
    this.titleBarStyle = options.titleBarStyle ?? defaultOptions.titleBarStyle;
    this.transparent = options.transparent ?? defaultOptions.transparent;
    this.hidden = options.hidden ?? defaultOptions.hidden!;
    this.navigationRules = options.navigationRules ?? defaultOptions.navigationRules;
    this.sandbox = options.sandbox ?? defaultOptions.sandbox;

    // Register before native create — create shows the window and the initial
    // WM_ACTIVATE fires synchronously, so listeners must be in place first.
    BrowserWindowMap[this.id] = this;
    buniteEventEmitter.on(`focus-${this.id}`, this.handleNativeFocus);
    buniteEventEmitter.on(`blur-${this.id}`, this.handleNativeBlur);
    buniteEventEmitter.on(`move-${this.id}`, this.handleNativeMove);
    buniteEventEmitter.on(`resize-${this.id}`, this.handleNativeResize);
    buniteEventEmitter.on(`close-${this.id}`, this.handleNativeClose);

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
        Boolean(this.frame.maximized),
      ) ?? false;
    if (!this.nativeAttached) {
      console.error(
        `[bunite] bunite_window_create returned false for window ${this.id} — ` +
          `window will be unusable. Check native log (BUNITE_LOG_LEVEL=info).`,
      );
    }

    const webview = new BrowserView({
      url: this.url,
      html: this.html,
      preload: this.preload,
      appresRoot: this.appresRoot,
      preloadOrigins: this.preloadOrigins,
      frame: {
        x: 0,
        y: 0,
        width: this.frame.width,
        height: this.frame.height,
      },
      serve: options.serve,
      windowId: this.id,
      navigationRules: this.navigationRules,
      sandbox: this.sandbox,
    });

    this.webviewId = webview.id;
  }

  get view(): BrowserView {
    const view = BrowserView.getById(this.webviewId);
    if (!view) throw new Error(`BrowserWindow ${this.id} has no attached view`);
    return view as BrowserView;
  }

  static getById(id: number) {
    return BrowserWindowMap[id];
  }

  static getAll() {
    return Object.values(BrowserWindowMap);
  }

  /** The window owning a given view id — its main webview, or a surface view
   *  whose `windowId` points back to the window. */
  static getByWebviewId(viewId: number) {
    const direct = Object.values(BrowserWindowMap).find((w) => w.webviewId === viewId);
    if (direct) return direct;
    const view = BrowserView.getById(viewId) as { windowId?: number } | undefined;
    return view?.windowId != null ? BrowserWindowMap[view.windowId] : undefined;
  }

  get webview(): BrowserView | undefined {
    return BrowserView.getById(this.webviewId) as BrowserView | undefined;
  }

  show() {
    this.hidden = false;
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_window_show(this.id);
    }
  }

  /** Best-effort — no native focus FFI yet; show() brings the window up. */
  focus() {
    this.show();
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
    buniteEventEmitter.off(`focus-${this.id}`, this.handleNativeFocus);
    buniteEventEmitter.off(`blur-${this.id}`, this.handleNativeBlur);
    buniteEventEmitter.off(`move-${this.id}`, this.handleNativeMove);
    buniteEventEmitter.off(`resize-${this.id}`, this.handleNativeResize);
    buniteEventEmitter.off(`close-${this.id}`, this.handleNativeClose);
    buniteEventEmitter.removeAllListeners(`close-requested-${this.id}`);
    if (!hadNative) {
      buniteEventEmitter.emitEvent(
        buniteEventEmitter.events.window.close({ id: this.id }),
        this.id,
      );
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

  isFocused() {
    return this._focused;
  }

  toggleMaximize() {
    if (this.isMaximized()) this.unmaximize();
    else this.maximize();
  }

  getState() {
    return { maximized: this.isMaximized(), minimized: this.isMinimized(), focused: this._focused };
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

  /** Start an OS-driven window move drag. Call from a renderer mousedown on a
   *  custom titlebar region; the OS tracks the drag through mouse-up. */
  beginMoveDrag() {
    if (!this.nativeAttached) return;
    getNativeLibrary()?.symbols.bunite_window_begin_move_drag(this.id);
  }

  on(
    name: "close-requested" | "close" | "focus" | "blur" | "move" | "resize",
    handler: (event: unknown) => void,
  ) {
    const specificName = `${name}-${this.id}`;
    buniteEventEmitter.on(specificName, handler);
    return () => buniteEventEmitter.off(specificName, handler);
  }
}
