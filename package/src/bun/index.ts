import { app } from "./core/App";
import { BrowserWindow, type WindowOptionsType } from "./core/BrowserWindow";
import { BrowserView, type BrowserViewOptions } from "./core/BrowserView";
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

export {
  app,
  BrowserWindow,
  BrowserView,
  buniteEventEmitter,
  completePermissionRequest,
  createRPC,
  defineBuniteRPC
};

export type {
  BuniteEvent,
  BuniteConfig,
  BuniteRPCConfig,
  BuniteRPCSchema,
  BrowserViewOptions,
  RPCSchema,
  RPCWithTransport,
  WindowOptionsType
};
