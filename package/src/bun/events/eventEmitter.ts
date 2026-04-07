import EventEmitter from "node:events";
import { BuniteEvent } from "./event";
import appEvents from "./appEvents";
import windowEvents from "./windowEvents";
import webviewEvents from "./webviewEvents";

class BuniteEventEmitter extends EventEmitter {
  emitEvent(event: BuniteEvent, specifier?: string | number) {
    if (specifier !== undefined) {
      this.emit(`${event.name}-${specifier}`, event);
    }
    this.emit(event.name, event);
  }

  events = {
    app: {
      ...appEvents
    },
    window: {
      ...windowEvents
    },
    webview: {
      ...webviewEvents
    }
  };
}

export const buniteEventEmitter = new BuniteEventEmitter();
