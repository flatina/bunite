import { isAbsolute, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { getBaseDir } from "../paths";
import { buniteEventEmitter } from "../events/eventEmitter";
import {
  getNativeEngineName,
  getNativeEngineVersion,
  getNativeLibrary,
  initNativeRuntime,
  getNativeRuntimeState,
  setRouteRequestHandler,
  setNativeLogLevel,
  toCString,
  type NativeBootstrapOptions
} from "../native";
import { ensureRpcServer } from "./Socket";
import { BrowserWindow } from "./BrowserWindow";
import { createSurfaceCapImpl, getPopupMetricsSnapshot } from "./SurfaceManager";
import { createWindowCapImpl } from "./windowCap";
import "./SurfaceBrowserIPC";
import { log, logLevelToInt } from "../log";
import { RuntimeCap, WindowCap, SurfaceCap, PageReportingCap, IpcError, type ImplOf } from "../../rpc/index";

import type { LogLevel } from "../log";

type AppOptions = NativeBootstrapOptions & {
  userDataDir?: string;
  exitOnLastWindowClosed?: boolean;
  logLevel?: LogLevel;
};

let _instance: AppRuntime | null = null;
export function getAppRuntimeOrThrow(): AppRuntime {
  if (!_instance) throw new Error("AppRuntime not yet instantiated");
  return _instance;
}

function normalizeAppResPath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

export class AppRuntime {
  private exitOnLastWindowClosed = true;
  private quitting = false;
  private pumpActive = false;

  readonly ready: Promise<void>;

  constructor(options: AppOptions = {}) {
    if (_instance) throw new Error("AppRuntime already instantiated");
    _instance = this;
    ensureRpcServer();
    this.ready = this.bootstrap(options);
    this.ready.catch(() => { if (_instance === this) _instance = null; });
  }

  private async bootstrap(options: AppOptions) {
    if (options.exitOnLastWindowClosed !== undefined) {
      this.exitOnLastWindowClosed = options.exitOnLastWindowClosed;
    }

    if (options.logLevel) {
      log.setLevel(options.logLevel);
    }

    if (options.userDataDir) {
      process.env.BUNITE_USER_DATA_DIR = options.userDataDir;
    } else if (!process.env.BUNITE_USER_DATA_DIR) {
      const appDataDir = process.env.XDG_DATA_HOME
        ?? (process.platform === "win32"
          ? (process.env.APPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Roaming"))
          : process.platform === "darwin"
            ? join(process.env.HOME ?? "", "Library", "Application Support")
            : join(process.env.HOME ?? "", ".local", "share"));
      let name = "bunite-app";
      try {
        let dir = getBaseDir();
        while (dir) {
          const pkgPath = join(dir, "package.json");
          if (existsSync(pkgPath)) {
            name = JSON.parse(require("node:fs").readFileSync(pkgPath, "utf8")).name ?? name;
            break;
          }
          const parent = resolve(dir, "..");
          if (parent === dir) break;
          dir = parent;
        }
      } catch {}
      process.env.BUNITE_USER_DATA_DIR = join(appDataDir, name);
    }

    const envEngine = process.env.BUNITE_ENGINE;
    const engineFromEnv = envEngine === "cef" || envEngine === "webview2"
      ? envEngine
      : undefined;

    await initNativeRuntime({
      hideConsole: options.hideConsole,
      popupBlocking: options.popupBlocking,
      engine: options.engine ?? engineFromEnv,
      engineFlags: options.engineFlags
    });

    if (options.logLevel) {
      setNativeLogLevel(logLevelToInt(options.logLevel));
    }

    setRouteRequestHandler((requestId, path) => this.handleRouteRequest(requestId, path));

    for (const path of this.appresHandlers.keys()) {
      getNativeLibrary()?.symbols.bunite_register_appres_route(toCString(path));
    }

    if (this.exitOnLastWindowClosed) {
      buniteEventEmitter.on("all-windows-closed", () => {
        if (this.quitting) return;
        queueMicrotask(() => {
          if (this.quitting) return;
          if (BrowserWindow.getAll().length === 0) this.quit();
        });
      });
    }
  }

  on(name: string, handler: (payload: unknown) => void) {
    if (name === "before-quit") {
      buniteEventEmitter.on(name, handler);
      return () => buniteEventEmitter.off(name, handler);
    }
    const wrapped = (event: { data: unknown }) => handler(event.data);
    buniteEventEmitter.on(name, wrapped);
    return () => buniteEventEmitter.off(name, wrapped);
  }

  run() {
    if (!getNativeRuntimeState()) {
      throw new Error("AppRuntime.run() called before await app.ready completed");
    }
    const lib = getNativeLibrary();
    // CEF: bunite_run_loop blocks here. WebView2 / mac / linux: returns immediately
    // (cooperative pump kicks in below).
    lib?.symbols.bunite_run_loop();

    const engine = getNativeEngineName();
    const cooperative =
      process.platform === "darwin" ||
      process.platform === "linux" ||
      (process.platform === "win32" && engine !== "cef");

    if (cooperative) {
      this.pumpActive = true;
      const pump = () => {
        if (!this.pumpActive) return;
        lib?.symbols.bunite_pump_once();
        setImmediate(pump);
      };
      pump();
    }
  }

  quit(code = 0) {
    if (this.quitting) return;
    this.quitting = true;

    const event = buniteEventEmitter.events.app.beforeQuit({});
    buniteEventEmitter.emitEvent(event);
    if (event.responseWasSet && event.response?.allow === false) {
      this.quitting = false;
      return;
    }
    this.pumpActive = false;
    getNativeLibrary()?.symbols.bunite_quit();
    if (_instance === this) _instance = null;
    process.exitCode = code;
    process.exit(code);
  }

  createViewRuntime(viewId: number): ImplOf<typeof RuntimeCap> {
    const notImpl = (name: string) => {
      throw new IpcError({ code: "not_found", message: `Runtime.${name}` });
    };
    const impl = {
      window: (_: void, ctx: Parameters<ImplOf<typeof RuntimeCap>["window"]>[1]) =>
        ctx.exportCap(WindowCap, createWindowCapImpl(viewId)),
      dialogs: () => notImpl("dialogs"),
      clipboard: () => notImpl("clipboard"),
      shell: () => notImpl("shell"),
      appName: () => "bunite-app",
      appVersion: () => this.version,
      theme: (): "light" | "dark" => "light",
      themeWatch: () => notImpl("themeWatch"),
      surface: (_: void, ctx: Parameters<ImplOf<typeof RuntimeCap>["surface"]>[1]) =>
        ctx.exportCap(SurfaceCap, createSurfaceCapImpl(viewId)),
      reporting: (_: void, ctx: Parameters<ImplOf<typeof RuntimeCap>["reporting"]>[1]) =>
        ctx.exportCap(PageReportingCap, {
          reportConsoleBatch: ({ entries }) => {
            // One queueMicrotask per batch (not per entry) — a 1000-log
            // spam still translates to 1 microtask + N synchronous emits,
            // not N microtasks competing for the queue.
            queueMicrotask(() => {
              for (const entry of entries) {
                buniteEventEmitter.emitEvent(
                  buniteEventEmitter.events.webview.consoleMessage(entry),
                  viewId
                );
              }
            });
          },
        }),
      popupMetrics: () => getPopupMetricsSnapshot(),
    } satisfies ImplOf<typeof RuntimeCap>;
    return impl;
  }

  private readonly appresHandlers = new Map<string, () => string>();

  getAppRes(path: string, handler: () => string) {
    const normalized = normalizeAppResPath(path);
    this.appresHandlers.set(normalized, handler);
    getNativeLibrary()?.symbols.bunite_register_appres_route(toCString(normalized));
  }

  removeAppRes(path: string) {
    const normalized = normalizeAppResPath(path);
    this.appresHandlers.delete(normalized);
    getNativeLibrary()?.symbols.bunite_unregister_appres_route(toCString(normalized));
  }

  /** @internal */
  handleRouteRequest(requestId: number, path: string) {
    let html: string;
    try {
      const handler = this.appresHandlers.get(path);
      html = handler ? handler() : "<html><body>No handler for: " + path + "</body></html>";
    } catch (error) {
      html = "<html><body>Route handler error: " + (error instanceof Error ? error.message : String(error)) + "</body></html>";
    }
    getNativeLibrary()?.symbols.bunite_complete_route_request(requestId, toCString(html));
  }

  resolve(relativePath: string): string {
    if (isAbsolute(relativePath)) return relativePath;
    return resolve(getBaseDir(), relativePath);
  }

  get runtime() {
    return getNativeRuntimeState();
  }

  get version(): string {
    try {
      const { createRequire } = require("node:module");
      const req = createRequire(import.meta.url);
      const pkg = req("bunite-core/package.json");
      return pkg.version ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  private cachedEngineName: string | null | undefined;
  private cachedEngineVersion: string | null | undefined;

  get engineName(): string | null {
    if (this.cachedEngineName !== undefined) return this.cachedEngineName;
    this.cachedEngineName = getNativeEngineName();
    return this.cachedEngineName;
  }

  get engineVersion(): string | null {
    if (this.cachedEngineVersion !== undefined) return this.cachedEngineVersion;
    this.cachedEngineVersion = getNativeEngineVersion();
    return this.cachedEngineVersion;
  }
}
