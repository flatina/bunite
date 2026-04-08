import { app } from "./core/App";
import { BrowserWindow, type WindowOptionsType } from "./core/BrowserWindow";
import { BrowserView, type BrowserViewOptions } from "./core/BrowserView";
import * as Utils from "./core/Utils";
import { buniteEventEmitter } from "./events/eventEmitter";
import { BuniteEvent } from "./events/event";
import { completePermissionRequest } from "./proc/native";
import {
  createRPC,
  defineBuniteRPC,
  type BuniteRPCConfig,
  type BuniteRPCSchema,
  type RPCSchema,
  type RPCWithTransport
} from "../shared/rpc";
import type { BuniteConfig } from "../types/config";
import type { MessageBoxOptions, MessageBoxResponse } from "./core/Utils";
import { log, type LogLevel } from "../shared/log";

export {
  app,
  BrowserWindow,
  BrowserView,
  Utils,
  buniteEventEmitter,
  completePermissionRequest,
  createRPC,
  defineBuniteRPC,
  log
};

export type {
  LogLevel,
  BuniteEvent,
  BuniteConfig,
  BuniteRPCConfig,
  BuniteRPCSchema,
  BrowserViewOptions,
  MessageBoxOptions,
  MessageBoxResponse,
  RPCSchema,
  RPCWithTransport,
  WindowOptionsType
};
