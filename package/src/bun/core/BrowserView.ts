import { buildViewPreloadScript } from "../preload/inline";
import { log } from "../../shared/log";
import { buniteEventEmitter } from "../events/eventEmitter";
import { defineBuniteRPC, type BuniteRPCConfig, type BuniteRPCSchema, type RPCWithTransport } from "../../shared/rpc";
import { ensureNativeRuntime, getNativeLibrary, toCString } from "../proc/native";
import { attachBrowserViewRegistry, getRPCPort, sendMessageToView } from "./Socket";
import { randomBytes } from "node:crypto";
import { resolveDefaultViewsRoot } from "../../shared/paths";

const BrowserViewMap: Record<number, BrowserView<any>> = {};
let nextWebviewId = 1;

export type BrowserViewOptions<T = undefined> = {
  url: string | null;
  html: string | null;
  preload: string | null;
  viewsRoot: string | null;
  partition: string | null;
  frame: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  rpc?: T;
  windowId: number;
  autoResize: boolean;
  navigationRules: string[] | null;
  sandbox: boolean;
};

const defaultOptions: BrowserViewOptions = {
  url: null,
  html: null,
  preload: null,
  viewsRoot: null,
  partition: null,
  frame: {
    x: 0,
    y: 0,
    width: 800,
    height: 600
  },
  windowId: 0,
  autoResize: true,
  navigationRules: null,
  sandbox: false
};

export class BrowserView<T extends RPCWithTransport = RPCWithTransport> {
  id = nextWebviewId++;
  private nativeAttached = false;
  windowId: number;
  url: string | null;
  html: string | null;
  preload: string | null;
  viewsRoot: string | null;
  partition: string | null;
  frame: BrowserViewOptions["frame"];
  rpc?: T;
  rpcHandler?: (message: unknown) => void;
  autoResize: boolean;
  navigationRules: string[] | null;
  sandbox: boolean;
  secretKey: Uint8Array;

  constructor(options: Partial<BrowserViewOptions<T>>) {
    ensureNativeRuntime();

    this.windowId = options.windowId ?? defaultOptions.windowId;
    this.url = options.url ?? defaultOptions.url;
    this.html = options.html ?? defaultOptions.html;
    this.preload = options.preload ?? defaultOptions.preload;
    this.viewsRoot = options.viewsRoot ?? defaultOptions.viewsRoot ?? resolveDefaultViewsRoot();
    this.partition = options.partition ?? defaultOptions.partition;
    this.frame = options.frame ?? defaultOptions.frame;
    this.rpc = options.rpc;
    this.autoResize = options.autoResize ?? defaultOptions.autoResize;
    this.navigationRules = options.navigationRules ?? defaultOptions.navigationRules;
    this.sandbox = options.sandbox ?? defaultOptions.sandbox;
    this.secretKey = new Uint8Array(randomBytes(32));

    if (this.sandbox) {
      throw new Error("sandboxed BrowserView is not implemented in Bunite Windows Phase 1 yet.");
    }
    if (this.partition) {
      log.warn("BrowserView.partition is not implemented in Bunite Windows Phase 1 yet.");
    }

    const preloadScript = buildViewPreloadScript({
      preload: this.preload,
      viewsRoot: this.viewsRoot,
      webviewId: this.id,
      rpcSocketPort: getRPCPort(),
      secretKey: this.secretKey
    });

    BrowserViewMap[this.id] = this;
    this.rpc?.setTransport(this.createTransport());
    this.nativeAttached =
      getNativeLibrary()?.symbols.bunite_view_create(
        this.id,
        this.windowId,
        toCString(this.url ?? ""),
        toCString(this.html ?? ""),
        toCString(preloadScript),
        toCString(this.viewsRoot ?? ""),
        toCString(this.navigationRules ? JSON.stringify(this.navigationRules) : ""),
        this.frame.x,
        this.frame.y,
        this.frame.width,
        this.frame.height,
        this.autoResize,
        this.sandbox
      ) ?? false;
  }

  static getById(id: number) {
    return BrowserViewMap[id];
  }

  static getAll() {
    return Object.values(BrowserViewMap);
  }

  static defineRPC<Schema extends BuniteRPCSchema>(
    config: BuniteRPCConfig<Schema, "bun">
  ) {
    return defineBuniteRPC("bun", config);
  }

  handleIncomingRPC(message: unknown) {
    this.rpcHandler?.(message);
  }

  createTransport() {
    return {
      send: (message: any) => {
        sendMessageToView(this.id, message);
      },
      registerHandler: (handler: (message: any) => void) => {
        this.rpcHandler = handler;
      },
      unregisterHandler: () => {
        this.rpcHandler = undefined;
      }
    };
  }

  get rpcPort() {
    return getRPCPort();
  }

  setAnchor(mode: "none" | "fill" | "top" | "below-top", inset = 0) {
    const modeInt = { none: 0, fill: 1, top: 2, "below-top": 3 }[mode];
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_view_set_anchor(this.id, modeInt, inset);
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

  setBounds(x: number, y: number, width: number, height: number) {
    this.frame = { x, y, width, height };
    if (this.nativeAttached) {
      getNativeLibrary()?.symbols.bunite_view_set_bounds(this.id, x, y, width, height);
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
    this.nativeAttached = false;
    for (const eventName of [
      "will-navigate",
      "did-navigate",
      "dom-ready",
      "new-window-open",
      "permission-requested",
      "message-box-response"
    ]) {
      buniteEventEmitter.removeAllListeners(`${eventName}-${this.id}`);
    }
    delete BrowserViewMap[this.id];
  }

  on(
    name:
      | "will-navigate"
      | "did-navigate"
      | "dom-ready"
      | "new-window-open"
      | "permission-requested"
      | "message-box-response",
    handler: (event: unknown) => void
  ) {
    const specificName = `${name}-${this.id}`;
    buniteEventEmitter.on(specificName, handler);
    return () => buniteEventEmitter.off(specificName, handler);
  }
}

attachBrowserViewRegistry({
  getById(id) {
    return BrowserView.getById(id);
  }
});
