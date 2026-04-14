export type RPCRequestPacket = {
  type: "request";
  id: number;
  method: string;
  params: unknown;
  scope?: "global";
};

export type RPCResponsePacket =
  | { type: "response"; id: number; success: true; payload: unknown; scope?: "global" }
  | { type: "response"; id: number; success: false; error?: string; scope?: "global" };

export type RPCMessagePacket = {
  type: "message";
  id: string;
  payload: unknown;
};

export type RPCEventPacket = {
  type: "event";
  channel: string;
  data: unknown;
};

export type RPCPacket = RPCRequestPacket | RPCResponsePacket | RPCMessagePacket | RPCEventPacket;

type BaseRPCRequestsSchema = Record<string, { params: unknown; response: unknown }>;
type BaseRPCMessagesSchema = Record<string, unknown>;

export type RPCRequestsSchema<T extends BaseRPCRequestsSchema = BaseRPCRequestsSchema> = T;
export type RPCMessagesSchema<T extends BaseRPCMessagesSchema = BaseRPCMessagesSchema> = T;

type InputRPCSchema = {
  requests?: RPCRequestsSchema;
  messages?: RPCMessagesSchema;
};

type ResolvedRPCSchema<I extends InputRPCSchema> = {
  requests: undefined extends I["requests"] ? BaseRPCRequestsSchema : NonNullable<I["requests"]>;
  messages: undefined extends I["messages"] ? BaseRPCMessagesSchema : NonNullable<I["messages"]>;
};

export type RPCSchema<I extends InputRPCSchema | void = InputRPCSchema> = ResolvedRPCSchema<
  I extends InputRPCSchema ? I : InputRPCSchema
>;

type RequestParams<RS extends RPCRequestsSchema, M extends keyof RS> = RS[M]["params"];
type RequestResponse<RS extends RPCRequestsSchema, M extends keyof RS> = RS[M]["response"];
type MessagePayload<MS extends RPCMessagesSchema, N extends keyof MS> = MS[N];

type RPCRequestHandlerFn<RS extends RPCRequestsSchema> = <M extends keyof RS>(
  method: M,
  params: RequestParams<RS, M>
) => Promise<RequestResponse<RS, M>> | RequestResponse<RS, M>;

type RPCRequestHandlerObject<RS extends RPCRequestsSchema> = {
  [M in keyof RS]?: (
    ...args: undefined extends RS[M]["params"] ? [params?: RS[M]["params"]] : [params: RS[M]["params"]]
  ) => Promise<Awaited<RequestResponse<RS, M>>> | Awaited<RequestResponse<RS, M>>;
} & {
  _?: (method: keyof RS, params: RequestParams<RS, keyof RS>) => unknown;
};

export type RPCRequestHandler<RS extends RPCRequestsSchema = RPCRequestsSchema> =
  | RPCRequestHandlerFn<RS>
  | RPCRequestHandlerObject<RS>;

export type RPCTransport = {
  send?: (data: RPCPacket) => void;
  registerHandler?: (handler: (packet: RPCPacket) => void) => void;
  unregisterHandler?: () => void;
};

export interface RPCWithTransport {
  setTransport: (transport: RPCTransport) => void;
}

export type BuniteRPCSchema = {
  bun: RPCSchema;
  webview: RPCSchema;
};

type RemoteSideOf<S extends "bun" | "webview"> = S extends "bun" ? "webview" : "bun";

export type BuniteRPCConfig<
  Schema extends BuniteRPCSchema,
  Side extends "bun" | "webview"
> = {
  maxRequestTime?: number;
  handlers: {
    requests?: RPCRequestHandler<Schema[Side]["requests"]>;
    messages?: {
      [K in keyof Schema[RemoteSideOf<Side>]["messages"]]?: (
        payload: MessagePayload<Schema[RemoteSideOf<Side>]["messages"], K>
      ) => void;
    } & {
      "*"?: (
        messageName: keyof Schema[RemoteSideOf<Side>]["messages"],
        payload: MessagePayload<Schema[RemoteSideOf<Side>]["messages"], keyof Schema[RemoteSideOf<Side>]["messages"]>
      ) => void;
    };
  };
};

