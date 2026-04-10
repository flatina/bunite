import { join } from "node:path";
import { existsSync } from "node:fs";
import { dlopen, FFIType } from "bun:ffi";
import { BuniteEvent } from "../events/event";
import { buniteEventEmitter } from "../events/eventEmitter";
import { handleMessageBoxResponse } from "./Utils";
import {
  getNativeLibrary,
  initNativeRuntime,
  getNativeRuntimeState,
  setRouteRequestHandler,
  setNativeLogLevel,
  toCString,
  type NativeBootstrapOptions
} from "../proc/native";
import { attachGlobalIPCResolver, ensureRPCServer } from "./Socket";
import { BrowserWindow } from "./BrowserWindow";
import { getSurfaceIPCHandlers } from "./SurfaceManager";
import { getWebviewIPCHandlers } from "./SurfaceBrowserIPC";
import { log, logLevelToInt } from "../../shared/log";

import type { LogLevel } from "../../shared/log";

type AppInitOptions = NativeBootstrapOptions & {
  userDataDir?: string;
  exitOnLastWindowClosed?: boolean;
  logLevel?: LogLevel;
};

export type GlobalIPCHandler = (params: unknown, ctx: { viewId: number }) => unknown | Promise<unknown>;

class AppRuntime {
  private initPromise: Promise<void> | null = null;
  private stubKeepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private readonly globalIPCHandlers = new Map<string, GlobalIPCHandler>();
  private exitOnLastWindowClosed = true;
  private quitting = false;

