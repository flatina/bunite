import EventEmitter from "node:events";
import appEvents from "./appEvents";
import type { BuniteEvent } from "./event";
import webviewEvents from "./webviewEvents";
import windowEvents from "./windowEvents";

class BuniteEventEmitter extends EventEmitter {
  emitEvent(event: BuniteEvent, specifier?: string | number) {
    if (specifier !== undefined) {
      this.emit(`${event.name}-${specifier}`, event);
    }
    this.emit(event.name, event);
  }

  events = {
    app: {
      ...appEvents,
    },
    window: {
      ...windowEvents,
    },
    webview: {
      ...webviewEvents,
    },
  };
}

export const buniteEventEmitter = new BuniteEventEmitter();