const MAX_ID = 1e10;
const DEFAULT_MAX_REQUEST_TIME = 15_000;

function missingTransportMethodError(methods: string[], action: string): Error {
  return new Error(
    `This RPC instance cannot ${action} because the transport did not provide: ${methods.join(", ")}`
  );
}

export function createRPC<
  Schema extends RPCSchema = RPCSchema,
  RemoteSchema extends RPCSchema = Schema
>(options: {
  transport?: RPCTransport;
  requestHandler?: RPCRequestHandler<Schema["requests"]>;
  maxRequestTime?: number;
} = {}) {
  let transport: RPCTransport = {};
  let requestHandler:
    | RPCRequestHandlerFn<Schema["requests"]>
    | undefined;

  function setTransport(nextTransport: RPCTransport) {
    transport.unregisterHandler?.();
    transport = nextTransport;
    transport.registerHandler?.(handlePacket);
  }

  function setRequestHandler(handler: RPCRequestHandler<Schema["requests"]>) {
    if (typeof handler === "function") {
      requestHandler = handler as RPCRequestHandlerFn<Schema["requests"]>;
      return;
    }

    requestHandler = (method, params) => {
      const requestHandlerObject = handler as RPCRequestHandlerObject<Schema["requests"]>;
      const specificHandler = requestHandlerObject[method];
      if (specificHandler) {
        return (specificHandler as (...args: [unknown]) => unknown)(params);
      }
      if (!requestHandlerObject._) {
        throw new Error(`The requested method has no handler: ${String(method)}`);
      }
      return requestHandlerObject._(method, params as never);
    };
  }

  if (options.transport) {
    setTransport(options.transport);
  }
  if (options.requestHandler) {
    setRequestHandler(options.requestHandler);
  }

  let lastRequestId = 0;
  const maxRequestTime = options.maxRequestTime ?? DEFAULT_MAX_REQUEST_TIME;
  const pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  const messageListeners = new Map<string, Set<(payload: unknown) => void>>();
  const wildcardListeners = new Set<(messageName: string, payload: unknown) => void>();

  function nextRequestId() {
    if (lastRequestId < MAX_ID) {
      lastRequestId += 1;
      return lastRequestId;
    }
    lastRequestId = 1;
    return lastRequestId;
  }

  function request<M extends keyof RemoteSchema["requests"]>(
    method: M,
    ...args: undefined extends RemoteSchema["requests"][M]["params"]
      ? [params?: RemoteSchema["requests"][M]["params"]]
      : [params: RemoteSchema["requests"][M]["params"]]
  ): Promise<RemoteSchema["requests"][M]["response"]> {
    if (!transport.send) {
      throw missingTransportMethodError(["send"], "issue requests");
    }

    const id = nextRequestId();
    const params = args[0];
    const packet: RPCRequestPacket = {
      type: "request",
      id,
      method: String(method),
      params
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`Request timed out: ${String(method)}`));
      }, maxRequestTime);

      pendingRequests.set(id, { resolve, reject, timeout });
      transport.send?.(packet);
    }) as Promise<RemoteSchema["requests"][M]["response"]>;
  }

  function send<M extends keyof RemoteSchema["messages"]>(
    messageName: M,
    ...args: void extends RemoteSchema["messages"][M]
      ? []
      : undefined extends RemoteSchema["messages"][M]
        ? [payload?: RemoteSchema["messages"][M]]
        : [payload: RemoteSchema["messages"][M]]
  ): void {
    if (!transport.send) {
      throw missingTransportMethodError(["send"], "send messages");
    }

    transport.send({
      type: "message",
      id: String(messageName),
      payload: args[0]
    });
  }

  function addMessageListener(
    messageName: "*" | keyof Schema["messages"],
    listener:
      | ((name: string, payload: unknown) => void)
      | ((payload: unknown) => void)
  ) {
    if (messageName === "*") {
      wildcardListeners.add(listener as (name: string, payload: unknown) => void);
      return;
    }

    const key = String(messageName);
    if (!messageListeners.has(key)) {
      messageListeners.set(key, new Set());
    }
    messageListeners.get(key)?.add(listener as (payload: unknown) => void);
  }

  function removeMessageListener(
    messageName: "*" | keyof Schema["messages"],
    listener: ((payload: unknown) => void) | ((name: string, payload: unknown) => void)
  ) {
    if (messageName === "*") {
      wildcardListeners.delete(listener as (name: string, payload: unknown) => void);
      return;
    }

    messageListeners.get(String(messageName))?.delete(listener as (payload: unknown) => void);
  }

  async function handlePacket(packet: RPCPacket) {
    if (packet.type === "request") {
      if (!transport.send || !requestHandler) {
        throw missingTransportMethodError(["send", "requestHandler"], "handle requests");
      }

      try {
        const payload = await requestHandler(packet.method as never, packet.params as never);
        transport.send({
          type: "response",
          id: packet.id,
          success: true,
          payload
        });
      } catch (error) {
        transport.send({
          type: "response",
          id: packet.id,
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    if (packet.type === "response") {
      const pending = pendingRequests.get(packet.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timeout);
      pendingRequests.delete(packet.id);

      if (!packet.success) {
        pending.reject(new Error(packet.error ?? "Unknown RPC error"));
      } else {
        pending.resolve(packet.payload);
      }
      return;
    }

    if (packet.type === "message") {
      for (const listener of wildcardListeners) {
        listener(packet.id, packet.payload);
      }
      for (const listener of messageListeners.get(packet.id) ?? []) {
        listener(packet.payload);
      }
    }
  }

  const requestProxy = new Proxy(
    {},
    {
      get(_target, method) {
        return (params: unknown) =>
          request(method as keyof RemoteSchema["requests"], params as never);
      }
    }
  ) as {
    [M in keyof RemoteSchema["requests"]]: (
      ...args: undefined extends RemoteSchema["requests"][M]["params"]
        ? [params?: RemoteSchema["requests"][M]["params"]]
        : [params: RemoteSchema["requests"][M]["params"]]
    ) => Promise<RemoteSchema["requests"][M]["response"]>;
  };

  const sendProxy = new Proxy(
    {},
    {
      get(_target, method) {
        return (...args: unknown[]) =>
          (send as any)(method as keyof RemoteSchema["messages"], ...args);
      }
    }
  ) as {
    [M in keyof RemoteSchema["messages"]]: (
      ...args: void extends RemoteSchema["messages"][M]
        ? []
        : undefined extends RemoteSchema["messages"][M]
          ? [payload?: RemoteSchema["messages"][M]]
          : [payload: RemoteSchema["messages"][M]]
    ) => void;
  };

  return {
    setTransport,
    setRequestHandler,
    request,
    send,
    requestProxy,
    sendProxy,
    addMessageListener,
    removeMessageListener,
    proxy: {
      request: requestProxy,
      send: sendProxy
    }
  };
}

export function defineBuniteRPC<
  Schema extends BuniteRPCSchema,
  Side extends "bun" | "webview"
>(
  side: Side,
  config: BuniteRPCConfig<Schema, Side> & {
    extraRequestHandlers?: Record<string, (...args: any[]) => unknown>;
  }
) {
  type RemoteSide = Side extends "bun" ? "webview" : "bun";
  type LocalSchema = {
    requests: Schema[Side]["requests"];
    messages: Schema[RemoteSide]["messages"];
  };
  type RemoteSchema = {
    requests: Schema[RemoteSide]["requests"];
    messages: Schema[Side]["messages"];
  };

  const rpc = createRPC<LocalSchema, RemoteSchema>({
    maxRequestTime: config.maxRequestTime,
    requestHandler: {
      ...(config.handlers.requests ?? {}),
      ...(config.extraRequestHandlers ?? {})
    } as RPCRequestHandler<LocalSchema["requests"]>,
    transport: {
      registerHandler: () => {}
    }
  });

  if (config.handlers.messages) {
    rpc.addMessageListener("*", (messageName, payload) => {
      const wildcardHandler = config.handlers.messages?.["*"];
      wildcardHandler?.(messageName as never, payload as never);

      const specificHandler = config.handlers.messages?.[
        messageName as keyof Schema[Side]["messages"]
      ];
      if (specificHandler) {
        (specificHandler as (payload: unknown) => void)(payload);
      }
    });
  }

  return rpc;
}
