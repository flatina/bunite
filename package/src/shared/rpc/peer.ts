import {
  type CapDef,
  type Schema,
  type SchemaShape,
  type ClientOf,
  type ImplOf,
  type ServerDescriptor,
  type CallCtx,
  type Attestation,
  type ExportedCap,
  type MethodDef,
  type Stream as StreamType,
  type DisposalSpec,
  isCallDef,
  isStreamDef,
  isCapRef,
  isCapArray,
  isCapRecord,
} from "./schema";
import { RuntimeCap, frameworkTypeIdOf } from "./framework";
import {
  type Frame,
  type CallFrame,
  type ResultFrame,
  type StreamFrame,
  type CancelFrame,
  type DropFrame,
  type HelloFrame,
  type CallMeta,
  CapRef,
  DEFAULT_MAX_BYTES,
  PROTOCOL_VERSION,
} from "./wire";
import { IpcError, type IpcStatus, type IpcCode } from "./error";

export const USER_ROOTS_CAP_ID = 0;
export const RUNTIME_CAP_ID = 1;
export const USER_ROOTS_TYPE_ID = 0;
export const RUNTIME_TYPE_ID = 1;

export const FIRST_USER_CAP_ID = 2;
export const FIRST_USER_TYPE_ID = 128;

export const MAX_CAPS_PER_CONNECTION = 1024;
export const MAX_CHANNELS_PER_CONNECTION = 8;

const DEFAULT_DEADLINE_GRACE_MS = 500;
const DEFAULT_STREAM_INITIAL_CREDIT = 32;
const DEFAULT_STREAM_CREDIT_BATCH = 8;

export interface CapTableEntry {
  capId: number;
  typeId: number;
  cap: CapDef<any, any> | null;
  impl: unknown;
  refCount: number;
}

export class CapTable {
  private readonly entries = new Map<number, CapTableEntry>();
  private nextCapId = FIRST_USER_CAP_ID;
  private readonly capLimit: number;

  constructor(capLimit = MAX_CAPS_PER_CONNECTION) {
    this.capLimit = capLimit;
  }

  install(capId: number, entry: Omit<CapTableEntry, "capId">): CapTableEntry {
    if (this.entries.has(capId)) throw new Error(`cap-id ${capId} already installed`);
    const full = { capId, ...entry };
    this.entries.set(capId, full);
    return full;
  }

  allocate(entry: Omit<CapTableEntry, "capId">): CapTableEntry {
    if (this.entries.size >= this.capLimit) {
      throw new IpcError({ code: "resource_exhausted", message: `cap-table limit ${this.capLimit}` });
    }
    let capId = this.nextCapId++;
    while (this.entries.has(capId)) capId = this.nextCapId++;
    return this.install(capId, entry);
  }

  get(capId: number): CapTableEntry | undefined {
    return this.entries.get(capId);
  }

  release(capId: number, delta = 1): boolean {
    const entry = this.entries.get(capId);
    if (!entry) return false;
    entry.refCount = Math.max(0, entry.refCount - delta);
    if (entry.refCount === 0 && capId >= FIRST_USER_CAP_ID) {
      this.entries.delete(capId);
      return true;
    }
    return false;
  }

  clear(): void {
    this.entries.clear();
    this.nextCapId = FIRST_USER_CAP_ID;
  }

  size(): number {
    return this.entries.size;
  }

  values(): IterableIterator<CapTableEntry> {
    return this.entries.values();
  }
}

export interface Transport {
  send(frame: Frame): void;
  setReceive(handler: (frame: Frame) => void): void;
  close(): void;
}

export interface Connection {
  bootstrap<S extends SchemaShape, K extends keyof S["roots"] & string>(
    schema: Schema<S>,
    name: K
  ): Promise<ClientOf<S["roots"][K]>>;
  serve<S extends SchemaShape>(descriptor: ServerDescriptor<S>): void;
  runtime(): ClientOf<typeof RuntimeCap>;
  releaseRef(proxy: unknown): void;
  onClose(handler: () => void): () => void;
  readonly closed: boolean;
}

export interface ConnectionOptions {
  transport: Transport;
  mode: "native" | "web";
  origin: string;
  features?: string[];
  maxBytes?: number;
  capLimit?: number;
  peerId?: string;
  attestation?: Attestation;
  runtime?: ImplOf<typeof RuntimeCap>;
}

export interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  abort: AbortController;
  decodeReturn?: ReturnDecoder;
  timer?: ReturnType<typeof setTimeout>;
}

type ReturnDecoder = (raw: unknown) => unknown;

const DEFAULT_ATTESTATION: Attestation = {
  origin: "bunite://internal",
  topOrigin: "bunite://internal",
  partition: "default",
  isAppRes: true,
  isMainFrame: true,
  userGesture: false,
  level: "app-internal",
};

const EXPORTED_CAP_BRAND = Symbol("bunite.rpc.ExportedCap");
const CAP_PROXY_META = Symbol("bunite.rpc.CapProxyMeta");

function isExportedCap(v: unknown): v is ExportedCap<any> {
  return typeof v === "object" && v !== null && (v as any)[EXPORTED_CAP_BRAND] === true;
}

const proxyFinalizers = typeof FinalizationRegistry !== "undefined"
  ? new FinalizationRegistry<{ connRef: WeakRef<ConnectionImpl>; capId: number; dropped: () => boolean }>((held) => {
      if (held.dropped()) return;
      const conn = held.connRef.deref();
      if (!conn || conn.closed) return;
      conn._dropFromFinalizer(held.capId);
    })
  : ({ register: () => {} } as { register: (target: object, held: unknown) => void });

interface UserRootsSlot {
  schema: Schema<any>;
  impls: Record<string, unknown>;
}

interface ServerStreamCtx {
  iter: AsyncIterator<unknown> | null;
  abort: AbortController;
  cancelled: boolean;
  credit: number;
  creditWaker: (() => void) | null;
}

interface ClientStreamCtx {
  push(chunk: unknown): void;
  end(): void;
  fail(error: IpcError): void;
}

class ConnectionImpl implements Connection {
  private readonly transport: Transport;
  private readonly capTable: CapTable;
  private readonly pending = new Map<number, PendingCall>();
  private readonly clientStreams = new Map<number, ClientStreamCtx>();
  private readonly serverStreams = new Map<number, ServerStreamCtx>();
  private readonly serverCallChildren = new Map<number, { parentId: number }>();
  private readonly serverActiveCalls = new Map<number, AbortController>();
  private readonly rootInstances = new Map<string, number>();
  private readonly closeHandlers = new Set<() => void>();
  private nextCallId = 1;
  private remoteHello: HelloFrame | null = null;
  private readonly remoteReady: Promise<HelloFrame>;
  private resolveRemoteReady!: (h: HelloFrame) => void;
  private rejectRemoteReady!: (e: Error) => void;
  private closed_ = false;
  private readonly maxBytes: number;
  private readonly mode: "native" | "web";
  private readonly origin: string;
  private readonly features: string[];
  private readonly attestation: Attestation;
  private readonly peerId: string;

  constructor(opts: ConnectionOptions) {
    this.transport = opts.transport;
    this.mode = opts.mode;
    this.origin = opts.origin;
    this.features = opts.features ?? [];
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.attestation = opts.attestation ?? DEFAULT_ATTESTATION;
    this.peerId = opts.peerId ?? "peer";
    this.capTable = new CapTable(opts.capLimit ?? MAX_CAPS_PER_CONNECTION);

    this.capTable.install(USER_ROOTS_CAP_ID, {
      typeId: USER_ROOTS_TYPE_ID,
      cap: null,
      impl: null as UserRootsSlot | null,
      refCount: 1,
    });
    this.capTable.install(RUNTIME_CAP_ID, {
      typeId: RUNTIME_TYPE_ID,
      cap: RuntimeCap,
      impl: opts.runtime ?? null,
      refCount: 1,
    });

    this.remoteReady = new Promise<HelloFrame>((res, rej) => {
      this.resolveRemoteReady = res;
      this.rejectRemoteReady = rej;
    });
    this.remoteReady.catch(() => {});

    this.transport.setReceive((frame) => this.handleFrame(frame));
    this.transport.send({
      op: "hello",
      v: PROTOCOL_VERSION,
      mode: this.mode,
      features: this.features,
      maxBytes: this.maxBytes,
      origin: this.origin,
    });
  }

