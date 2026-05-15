import { AppRuntime } from "./core/App";
import { BrowserWindow, type WindowOptionsType } from "./core/BrowserWindow";
import { BrowserView, type BrowserViewOptions } from "./core/BrowserView";
import { buniteEventEmitter } from "./events/eventEmitter";
import { BuniteEvent } from "./events/event";
import { completePermissionRequest } from "./proc/native";
import { acquireSingleInstanceLock, type SingleInstanceLock } from "./core/singleInstanceLock";
import { log, type LogLevel } from "../shared/log";

export * from "../shared/rpc/index";
export { Stream } from "../shared/rpc/server";

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
