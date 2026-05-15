import { AppRuntime } from "./core/App";
import { BrowserWindow, type WindowOptionsType } from "./core/BrowserWindow";
import { BrowserView, type BrowserViewOptions } from "./core/BrowserView";
import { buniteEventEmitter } from "./events/eventEmitter";
import { BuniteEvent } from "./events/event";
import { completePermissionRequest } from "./native";
import { acquireSingleInstanceLock, type SingleInstanceLock } from "./core/singleInstanceLock";
import { log, type LogLevel } from "./log";

export { serveWeb } from "./serveWeb";
export type { WebRpcMount } from "./serveWeb";

export {
  acquireSingleInstanceLock,
  AppRuntime,
  BrowserWindow,
  BrowserView,
  buniteEventEmitter,
  completePermissionRequest,
  log
};

export type {
  LogLevel,
  BuniteEvent,
  BrowserViewOptions,
  SingleInstanceLock,
  WindowOptionsType
};
