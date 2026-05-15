import { isAbsolute, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { getBaseDir } from "../../shared/paths";
import { BuniteEvent } from "../events/event";
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
} from "../proc/native";
import { ensureRpcServer } from "./Socket";
import { BrowserWindow } from "./BrowserWindow";
import { createSurfaceCapImpl } from "./SurfaceManager";
import "./SurfaceBrowserIPC";
import { log, logLevelToInt } from "../../shared/log";
import { RuntimeCap, SurfaceCap, type ImplOf } from "../../shared/rpc/index";

import type { LogLevel } from "../../shared/log";

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
  private stubKeepAliveTimer: ReturnType<typeof setInterval> | null = null;
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

    const runtime = await initNativeRuntime({
      allowStub: options.allowStub,
      hideConsole: options.hideConsole,
      popupBlocking: options.popupBlocking,
      engineFlags: options.engineFlags
    });

    if (options.logLevel && runtime.nativeLoaded) {
      setNativeLogLevel(logLevelToInt(options.logLevel));
    }

    setRouteRequestHandler((requestId, path) => this.handleRouteRequest(requestId, path));

    for (const path of this.appresHandlers.keys()) {
      getNativeLibrary()?.symbols.bunite_register_appres_route(toCString(path));
    }

    if (this.exitOnLastWindowClosed && runtime.nativeLoaded) {
      buniteEventEmitter.on("all-windows-closed", () => {
        if (this.quitting) return;
        queueMicrotask(() => {
          if (this.quitting) return;
          if (BrowserWindow.getAll().length === 0) this.quit();
        });
      });
    }

    buniteEventEmitter.emitEvent(
      new BuniteEvent("ready", {
        usingStub: runtime.usingStub,
        artifacts: runtime.artifacts
      })
    );
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
    const runtime = getNativeRuntimeState();
    if (!runtime?.nativeLoaded) {
      if (!this.stubKeepAliveTimer) {
        log.warn("Running without a native event loop. Keeping the process alive in stub mode.");
        this.stubKeepAliveTimer = setInterval(() => {}, 60_000);
      }
      return;
    }

    const lib = getNativeLibrary();
    lib?.symbols.bunite_run_loop();

    if (process.platform === "darwin" || process.platform === "linux") {
      this.pumpActive = true;
      const pump = () => {
        if (!this.pumpActive) return;
        lib?.symbols.bunite_pump_once();
        setImmediate(pump);
      };
      pump();
    } else if (!this.stubKeepAliveTimer) {
      this.stubKeepAliveTimer = setInterval(() => {}, 60_000);
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
    if (this.stubKeepAliveTimer) {
      clearInterval(this.stubKeepAliveTimer);
      this.stubKeepAliveTimer = null;
    }
    getNativeLibrary()?.symbols.bunite_quit();
    if (_instance === this) _instance = null;
    process.exitCode = code;
    process.exit(code);
  }

  createViewRuntime(viewId: number): ImplOf<typeof RuntimeCap> {
    const notImpl = (name: string) => () => {
      throw new Error(`Runtime.${name} not implemented in this build`);
    };
    void RuntimeCap;
    return {
      window: notImpl("window") as never,
      dialogs: notImpl("dialogs") as never,
      clipboard: notImpl("clipboard") as never,
      shell: notImpl("shell") as never,
      appName: () => "bunite-app",
      appVersion: () => this.version,
      theme: () => "light",
      themeWatch: notImpl("themeWatch") as never,
      surface: (_, ctx) => ctx.exportCap(SurfaceCap, createSurfaceCapImpl(viewId)),
    };
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
