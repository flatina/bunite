import { join } from "node:path";
import { BuniteEvent } from "../events/event";
import { buniteEventEmitter } from "../events/eventEmitter";
import {
  getNativeLibrary,
  initNativeRuntime,
  getNativeRuntimeState,
  setRouteRequestHandler,
  toCString,
  type NativeBootstrapOptions
} from "../proc/native";
import { attachGlobalIPCResolver, ensureRPCServer } from "./Socket";
import { BrowserWindow } from "./BrowserWindow";

type AppInitOptions = NativeBootstrapOptions & {
  userDataDir?: string;
  exitOnLastWindowClosed?: boolean;
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

        attachGlobalIPCResolver((channel) => this.getGlobalIPCHandler(channel));
        setRouteRequestHandler((requestId, path) => this.handleRouteRequest(requestId, path));

        // Replay view routes registered before init
        for (const path of this.viewHandlers.keys()) {
          getNativeLibrary()?.symbols.bunite_register_view_route(toCString(path));
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
      console.warn("[bunite] Running without a native event loop. Keeping the process alive in stub mode.");
      this.stubKeepAliveTimer = setInterval(() => {}, 60_000);
    }
  }

  quit(code = 0) {
    if (this.quitting) {
      return;
    }
    this.quitting = true;
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

  private readonly viewHandlers = new Map<string, () => string>();

  getView(path: string, handler: () => string) {
    this.viewHandlers.set(path, handler);
    getNativeLibrary()?.symbols.bunite_register_view_route(toCString(path));
  }

  removeView(path: string) {
    this.viewHandlers.delete(path);
    getNativeLibrary()?.symbols.bunite_unregister_view_route(toCString(path));
  }

  /** @internal */
  handleRouteRequest(requestId: number, path: string) {
    let html: string;
    try {
      const handler = this.viewHandlers.get(path);
      html = handler ? handler() : "<html><body>No handler for: " + path + "</body></html>";
    } catch (error) {
      html = "<html><body>Route handler error: " + (error instanceof Error ? error.message : String(error)) + "</body></html>";
    }
    getNativeLibrary()?.symbols.bunite_complete_route_request(requestId, toCString(html));
  }

  get runtime() {
    return getNativeRuntimeState();
  }
}

export const app = new AppRuntime();
