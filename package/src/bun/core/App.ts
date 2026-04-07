import { join } from "node:path";
import { BuniteEvent } from "../events/event";
import { buniteEventEmitter } from "../events/eventEmitter";
import {
  getNativeLibrary,
  initNativeRuntime,
  getNativeRuntimeState,
  type NativeBootstrapOptions
} from "../proc/native";
import { ensureRPCServer } from "./Socket";

type AppInitOptions = NativeBootstrapOptions & {
  userDataDir?: string;
};

class AppRuntime {
  private initPromise: Promise<void> | null = null;
  private stubKeepAliveTimer: ReturnType<typeof setInterval> | null = null;

  async init(options: AppInitOptions = {}) {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        if (options.userDataDir) {
          process.env.BUNITE_USER_DATA_DIR = options.userDataDir;
        } else if (!process.env.BUNITE_USER_DATA_DIR) {
          process.env.BUNITE_USER_DATA_DIR = join(process.cwd(), ".bunite");
        }

        const runtime = await initNativeRuntime({
          allowStub: options.allowStub,
          hideConsole: options.hideConsole,
          popupBlocking: options.popupBlocking
        });

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
    if (this.stubKeepAliveTimer) {
      clearInterval(this.stubKeepAliveTimer);
      this.stubKeepAliveTimer = null;
    }
    getNativeLibrary()?.symbols.bunite_quit();
    setTimeout(() => process.exit(code), 0);
  }

  get runtime() {
    return getNativeRuntimeState();
  }
}

export const app = new AppRuntime();