  get closed(): boolean {
    return this.closed_;
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  serve<S extends SchemaShape>(descriptor: ServerDescriptor<S>): void {
    const entry = this.capTable.get(USER_ROOTS_CAP_ID);
    if (!entry) throw new Error("UserRoots slot missing");
    entry.impl = {
      schema: descriptor.schema,
      impls: descriptor.impls as Record<string, unknown>,
    } satisfies UserRootsSlot;
  }

  private runtimeProxy: ClientOf<typeof RuntimeCap> | null = null;

  runtime(): ClientOf<typeof RuntimeCap> {
    if (!this.runtimeProxy) {
      this.runtimeProxy = this.makeCapProxy(RuntimeCap, RUNTIME_CAP_ID);
    }
    return this.runtimeProxy;
  }

  async bootstrap<S extends SchemaShape, K extends keyof S["roots"] & string>(
    schema: Schema<S>,
    name: K
  ): Promise<ClientOf<S["roots"][K]>> {
    await this.remoteReady;
    const rootNames = Object.keys(schema.roots);
    const idx = rootNames.indexOf(name);
    if (idx < 0) {
      throw new IpcError({ code: "invalid_argument", message: `root "${name}" not in schema` });
    }
    const rootCap = schema.roots[name] as CapDef<any, any>;
    const hash = await schema.topologyHash();
    const raw = await this.sendCallTyped(USER_ROOTS_CAP_ID, idx, undefined, undefined, { topologyHash: hash });
    if (!(raw instanceof CapRef)) {
      throw new IpcError({ code: "protocol_error", message: "bootstrap did not return a CapRef" });
    }
    return this.makeCapProxy(rootCap, raw.capId) as ClientOf<S["roots"][K]>;
  }

  private handleFrame(frame: Frame): void {
    if (this.closed_) return;
    switch (frame.op) {
      case "hello":
        this.handleHello(frame);
        return;
      case "call":
        void this.handleCall(frame);
        return;
      case "result":
        this.handleResult(frame);
        return;
      case "cancel":
        this.handleCancel(frame);
        return;
      case "stream":
        this.handleStreamFrame(frame);
        return;
      case "drop":
        this.handleDrop(frame);
        return;
      case "goaway":
        this.handleGoaway(frame);
        return;
      default:
        this.handleUnknownFrame(frame);
        return;
    }
  }

  private handleUnknownFrame(frame: unknown): void {
    const id = (frame as { id?: unknown })?.id;
    if (typeof id === "number") {
      this.transport.send({ op: "result", id, ok: false, error: { code: "protocol_error", message: "unknown opcode" } });
      return;
    }
    this.transport.send({ op: "goaway", reason: "protocol_error", error: { code: "protocol_error", message: "unknown opcode" } });
    this.shutdown("protocol_error");
  }

  private handleHello(frame: HelloFrame): void {
    this.remoteHello = frame;
    this.resolveRemoteReady(frame);
  }

  private handleGoaway(frame: Extract<Frame, { op: "goaway" }>): void {
    this.rejectRemoteReady(
      new IpcError(frame.error ?? { code: "unavailable", message: frame.reason ?? "peer goaway" })
    );
    this.shutdown(frame.reason ?? "remote goaway");
  }

  private async handleCall(frame: CallFrame): Promise<void> {
    const entry = this.capTable.get(frame.target.id);
    if (!entry) return this.sendError(frame.id, "not_found", `cap-id ${frame.target.id} not found`);

    if (entry.capId === USER_ROOTS_CAP_ID) {
      return this.handleUserRootsCall(frame, entry);
    }

    const cap = entry.cap;
    if (!cap || !entry.impl) return this.sendError(frame.id, "not_supported", "cap has no impl");

    const methodNames = Object.keys(cap.methods);
    if (frame.method >= methodNames.length) {
      return this.sendError(frame.id, "not_supported", `method index ${frame.method} out of range`);
    }
    const methodName = methodNames[frame.method];
    const methodDef = cap.methods[methodName] as MethodDef;
    const impl = (entry.impl as Record<string, unknown>)[methodName];
    if (typeof impl !== "function") {
      return this.sendError(frame.id, "not_supported", `method "${methodName}" has no handler`);
    }

    await this.invokeServerMethod(frame, methodDef, impl as (params: unknown, ctx: CallCtx) => unknown);
  }

  private async handleUserRootsCall(frame: CallFrame, entry: CapTableEntry): Promise<void> {
    const slot = entry.impl as UserRootsSlot | null;
    if (!slot) return this.sendError(frame.id, "not_supported", "no server attached");
    const clientHash = frame.meta?.topologyHash;
    if (clientHash) {
      const ourHash = await slot.schema.topologyHash();
      if (clientHash !== ourHash) {
        return this.sendError(
          frame.id,
          "failed_precondition",
          `topologyHash mismatch (client ${clientHash.slice(0, 8)} vs server ${ourHash.slice(0, 8)})`
        );
      }
    }
    const rootNames = Object.keys(slot.schema.roots);
    if (frame.method >= rootNames.length) {
      return this.sendError(frame.id, "not_supported", `root index ${frame.method} out of range`);
    }
    const rootName = rootNames[frame.method];
    const rootCap = slot.schema.roots[rootName] as CapDef<any, any>;
    const rootImpl = slot.impls[rootName];
    if (!rootImpl) return this.sendError(frame.id, "not_supported", `no impl for root "${rootName}"`);

    const cachedCapId = this.rootInstances.get(rootName);
    if (cachedCapId !== undefined) {
      const cached = this.capTable.get(cachedCapId);
      if (cached) {
        cached.refCount += 1;
        this.transport.send({ op: "result", id: frame.id, ok: true, value: new CapRef(cachedCapId) });
        return;
      }
      this.rootInstances.delete(rootName);
    }
    let allocated: CapTableEntry;
    try {
      allocated = this.capTable.allocate({
        typeId: frameworkTypeIdOf(rootCap) ?? FIRST_USER_TYPE_ID,
        cap: rootCap,
        impl: rootImpl,
        refCount: 1,
      });
    } catch (err) {
      return this.sendErrorFromException(frame.id, err);
    }
    this.rootInstances.set(rootName, allocated.capId);
    this.transport.send({ op: "result", id: frame.id, ok: true, value: new CapRef(allocated.capId) });
  }

  private async invokeServerMethod(
    frame: CallFrame,
    methodDef: MethodDef,
    impl: (params: unknown, ctx: CallCtx) => unknown
  ): Promise<void> {
    const ctx = this.makeCallCtx(frame);

    if (isStreamDef(methodDef)) {
      try {
        const stream = impl(frame.args, ctx) as StreamType<unknown>;
        this.runServerStream(frame.id, stream, ctx);
      } catch (err) {
        this.transport.send({ op: "stream", id: frame.id, ev: "error", error: toStatus(err) });
      }
      return;
    }

    if (isCallDef(methodDef)) {
      const deadlineTimer = methodDef.idempotent ? undefined : this.armServerDeadline(frame, ctx);
      this.serverActiveCalls.set(frame.id, (ctx as unknown as { _ctrl: AbortController })._ctrl);
      try {
        const result = await impl(frame.args, ctx);
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (!this.serverActiveCalls.delete(frame.id)) return;
        const encoded = encodeReturn(result);
        this.transport.send({ op: "result", id: frame.id, ok: true, value: encoded });
      } catch (err) {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (!this.serverActiveCalls.delete(frame.id)) return;
        this.sendErrorFromException(frame.id, err);
      }
      return;
    }

    this.sendError(frame.id, "not_supported", "unknown method kind");
  }

  private armServerDeadline(frame: CallFrame, ctx: CallCtx): ReturnType<typeof setTimeout> | undefined {
    const ms = frame.meta?.deadlineMs;
    if (!ms) return;
    return setTimeout(() => {
      (ctx as unknown as { _ctrl: AbortController })._ctrl.abort();
    }, ms);
  }

  private makeCallCtx(frame: CallFrame): CallCtx {
    const ctrl = new AbortController();
    const ctx: CallCtx & { _ctrl: AbortController } = {
      callId: frame.id,
      peerId: this.peerId,
      attestation: this.attestation,
      signal: ctrl.signal,
      deadline: frame.meta?.deadlineMs,
      context: frame.meta?.context,
      _ctrl: ctrl,
      exportCap: (capDef, impl) => this.exportCap(capDef, impl),
    };
    return ctx;
  }

  private exportCap<C extends CapDef<any, any>>(capDef: C, impl: unknown): ExportedCap<C> {
    const entry = this.capTable.allocate({
      typeId: frameworkTypeIdOf(capDef) ?? FIRST_USER_TYPE_ID,
      cap: capDef,
      impl,
      refCount: 1,
    });
    return {
      [EXPORTED_CAP_BRAND]: true,
      cap: capDef,
      capId: entry.capId,
      typeId: entry.typeId,
    } as unknown as ExportedCap<C>;
  }

  private runServerStream(callId: number, stream: StreamType<unknown>, ctx: CallCtx): void {
    const iter = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    const abort = (ctx as unknown as { _ctrl: AbortController })._ctrl;
    const slot: ServerStreamCtx = {
      iter,
      abort,
      cancelled: false,
      credit: DEFAULT_STREAM_INITIAL_CREDIT,
      creditWaker: null,
    };
    this.serverStreams.set(callId, slot);

    const waitForCredit = (): Promise<void> => {
      if (slot.credit > 0 || slot.cancelled) return Promise.resolve();
      return new Promise<void>((resolve) => { slot.creditWaker = resolve; });
    };

    const drain = async () => {
      let errored = false;
      try {
        while (!slot.cancelled) {
          if (slot.credit === 0) await waitForCredit();
          if (slot.cancelled) break;
          const { done, value } = await iter.next();
          if (done) break;
          if (slot.cancelled) break;
          slot.credit -= 1;
          this.transport.send({ op: "stream", id: callId, ev: "next", value: encodeReturn(value) });
        }
      } catch (err) {
        errored = true;
        this.transport.send({ op: "stream", id: callId, ev: "error", error: toStatus(err) });
      } finally {
        if (!errored) this.transport.send({ op: "stream", id: callId, ev: "end" });
        this.serverStreams.delete(callId);
      }
    };
    void drain();
  }

  private handleResult(frame: ResultFrame): void {
    const pending = this.pending.get(frame.id);
    if (pending) {
      this.pending.delete(frame.id);
      this.serverCallChildren.delete(frame.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (frame.ok) {
        const value = pending.decodeReturn ? pending.decodeReturn(frame.value) : frame.value;
        pending.resolve(value);
      } else {
        pending.reject(new IpcError(frame.error));
      }
      return;
    }
    const stream = this.clientStreams.get(frame.id);
    if (stream) {
      this.clientStreams.delete(frame.id);
      const err = frame.ok
        ? new IpcError({ code: "protocol_error", message: "stream method returned result frame" })
        : new IpcError(frame.error);
      stream.fail(err);
    }
  }

  private handleCancel(frame: CancelFrame): void {
    const stream = this.serverStreams.get(frame.id);
    if (stream) {
      stream.cancelled = true;
      stream.abort.abort();
      void stream.iter?.return?.();
      this.serverStreams.delete(frame.id);
    }
    const active = this.serverActiveCalls.get(frame.id);
    if (active) {
      this.serverActiveCalls.delete(frame.id);
      active.abort();
      this.transport.send({
        op: "result",
        id: frame.id,
        ok: false,
        error: { code: "cancelled", message: frame.reason },
      });
    }
    for (const [childId, child] of this.serverCallChildren) {
      if (child.parentId !== frame.id) continue;
      this.serverCallChildren.delete(childId);
      if (this.pending.has(childId)) {
        this.transport.send({ op: "cancel", id: childId, reason: frame.reason });
      }
    }
  }

  releaseRef(proxy: unknown): void {
    if (this.closed_) return;
    if (typeof proxy !== "object" || proxy === null) return;
    const meta = (proxy as Record<symbol, unknown>)[CAP_PROXY_META] as { capId: number; dropped: boolean } | undefined;
    if (!meta || meta.dropped) return;
    if (meta.capId < FIRST_USER_CAP_ID) return;
    meta.dropped = true;
    this.transport.send({ op: "drop", caps: [{ id: meta.capId, delta: 1 }] });
  }

  private handleStreamFrame(frame: StreamFrame): void {
    if (frame.ev === "credit") {
      const slot = this.serverStreams.get(frame.id);
      if (!slot) return;
      slot.credit += frame.credit?.messages ?? 0;
      const waker = slot.creditWaker;
      slot.creditWaker = null;
      waker?.();
      return;
    }
    const stream = this.clientStreams.get(frame.id);
    if (!stream) return;
    switch (frame.ev) {
      case "next":
        stream.push(frame.value);
        return;
      case "end":
        stream.end();
        this.clientStreams.delete(frame.id);
        return;
      case "error":
        stream.fail(new IpcError(frame.error));
        this.clientStreams.delete(frame.id);
        return;
    }
  }

  private handleDrop(frame: DropFrame): void {
    for (const { id, delta } of frame.caps) {
      const released = this.capTable.release(id, delta);
      if (released) {
        for (const [rootName, capId] of this.rootInstances) {
          if (capId === id) { this.rootInstances.delete(rootName); break; }
        }
      }
    }
  }

  private sendError(callId: number, code: IpcCode, message?: string): void {
    this.transport.send({ op: "result", id: callId, ok: false, error: { code, message } });
  }

  private sendErrorFromException(callId: number, err: unknown): void {
    this.transport.send({ op: "result", id: callId, ok: false, error: toStatus(err) });
  }

  private nextId(): number {
    return this.nextCallId++;
  }

  sendCallRaw(capId: number, methodIdx: number, args: unknown, meta?: CallMeta): Promise<unknown> {
    return this.sendCallTyped(capId, methodIdx, args, undefined, meta);
  }

  sendCallTyped(
    capId: number,
    methodIdx: number,
    args: unknown,
    decodeReturn: ReturnDecoder | undefined,
    meta?: CallMeta
  ): Promise<unknown> {
    if (this.closed_) return Promise.reject(new IpcError({ code: "unavailable", message: "connection closed" }));
    const id = this.nextId();
    return new Promise((resolve, reject) => {
      const abort = new AbortController();
      const pending: PendingCall = { resolve, reject, abort, decodeReturn };
      if (meta?.deadlineMs) {
        pending.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            this.transport.send({ op: "cancel", id, reason: "deadline_exceeded" });
            reject(new IpcError({ code: "deadline_exceeded" }));
          }
        }, meta.deadlineMs + DEFAULT_DEADLINE_GRACE_MS);
      }
      this.pending.set(id, pending);
      if (meta?.parentCallId !== undefined) {
        this.serverCallChildren.set(id, { parentId: meta.parentCallId });
      }
      this.transport.send({ op: "call", id, target: { kind: "cap", id: capId }, method: methodIdx, args, meta });
    });
  }

  openClientStream<T>(capId: number, methodIdx: number, args: unknown, meta?: CallMeta): StreamType<T> {
    if (this.closed_) {
      const empty = makeClientStream<T>(0, () => {}, () => {});
      empty.fail(new IpcError({ code: "unavailable", message: "connection closed" }));
      return empty.stream;
    }
    const id = this.nextId();
    const cancel = () => {
      if (this.clientStreams.delete(id)) {
        this.transport.send({ op: "cancel", id, reason: "client_cancel" });
      }
    };
    const sendCredit = (messages: number) => {
      if (this.closed_ || !this.clientStreams.has(id)) return;
      this.transport.send({ op: "stream", id, ev: "credit", credit: { messages } });
    };
    const ctx = makeClientStream<T>(id, cancel, sendCredit);
    this.clientStreams.set(id, ctx);
    this.transport.send({ op: "call", id, target: { kind: "cap", id: capId }, method: methodIdx, args, meta });
    return ctx.stream;
  }

  makeCapProxy<C extends CapDef<any, any>>(capDef: C, capId: number): ClientOf<C> {
    const methodNames = Object.keys(capDef.methods);
    const proxy: Record<string | symbol, unknown> = {};
    const isWellKnown = capId < FIRST_USER_CAP_ID;
    const meta = { capId, dropped: isWellKnown };
    proxy[CAP_PROXY_META] = meta;
    const drop = () => {
      if (meta.dropped || this.closed_) return;
      meta.dropped = true;
      this.transport.send({ op: "drop", caps: [{ id: capId, delta: 1 }] });
    };

    for (let i = 0; i < methodNames.length; i++) {
      const name = methodNames[i];
      const def = capDef.methods[name] as MethodDef;
      if (isStreamDef(def)) {
        proxy[name] = (params?: unknown) => this.openClientStream(capId, i, params);
      } else if (isCallDef(def)) {
        const decoder = makeReturnDecoder(def.returns, (cd, cid) => this.makeCapProxy(cd, cid));
        proxy[name] = (params?: unknown) => this.sendCallTyped(capId, i, params, decoder);
      }
    }

    const disposal = capDef.disposal as DisposalSpec | undefined;
    if (disposal) {
      const invokeMethod = (): unknown => {
        const fn = proxy[disposal.method] as (() => unknown) | undefined;
        return fn?.();
      };
      proxy[Symbol.asyncDispose] = async () => {
        const r = invokeMethod();
        await Promise.resolve(r);
        drop();
      };
      proxy[Symbol.dispose] = () => {
        const r = invokeMethod();
        drop();
        void r;
      };
    }

    if (!isWellKnown && typeof FinalizationRegistry !== "undefined") {
      proxyFinalizers.register(proxy as object, {
        connRef: new WeakRef(this),
        capId,
        dropped: () => meta.dropped,
      });
    }

    return proxy as ClientOf<C>;
  }

  _dropFromFinalizer(capId: number): void {
    if (this.closed_) return;
    try {
      this.transport.send({ op: "drop", caps: [{ id: capId, delta: 1 }] });
    } catch { /* swallow */ }
  }

  shutdown(reason: string): void {
    if (this.closed_) return;
    this.closed_ = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new IpcError({ code: "unavailable", message: reason }));
    }
    this.pending.clear();
    for (const stream of this.clientStreams.values()) {
      stream.fail(new IpcError({ code: "unavailable", message: reason }));
    }
    this.clientStreams.clear();
    for (const slot of this.serverStreams.values()) {
      slot.cancelled = true;
      slot.abort.abort();
      void slot.iter?.return?.();
    }
    this.serverStreams.clear();
    for (const ctrl of this.serverActiveCalls.values()) {
      ctrl.abort();
    }
    this.serverActiveCalls.clear();
    for (const entry of this.capTable.values()) {
      this.invokeServerDisposal(entry);
    }
    this.capTable.clear();
    if (!this.remoteHello) {
      this.rejectRemoteReady(new IpcError({ code: "unavailable", message: reason }));
    }
    for (const fn of this.closeHandlers) {
      try { fn(); } catch { /* swallow */ }
    }
    this.closeHandlers.clear();
    try { this.transport.close(); } catch { /* swallow */ }
  }

  private invokeServerDisposal(entry: CapTableEntry): void {
    const cap = entry.cap;
    if (!cap) return;
    const disposal = cap.disposal as DisposalSpec | undefined;
    if (!disposal) return;
    const impl = entry.impl as Record<string, unknown> | null;
    const fn = impl?.[disposal.method] as ((p: unknown, c?: unknown) => unknown) | undefined;
    if (!fn) return;
    try { void fn.call(impl, undefined, undefined); } catch { /* swallow */ }
  }
}

