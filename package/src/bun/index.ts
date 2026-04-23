import { AppRuntime } from "./core/App";
import { BrowserWindow, type WindowOptionsType } from "./core/BrowserWindow";
import { BrowserView, type BrowserViewOptions } from "./core/BrowserView";
import * as Utils from "./core/Utils";
import { buniteEventEmitter } from "./events/eventEmitter";
import { BuniteEvent } from "./events/event";
import { completePermissionRequest } from "./proc/native";
import {
  createRPC,
  defineBunRPC,
  type BuniteRPCConfig,
  type BuniteRPCSchema,
  type RPCSchema,
  type RPCWithTransport
} from "../shared/rpc";
import { createTransportDemuxer, type ChannelHandle, type TransportDemuxer, type TransportDemuxerOptions } from "../shared/rpcDemux";
import { createWebSocketTransport, type WebSocketLike, type WebSocketTransportPipe } from "../shared/webSocketTransport";
import { createWebRPCHandler, type WebRPCClient } from "../shared/webRpcHandler";
import type { MessageBoxOptions, MessageBoxResponse } from "./core/Utils";
import { log, type LogLevel } from "../shared/log";

export {
  AppRuntime,
  BrowserWindow,
  BrowserView,
  Utils,
  buniteEventEmitter,
  completePermissionRequest,
  createRPC,
  createTransportDemuxer,
  createWebRPCHandler,
  createWebSocketTransport,
  defineBunRPC,
  log
};

export type {
  LogLevel,
  BuniteEvent,
  BuniteRPCConfig,
  BuniteRPCSchema,
  BrowserViewOptions,
  ChannelHandle,
  MessageBoxOptions,
  MessageBoxResponse,
  RPCSchema,
  RPCWithTransport,
  TransportDemuxer,
  TransportDemuxerOptions,
  WebRPCClient,
  WebSocketLike,
  WebSocketTransportPipe,
  WindowOptionsType
};
