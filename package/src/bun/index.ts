import { AppRuntime } from "./core/App";
import { BrowserWindow, type WindowOptionsType } from "./core/BrowserWindow";
import { BrowserView, type BrowserViewOptions } from "./core/BrowserView";
import * as Utils from "./core/Utils";
import { buniteEventEmitter } from "./events/eventEmitter";
import { BuniteEvent } from "./events/event";
import { completePermissionRequest } from "./proc/native";
import {
  createRpc,
  defineBunRpc,
  type BuniteRpcConfig,
  type BuniteRpcSchema,
  type RpcSchema,
  type RpcWithTransport
} from "../shared/rpc";
import { createRpcTransportDemuxer, type RpcChannelHandle, type RpcTransportDemuxer, type RpcTransportDemuxerOptions } from "../shared/rpcDemux";
import { createWebSocketTransport, type WebSocketLike, type WebSocketTransportPipe } from "../shared/webSocketTransport";
import { createWebRpcHandler, type WebRpcClient } from "../shared/webRpcHandler";
import type { MessageBoxOptions, MessageBoxResponse } from "./core/Utils";
import { log, type LogLevel } from "../shared/log";

export {
  AppRuntime,
  BrowserWindow,
  BrowserView,
  Utils,
  buniteEventEmitter,
  completePermissionRequest,
  createRpc,
  createRpcTransportDemuxer,
  createWebRpcHandler,
  createWebSocketTransport,
  defineBunRpc,
  log
};

export type {
  LogLevel,
  BuniteEvent,
  BuniteRpcConfig,
  BuniteRpcSchema,
  BrowserViewOptions,
  RpcChannelHandle,
  MessageBoxOptions,
  MessageBoxResponse,
  RpcSchema,
  RpcWithTransport,
  RpcTransportDemuxer,
  RpcTransportDemuxerOptions,
  WebRpcClient,
  WebSocketLike,
  WebSocketTransportPipe,
  WindowOptionsType
};