  async init(options: AppInitOptions = {}) {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        if (options.exitOnLastWindowClosed !== undefined) {
          this.exitOnLastWindowClosed = options.exitOnLastWindowClosed;
        }

        if (options.logLevel) {
          log.setLevel(options.logLevel);
        }

        if (options.userDataDir) {
          process.env.BUNITE_USER_DATA_DIR = options.userDataDir;
        } else if (!process.env.BUNITE_USER_DATA_DIR) {
          process.env.BUNITE_USER_DATA_DIR = join(process.cwd(), ".bunite");
        }

        const runtime = await initNativeRuntime({
          allowStub: options.allowStub,
          hideConsole: options.hideConsole,
          popupBlocking: options.popupBlocking,
          chromiumFlags: options.chromiumFlags
        });

        if (options.logLevel && runtime.nativeLoaded) {
          setNativeLogLevel(logLevelToInt(options.logLevel));
        }

        attachGlobalIPCResolver((channel) => this.getGlobalIPCHandler(channel));

        for (const [channel, handler] of getSurfaceIPCHandlers()) {
          this.globalIPCHandlers.set(channel, handler);
        }
        for (const [channel, handler] of getWebviewIPCHandlers()) {
          this.globalIPCHandlers.set(channel, handler);
        }

        this.globalIPCHandlers.set("__bunite:messageBoxResponse", (params) => {
          const { requestId, response } = params as { requestId: number; response: number };
          handleMessageBoxResponse(requestId, response);
          return {};
        });

        setRouteRequestHandler((requestId, path) => this.handleRouteRequest(requestId, path));

        // Replay appres routes registered before init
        for (const path of this.appresHandlers.keys()) {
          getNativeLibrary()?.symbols.bunite_register_appres_route(toCString(path));
        }


        if (this.exitOnLastWindowClosed && runtime.nativeLoaded) {
          buniteEventEmitter.on("all-windows-closed", () => {
            if (this.quitting) {
              return;
            }
            queueMicrotask(() => {
              if (this.quitting) {
                return;
              }
              // Recheck: a new window may have been created since the event
              if (BrowserWindow.getAll().length === 0) {
                this.quit();
              }
            });
          });
        }

        ensureRPCServer();
        buniteEventEmitter.emitEvent(
          new BuniteEvent("ready", {
            usingStub: runtime.usingStub,
            artifacts: runtime.artifacts
          })
        );
      })();
    }

    await this.initPromise;
  }

  on(name: string, handler: (payload: unknown) => void) {
    if (name === "before-quit") {
      // before-quit listeners receive the BuniteEvent directly so they can set event.response
      buniteEventEmitter.on(name, handler);
      return () => buniteEventEmitter.off(name, handler);
    }
    const wrapped = (event: { data: unknown }) => handler(event.data);
    buniteEventEmitter.on(name, wrapped);
    return () => buniteEventEmitter.off(name, wrapped);
  }

  run() {
    const runtime = getNativeRuntimeState();
    if (runtime?.nativeLoaded) {
      getNativeLibrary()?.symbols.bunite_run_loop();
      if (!this.stubKeepAliveTimer) {
        this.stubKeepAliveTimer = setInterval(() => {}, 60_000);
      }
      return;
    }

    if (!this.stubKeepAliveTimer) {
      log.warn("Running without a native event loop. Keeping the process alive in stub mode.");
      this.stubKeepAliveTimer = setInterval(() => {}, 60_000);
    }
  }

  quit(code = 0) {
    if (this.quitting) {
      return;
    }
    this.quitting = true;

    const event = buniteEventEmitter.events.app.beforeQuit({});
    buniteEventEmitter.emitEvent(event);
    if (event.responseWasSet && event.response?.allow === false) {
      this.quitting = false;
      return;
    }
    if (this.stubKeepAliveTimer) {
      clearInterval(this.stubKeepAliveTimer);
      this.stubKeepAliveTimer = null;
    }
    // bunite_quit() blocks until native shutdown completes or times out
    getNativeLibrary()?.symbols.bunite_quit();
    process.exitCode = code;
    process.exit(code);
  }

  handle(channel: string, handler: GlobalIPCHandler) {
    if (channel.startsWith("__bunite:")) {
      throw new Error(`Channel prefix "__bunite:" is reserved: ${channel}`);
    }
    if (this.globalIPCHandlers.has(channel)) {
      throw new Error(`Global IPC handler already registered for: ${channel}`);
    }
    this.globalIPCHandlers.set(channel, handler);
    return () => this.globalIPCHandlers.delete(channel);
  }

  removeHandler(channel: string) {
    this.globalIPCHandlers.delete(channel);
  }

  /** @internal */
  getGlobalIPCHandler(channel: string): GlobalIPCHandler | undefined {
    return this.globalIPCHandlers.get(channel);
  }

  private readonly appresHandlers = new Map<string, () => string>();

  getAppRes(path: string, handler: () => string) {
    this.appresHandlers.set(path, handler);
    getNativeLibrary()?.symbols.bunite_register_appres_route(toCString(path));
  }

  removeAppRes(path: string) {
    this.appresHandlers.delete(path);
    getNativeLibrary()?.symbols.bunite_unregister_appres_route(toCString(path));
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

  get runtime() {
    return getNativeRuntimeState();
  }

  get version(): string {
    const { createRequire } = require("node:module");
    const req = createRequire(import.meta.url);
    const pkg = req("bunite-core/package.json");
    return pkg.version ?? "unknown";
  }

  private cachedCefVersion: string | null | undefined;

  get cefVersion(): string | null {
    if (this.cachedCefVersion !== undefined) return this.cachedCefVersion;
    this.cachedCefVersion = null;
    const arts = getNativeRuntimeState()?.artifacts;
    if (!arts?.cefDir) return null;
    const libcefPath = join(arts.cefDir, "libcef.dll");
    if (!existsSync(libcefPath)) return null;
    try {
      const lib = dlopen(libcefPath, {
        cef_version_info: { returns: FFIType.i32, args: [FFIType.i32] },
      });
      const v = (entry: number) => lib.symbols.cef_version_info(entry);
      this.cachedCefVersion = `${v(0)}.${v(1)}.${v(2)}+chromium-${v(4)}.${v(5)}.${v(6)}.${v(7)}`;
    } catch { /* leave as null */ }
    return this.cachedCefVersion;
  }
}

export const app = new AppRuntime();