function encodeReturn(value: unknown): unknown {
  if (isExportedCap(value)) return new CapRef(value.capId);
  if (Array.isArray(value)) return value.map(encodeReturn);
  if (value && typeof value === "object" && (value as any).constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object)) {
      out[k] = encodeReturn((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function makeReturnDecoder(
  returns: { cap?: CapDef<any, any> } | undefined,
  spawn: (cap: CapDef<any, any>, capId: number) => unknown
): ReturnDecoder | undefined {
  if (!returns) return undefined;
  if (isCapRef(returns)) {
    const inner = returns.cap;
    return (raw) => {
      if (!(raw instanceof CapRef)) throw new IpcError({ code: "protocol_error", message: "expected CapRef" });
      return spawn(inner, raw.capId);
    };
  }
  if (isCapArray(returns)) {
    const inner = returns.cap;
    const disposal = inner.disposal as DisposalSpec | undefined;
    return (raw) => {
      if (!Array.isArray(raw)) throw new IpcError({ code: "protocol_error", message: "expected array" });
      const proxies = raw.map((item) => {
        if (!(item instanceof CapRef)) throw new IpcError({ code: "protocol_error", message: "expected CapRef in array" });
        return spawn(inner, item.capId);
      });
      attachArrayDisposal(proxies, disposal);
      return proxies;
    };
  }
  if (isCapRecord(returns)) {
    const inner = returns.cap;
    return (raw) => {
      if (!raw || typeof raw !== "object") throw new IpcError({ code: "protocol_error", message: "expected record" });
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(raw as object)) {
        const item = (raw as Record<string, unknown>)[k];
        if (!(item instanceof CapRef)) throw new IpcError({ code: "protocol_error", message: "expected CapRef in record" });
        out[k] = spawn(inner, item.capId);
      }
      return out;
    };
  }
  return undefined;
}

function attachArrayDisposal(arr: unknown[], disposal: DisposalSpec | undefined): void {
  if (!disposal) return;
  const sym = disposal.async ? Symbol.asyncDispose : Symbol.dispose;
  (arr as any)[sym] = disposal.async
    ? () => Promise.all(arr.map((proxy) => {
        const fn = (proxy as Record<symbol, unknown>)[Symbol.asyncDispose] as (() => Promise<void>) | undefined;
        return fn ? fn.call(proxy) : undefined;
      })).then(() => undefined)
    : () => {
        for (const proxy of arr) {
          const fn = (proxy as Record<symbol, unknown>)[Symbol.dispose] as (() => void) | undefined;
          fn?.call(proxy);
        }
      };
}

function toStatus(err: unknown): IpcStatus {
  if (err instanceof IpcError) return err.toStatus();
  if (err instanceof Error) return { code: "unknown", message: err.message };
  return { code: "unknown", message: String(err) };
}

interface ClientStreamHandle<T> {
  stream: StreamType<T>;
  push(chunk: unknown): void;
  end(): void;
  fail(error: IpcError): void;
}

function makeClientStream<T>(
  streamId: number,
  cancel: () => void,
  sendCredit: (messages: number) => void
): ClientStreamHandle<T> {
  const buffer: T[] = [];
  const waiters: Array<{ resolve(r: IteratorResult<T>): void; reject(e: Error): void }> = [];
  let ended = false;
  let failure: IpcError | null = null;
  let cancelled = false;
  let consumedSinceCredit = 0;

  function tally() {
    consumedSinceCredit += 1;
    if (consumedSinceCredit >= DEFAULT_STREAM_CREDIT_BATCH) {
      sendCredit(consumedSinceCredit);
      consumedSinceCredit = 0;
    }
  }

  function pump(): IteratorResult<T> | null {
    if (buffer.length > 0) {
      const value = buffer.shift()!;
      tally();
      return { value, done: false };
    }
    if (failure) return null;
    if (ended || cancelled) return { value: undefined as unknown as T, done: true };
    return null;
  }

  function next(): Promise<IteratorResult<T>> {
    const immediate = pump();
    if (immediate) return Promise.resolve(immediate);
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  }

  function drainWaiters(): void {
    while (waiters.length > 0) {
      const w = waiters.shift()!;
      const r = pump();
      if (r) { w.resolve(r); continue; }
      if (failure) { w.reject(failure); continue; }
      waiters.unshift(w);
      break;
    }
  }

  function doCancel(): void {
    if (cancelled || ended || failure) return;
    cancelled = true;
    cancel();
    drainWaiters();
  }

  const stream: StreamType<T> = {
    [Symbol.asyncIterator]: () => ({
      next,
      return: () => {
        doCancel();
        return Promise.resolve({ value: undefined as unknown as T, done: true });
      },
      throw: (err: unknown) => {
        doCancel();
        return Promise.reject(err);
      },
    }),
    [Symbol.dispose]: doCancel,
    cancel: doCancel,
  } as StreamType<T>;
  void streamId;

  return {
    stream,
    push(chunk) {
      if (cancelled || ended || failure) return;
      buffer.push(chunk as T);
      drainWaiters();
    },
    end() {
      ended = true;
      drainWaiters();
    },
    fail(error) {
      failure = error;
      drainWaiters();
    },
  };
}

export function createConnection(opts: ConnectionOptions): Connection & ConnectionImpl {
  return new ConnectionImpl(opts) as Connection & ConnectionImpl;
}
