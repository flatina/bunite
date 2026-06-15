import { AppRuntime } from "./core/App";
import { BrowserView, type BrowserViewOptions } from "./core/BrowserView";
import { BrowserWindow, type WindowOptionsType } from "./core/BrowserWindow";
import { acquireSingleInstanceLock, type SingleInstanceLock } from "./core/singleInstanceLock";
import type { BuniteEvent } from "./events/event";
import { buniteEventEmitter } from "./events/eventEmitter";
import { type LogLevel, log } from "./log";
import { completePermissionRequest } from "./native";

export type { ServeWebOptions, WebRpcMount, WsData } from "./serveWeb";
export { serveWeb } from "./serveWeb";
export type { BrowserViewOptions, BuniteEvent, LogLevel, SingleInstanceLock, WindowOptionsType };
export {
  AppRuntime,
  acquireSingleInstanceLock,
  BrowserView,
  BrowserWindow,
  buniteEventEmitter,
  completePermissionRequest,
  log,
};
