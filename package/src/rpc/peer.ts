import {
  type CapDef,
  type Schema,
  type SchemaRoots,
  type ClientOf,
  type ImplOf,
  type ImplsOf,
  type CallCtx,
  type Attestation,
  type ExportedCap,
  type MethodDef,
  type AnyCapToken,
  type Stream as StreamType,
  type DisposalSpec,
  isCallDef,
  isStreamDef,
  isCapRef,
  isCapArray,
  isCapRecord,
  isCapDef,
  isSchema,
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
  type CapRevokedFrame,
  type CallMeta,
  CapRef,
  DEFAULT_MAX_BYTES,
  PROTOCOL_VERSION,
  FRAMEWORK_NAME_PREFIX,
  BOOTSTRAP_METHOD,
} from "./wire";
import {
  IpcError,
  type IpcStatus,
  type IpcCode,
  type FailedPreconditionReason,
  type ResourceExhaustedReason,
  type AlreadyExistsReason,
} from "./error";

export const USER_ROOTS_CAP_ID = 0;
export const RUNTIME_CAP_ID = 1;
export const USER_ROOTS_TYPE_ID = 0;
export const RUNTIME_TYPE_ID = 1;

export const FIRST_USER_CAP_ID = 2;
export const FIRST_USER_TYPE_ID = 128;

export const MAX_CAPS_PER_CONNECTION = 1024;
export const MAX_IN_FLIGHT_CALLS_PER_CONNECTION = 1024;
/** Client-side LRU cap for revoked cap-ids — prevents unbounded growth on long-lived connections with frequent plugin churn (e.g. downstream). */
const REVOKED_CACHE_SIZE = MAX_CAPS_PER_CONNECTION * 4;

const DEFAULT_DEADLINE_GRACE_MS = 500;
const DEFAULT_STREAM_INITIAL_CREDIT = 32;
const DEFAULT_STREAM_CREDIT_BATCH = 8;
const MAX_STREAM_INITIAL_CREDIT = 1024;

function resolveStreamBudget(hint: Record<string, unknown> | undefined): number {
  const raw = hint?.initialBudget;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) {
    return DEFAULT_STREAM_INITIAL_CREDIT;
  }
  return Math.min(raw, MAX_STREAM_INITIAL_CREDIT);
}

interface CallScope {
  readonly callId: number;
}

export interface CallContextStorage {
  getStore(): CallScope | undefined;
  run<R>(store: CallScope, fn: () => R): R;
}

let callContextStorage: CallContextStorage | null = null;

export function _setCallContextStorage(als: CallContextStorage | null): void {
  callContextStorage = als;
}

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
      throw new IpcError({
        code: "resource_exhausted",
        message: `cap-table limit ${this.capLimit}`,
        details: { reason: "max_caps_per_connection" as ResourceExhaustedReason },
      });
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

  delete(capId: number): boolean {
    if (capId < FIRST_USER_CAP_ID) return false;
    return this.entries.delete(capId);
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

export type Policy = (name: string, attestation: Attestation) => boolean | Promise<boolean>;

export type IfExists = "throw" | "replace" | "skip";

export interface ServeHandle extends Disposable {
  readonly names: readonly string[];
}

export interface ConnectionEvents {
  bootstrap: { name: string; version?: string; attestation: Attestation; result: "ok" | "denied" | "not_found" | "version_mismatch" | "invalid_argument" | "resource_exhausted" | "internal"; capId?: number };
  call: { capId: number; capName?: string; method: string; callId: number; durationMs?: number; result: "ok" | "cancelled" | IpcCode };
  stream: { capId: number; capName?: string; method: string; callId: number; event: "start" | "end" | "cancel" | "error"; count?: number };
  revoke: { capIds: number[]; reason: "unserve" | "replace" };
  error: { phase: string; error: Error };
}

export interface Connection {
  bootstrap<C extends CapDef<any, any>>(cap: C): Promise<ClientOf<C>>;
  bootstrap<R extends SchemaRoots>(schema: Schema<R>): Promise<{ [K in keyof R]: ClientOf<R[K]> }>;
  serve<C extends CapDef<any, any>>(cap: C, impl: ImplOf<C>, opts?: { ifExists?: IfExists }): ServeHandle;
  serveAll<R extends SchemaRoots>(schema: Schema<R>, impls: ImplsOf<R>, opts?: { ifExists?: IfExists }): ServeHandle;
  unserve(target: CapDef<any, any> | ServeHandle): void;
  replace<C extends CapDef<any, any>>(cap: C, impl: ImplOf<C>): void;
  runtime(): ClientOf<typeof RuntimeCap>;
  releaseRef(proxy: unknown): void;
  on<K extends keyof ConnectionEvents>(event: K, handler: (e: ConnectionEvents[K]) => void): () => void;
  onClose(handler: () => void): () => void;
  /** Tear down the connection — rejects pending, fires onClose, closes transport. Reliable signal for application lifecycle. */
  shutdown(reason?: string): void;
  readonly closed: boolean;
}

export interface ConnectionOptions {
  transport: Transport;
  mode: "native" | "web";
  origin: string;
  features?: string[];
  maxBytes?: number;
  capLimit?: number;
  maxInFlightCalls?: number;
  peerId?: string;
  attestation?: Attestation;
  runtime?: ImplOf<typeof RuntimeCap>;
  policy?: Policy;
}

export interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  abort: AbortController;
  decodeReturn?: ReturnDecoder;
  timer?: ReturnType<typeof setTimeout>;
  startedAt?: number;
  capId?: number;
  capName?: string;
  method?: string;
  kind?: "call" | "stream";
}

type ReturnDecoder = (raw: unknown) => unknown;

// Default is conservative: "untrusted" until the host explicitly hands a real attestation
// (engine-mined for native, derived from req origin for web). Policy hooks should treat absence as deny-able.
const DEFAULT_ATTESTATION: Attestation = {
  origin: "",
  topOrigin: "",
  partition: "default",
  isAppRes: false,
  isMainFrame: false,
  userGesture: false,
  level: "untrusted",
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

interface ServerStreamCtx {
  iter: AsyncIterator<unknown> | null;
  abort: AbortController;
  cancelled: boolean;
  credit: number;
  creditWaker: (() => void) | null;
  capId: number;
  capName?: string;
  method: string;
  callId: number;
  count: number;
}

interface ClientStreamCtx {
  capId: number;
  push(chunk: unknown): void;
  end(): void;
  fail(error: IpcError): void;
}

interface RegistryEntry {
  cap: CapDef<any, any>;
  impl: unknown;
  version?: string;
}

class ConnectionImpl implements Connection {
  private readonly transport: Transport;
  private readonly capTable: CapTable;
  private readonly pending = new Map<number, PendingCall>();
  private readonly clientStreams = new Map<number, ClientStreamCtx>();
  private readonly serverStreams = new Map<number, ServerStreamCtx>();
  private readonly serverCallChildren = new Map<number, { parentId: number }>();
  private readonly serverActiveCalls = new Map<number, { ctrl: AbortController; capId: number; capName: string; method: string; startedAt: number }>();
  /** Server-side: name → registry entry. */
  private readonly registry = new Map<string, RegistryEntry>();
  /** Server-side: name → instance cap-id (cached bootstrap result). */
  private readonly rootInstances = new Map<string, number>();
  /** Client-side: cap-ids that the server revoked via cap_revoked. */
  private readonly revokedCapIds = new Set<number>();
  private readonly closeHandlers = new Set<() => void>();
  private readonly observers: { [K in keyof ConnectionEvents]?: Set<(e: ConnectionEvents[K]) => void> } = {};
  private nextCallId = 1;
  private remoteHello: HelloFrame | null = null;
  private readonly remoteReady: Promise<HelloFrame>;
  private resolveRemoteReady!: (h: HelloFrame) => void;
  private rejectRemoteReady!: (e: Error) => void;
  private closed_ = false;
  private readonly maxBytes: number;
  private readonly maxInFlightCalls: number;
  private readonly mode: "native" | "web";
  private readonly origin: string;
  private readonly features: string[];
  private readonly attestation: Attestation;
  private readonly peerId: string;
  private readonly policy: Policy | undefined;

  constructor(opts: ConnectionOptions) {
    this.transport = opts.transport;
    this.mode = opts.mode;
    this.origin = opts.origin;
    this.features = opts.features ?? [];
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxInFlightCalls = opts.maxInFlightCalls ?? MAX_IN_FLIGHT_CALLS_PER_CONNECTION;
    this.attestation = opts.attestation ?? DEFAULT_ATTESTATION;
    this.peerId = opts.peerId ?? "peer";
    this.policy = opts.policy;
    this.capTable = new CapTable(opts.capLimit ?? MAX_CAPS_PER_CONNECTION);

    // cap-id 0 = bootstrap dispatcher (no cap def — special-cased in handleCall)
    this.capTable.install(USER_ROOTS_CAP_ID, {
      typeId: USER_ROOTS_TYPE_ID,
      cap: null,
      impl: null,
      refCount: 1,
    });
    // cap-id 1 = Runtime instance (framework-stable, pre-installed)
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

  on<K extends keyof ConnectionEvents>(event: K, handler: (e: ConnectionEvents[K]) => void): () => void {
    let set = this.observers[event] as Set<(e: ConnectionEvents[K]) => void> | undefined;
    if (!set) {
      set = new Set();
      (this.observers as Record<string, Set<unknown>>)[event] = set as unknown as Set<unknown>;
    }
    set.add(handler);
    return () => { set!.delete(handler); };
  }

  private emitObs<K extends keyof ConnectionEvents>(event: K, data: ConnectionEvents[K]): void {
    const set = this.observers[event] as Set<(e: ConnectionEvents[K]) => void> | undefined;
    if (!set || set.size === 0) return;
    for (const h of set) {
      try { h(data); } catch { /* swallow */ }
    }
  }

  private markRevoked(capId: number): void {
    // Set preserves insertion order — drop oldest when at cap.
    this.revokedCapIds.add(capId);
    while (this.revokedCapIds.size > REVOKED_CACHE_SIZE) {
      const oldest = this.revokedCapIds.values().next().value;
      if (oldest === undefined) break;
      this.revokedCapIds.delete(oldest);
    }
  }

  // ---- serve / unserve / replace ----

  serve<C extends CapDef<any, any>>(cap: C, impl: ImplOf<C>, opts?: { ifExists?: IfExists }): ServeHandle {
    this.assertNotFrameworkName(cap.name);
    const ifExists = opts?.ifExists ?? "throw";
    const existing = this.registry.get(cap.name);
    if (existing) {
      switch (ifExists) {
        case "throw":
          throw new IpcError({
            code: "already_exists",
            message: `cap "${cap.name}" already served`,
            details: { reason: "name_collision" as AlreadyExistsReason },
          });
        case "skip":
          // Empty handle: skipping means we are not the owner — unserve must not revoke someone else's registration.
          return this.makeHandle([]);
        case "replace":
          this.replace(cap, impl);
          return this.makeHandle([cap.name]);
      }
    }
    this.registry.set(cap.name, { cap, impl, version: cap.version });
    return this.makeHandle([cap.name]);
  }

  private makeHandle(names: string[]): ServeHandle {
    const handle: ServeHandle = {
      names,
      [Symbol.dispose]: () => this.unserve(handle),
    };
    return handle;
  }

  serveAll<R extends SchemaRoots>(schema: Schema<R>, impls: ImplsOf<R>, opts?: { ifExists?: IfExists }): ServeHandle {
    const ifExists = opts?.ifExists ?? "throw";
    // Pre-validate everything that can fail across all modes before mutating any state (atomicity).
    for (const k of Object.keys(schema.roots)) {
      const c = schema.roots[k];
      this.assertNotFrameworkName(c.name);
      const existing = this.registry.get(c.name);
      if (existing) {
        if (ifExists === "throw") {
          throw new IpcError({
            code: "already_exists",
            message: `cap "${c.name}" already served`,
            details: { reason: "name_collision" as AlreadyExistsReason },
          });
        }
        if (ifExists === "replace" && existing.version !== c.version) {
          throw new IpcError({
            code: "failed_precondition",
            message: `version mismatch on replace for "${c.name}" (current "${existing.version}", new "${c.version}")`,
            details: { reason: "version_mismatch" as FailedPreconditionReason },
          });
        }
      }
    }
    // Mutations below cannot fail (pre-validation already cleared collision/version/prefix paths).
    const names: string[] = [];
    for (const k of Object.keys(schema.roots)) {
      const c = schema.roots[k];
      const i = (impls as Record<string, unknown>)[k];
      const h = this.serve(c, i as ImplOf<typeof c>, { ifExists });
      // serve(...) returns empty names[] only for skipped entries — exclude from the aggregate handle.
      if (h.names.length > 0) names.push(c.name);
    }
    return this.makeHandle(names);
  }

  unserve(target: CapDef<any, any> | ServeHandle): void {
    const names = isCapDef(target) ? [target.name] : Array.from((target as ServeHandle).names);
    const revoked: number[] = [];
    for (const name of names) {
      if (!this.registry.delete(name)) continue;
      const instId = this.rootInstances.get(name);
      if (instId !== undefined) {
        const entry = this.capTable.get(instId);
        if (entry) this.invokeServerDisposal(entry);
        this.rootInstances.delete(name);
        this.capTable.delete(instId);
        revoked.push(instId);
      }
    }
    if (revoked.length > 0) {
      this.transport.send({ op: "cap_revoked", capIds: revoked });
      this.emitObs("revoke", { capIds: revoked, reason: "unserve" });
    }
  }

  replace<C extends CapDef<any, any>>(cap: C, impl: ImplOf<C>): void {
    const entry = this.registry.get(cap.name);
    if (!entry) throw new IpcError({ code: "not_found", message: `cap "${cap.name}" not served` });
    if (entry.version !== cap.version) {
      throw new IpcError({
        code: "failed_precondition",
        message: `version mismatch (current "${entry.version}", new "${cap.version}")`,
        details: { reason: "version_mismatch" as FailedPreconditionReason },
      });
    }
    entry.impl = impl;
    entry.cap = cap;
    const instId = this.rootInstances.get(cap.name);
    if (instId !== undefined) {
      const e = this.capTable.get(instId);
      if (e) { e.impl = impl; e.cap = cap; }
    }
    this.emitObs("revoke", { capIds: instId !== undefined ? [instId] : [], reason: "replace" });
  }

  private assertNotFrameworkName(name: string): void {
    if (name.startsWith(FRAMEWORK_NAME_PREFIX)) {
      throw new IpcError({
        code: "already_exists",
        message: `cap name "${name}" uses reserved prefix "${FRAMEWORK_NAME_PREFIX}"`,
        details: { reason: "reserved_namespace" as AlreadyExistsReason },
      });
    }
  }

  // ---- runtime / bootstrap ----

  private runtimeProxy: ClientOf<typeof RuntimeCap> | null = null;

  runtime(): ClientOf<typeof RuntimeCap> {
    if (!this.runtimeProxy) {
      this.runtimeProxy = this.makeCapProxy(RuntimeCap, RUNTIME_CAP_ID);
    }
    return this.runtimeProxy;
  }

  bootstrap<C extends CapDef<any, any>>(cap: C): Promise<ClientOf<C>>;
  bootstrap<R extends SchemaRoots>(schema: Schema<R>): Promise<{ [K in keyof R]: ClientOf<R[K]> }>;
  async bootstrap(target: CapDef<any, any> | Schema<any>): Promise<unknown> {
    if (isCapDef(target)) return this._bootstrapCap(target);
    if (isSchema(target)) return this._bootstrapSchema(target);
    throw new IpcError({ code: "invalid_argument", message: "bootstrap target must be CapDef or Schema" });
  }

  private async _bootstrapCap<C extends CapDef<any, any>>(cap: C): Promise<ClientOf<C>> {
    await this.remoteReady;
    const args: { name: string; version?: string } = { name: cap.name };
    if (cap.version != null) args.version = cap.version;
    const raw = await this.sendCallTyped(USER_ROOTS_CAP_ID, BOOTSTRAP_METHOD, args, undefined);
    if (!(raw instanceof CapRef)) {
      throw new IpcError({ code: "invalid_argument", message: "bootstrap did not return a CapRef" });
    }
    return this.makeCapProxy(cap, raw.capId) as ClientOf<C>;
  }

  private async _bootstrapSchema<R extends SchemaRoots>(
    schema: Schema<R>
  ): Promise<{ [K in keyof R]: ClientOf<R[K]> }> {
    const keys = Object.keys(schema.roots) as (keyof R & string)[];
    const settled = await Promise.allSettled(keys.map((k) => this._bootstrapCap(schema.roots[k])));
    const rejected = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (rejected) {
      // Release server refCount on the roots that succeeded — otherwise their cap-table entries linger until connection close.
      for (const r of settled) {
        if (r.status === "fulfilled") {
          try { this.releaseRef(r.value); } catch { /* swallow */ }
        }
      }
      throw rejected.reason;
    }
    const out = {} as { [K in keyof R]: ClientOf<R[K]> };
    for (let i = 0; i < keys.length; i++) {
      (out as Record<string, unknown>)[keys[i]] = (settled[i] as PromiseFulfilledResult<unknown>).value;
    }
    return out;
  }

  // ---- frame dispatch ----

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
      case "cap_revoked":
        this.handleCapRevoked(frame);
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
      this.transport.send({ op: "result", id, ok: false, error: { code: "invalid_argument", message: "unknown opcode" } });
      return;
    }
    this.transport.send({ op: "goaway", reason: "invalid_argument", error: { code: "invalid_argument", message: "unknown opcode" } });
    this.shutdown("invalid_argument");
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

  private handleCapRevoked(frame: CapRevokedFrame): void {
    for (const capId of frame.capIds) {
      this.markRevoked(capId);
      const err = new IpcError({
        code: "failed_precondition",
        message: "cap revoked",
        details: { reason: "revoked" as FailedPreconditionReason },
      });
      // Fail pending calls targeting this cap.
      for (const [id, p] of this.pending) {
        if (p.capId === capId) {
          this.pending.delete(id);
          if (p.timer) clearTimeout(p.timer);
          p.reject(err);
        }
      }
      // Fail active client streams targeting this cap — "revoked wins" symmetric with calls.
      for (const [id, s] of this.clientStreams) {
        if (s.capId === capId) {
          this.clientStreams.delete(id);
          s.fail(err);
        }
      }
    }
  }

  private async handleCall(frame: CallFrame): Promise<void> {
    if (frame.target.id === USER_ROOTS_CAP_ID && frame.method === BOOTSTRAP_METHOD) {
      await this.handleBootstrap(frame);
      return;
    }

    const entry = this.capTable.get(frame.target.id);
    if (!entry) {
      this.emitObs("call", { capId: frame.target.id, method: frame.method, callId: frame.id, result: "not_found" });
      return this.sendError(frame.id, "not_found", `cap-id ${frame.target.id} not found`);
    }

    const cap = entry.cap;
    if (!cap || !entry.impl) {
      this.emitObs("call", { capId: frame.target.id, method: frame.method, callId: frame.id, result: "not_found" });
      return this.sendError(frame.id, "not_found", "cap has no impl");
    }

    const methodDef = cap.methods[frame.method] as MethodDef | undefined;
    if (!methodDef) {
      this.emitObs("call", { capId: frame.target.id, capName: cap.name, method: frame.method, callId: frame.id, result: "not_found" });
      return this.sendError(frame.id, "not_found", `method "${frame.method}" on cap "${cap.name}"`);
    }
    const impl = (entry.impl as Record<string, unknown>)[frame.method];
    if (typeof impl !== "function") {
      this.emitObs("call", { capId: frame.target.id, capName: cap.name, method: frame.method, callId: frame.id, result: "not_found" });
      return this.sendError(frame.id, "not_found", `method "${frame.method}" has no handler`);
    }

    // Bound inbound work — symmetric with sendCallTyped's outbound check.
    if (this.serverActiveCalls.size + this.serverStreams.size >= this.maxInFlightCalls) {
      this.emitObs("call", { capId: frame.target.id, capName: cap.name, method: frame.method, callId: frame.id, result: "resource_exhausted" });
      return this.sendError(
        frame.id,
        "resource_exhausted",
        `in-flight calls limit ${this.maxInFlightCalls}`,
        { reason: "max_concurrent_calls" as ResourceExhaustedReason },
      );
    }

    await this.invokeServerMethod(frame, cap, methodDef, impl as (params: unknown, ctx: CallCtx) => unknown);
  }

  private async handleBootstrap(frame: CallFrame): Promise<void> {
    const args = (frame.args ?? {}) as { name?: unknown; version?: unknown };
    const name = args.name;
    if (typeof name !== "string") {
      this.emitObs("bootstrap", { name: String(name), attestation: this.attestation, result: "invalid_argument" });
      return this.sendError(frame.id, "invalid_argument", "bootstrap requires {name: string}");
    }
    const clientVersion = args.version != null ? String(args.version) : undefined;

    // Framework caps (cap-id 1 Runtime is pre-installed and accessed via .runtime(),
    // not via bootstrap). For user-facing bootstrap, only the registry is consulted.
    const entry = this.registry.get(name);
    if (!entry) {
      this.emitObs("bootstrap", { name, version: clientVersion, attestation: this.attestation, result: "not_found" });
      return this.sendError(frame.id, "not_found", `cap "${name}" not served`);
    }

    const serverVersion = entry.version;
    if (serverVersion != null && clientVersion != null && serverVersion !== clientVersion) {
      this.emitObs("bootstrap", { name, version: clientVersion, attestation: this.attestation, result: "version_mismatch" });
      return this.sendError(
        frame.id,
        "failed_precondition",
        `version mismatch (server "${serverVersion}", client "${clientVersion}")`,
        { reason: "version_mismatch" as FailedPreconditionReason }
      );
    }

    if (this.policy) {
      let allowed: boolean | Promise<boolean>;
      try {
        allowed = await this.policy(name, this.attestation);
      } catch (err) {
        this.emitObs("error", { phase: "policy", error: err instanceof Error ? err : new Error(String(err)) });
        this.emitObs("bootstrap", { name, version: clientVersion, attestation: this.attestation, result: "internal" });
        return this.sendError(frame.id, "internal", "policy threw");
      }
      if (typeof allowed !== "boolean") {
        // Non-boolean return = programming bug; surface explicitly (not silent deny).
        this.emitObs("error", { phase: "policy", error: new Error(`policy must return boolean (got ${typeof allowed})`) });
        this.emitObs("bootstrap", { name, version: clientVersion, attestation: this.attestation, result: "internal" });
        return this.sendError(frame.id, "internal", "policy returned non-boolean");
      }
      if (!allowed) {
        this.emitObs("bootstrap", { name, version: clientVersion, attestation: this.attestation, result: "denied" });
        return this.sendError(
          frame.id,
          "failed_precondition",
          "policy denied",
          { reason: "unauthorized" as FailedPreconditionReason }
        );
      }
    }

    let capId = this.rootInstances.get(name);
    if (capId !== undefined) {
      const cached = this.capTable.get(capId);
      if (cached) {
        cached.refCount += 1;
      } else {
        this.rootInstances.delete(name);
        capId = undefined;
      }
    }
    if (capId === undefined) {
      try {
        const allocated = this.capTable.allocate({
          typeId: frameworkTypeIdOf(entry.cap) ?? FIRST_USER_TYPE_ID,
          cap: entry.cap,
          impl: entry.impl,
          refCount: 1,
        });
        capId = allocated.capId;
        this.rootInstances.set(name, capId);
      } catch (err) {
        if (err instanceof IpcError) {
          const result = err.code === "resource_exhausted" ? "resource_exhausted" : "internal";
          this.emitObs("bootstrap", { name, version: clientVersion, attestation: this.attestation, result });
          return this.sendError(frame.id, err.code, err.message, err.details as Record<string, unknown> | undefined);
        }
        throw err;
      }
    }
    this.emitObs("bootstrap", { name, version: clientVersion, attestation: this.attestation, result: "ok", capId });
    this.transport.send({ op: "result", id: frame.id, ok: true, value: new CapRef(capId) });
  }

  private async invokeServerMethod(
    frame: CallFrame,
    cap: CapDef<any, any>,
    methodDef: MethodDef,
    impl: (params: unknown, ctx: CallCtx) => unknown
  ): Promise<void> {
    const ctx = this.makeCallCtx(frame);

    if (isStreamDef(methodDef)) {
      const hintBudget = resolveStreamBudget(methodDef.hint);
      try {
        const runStream = () => impl(frame.args, ctx) as StreamType<unknown>;
        const als = callContextStorage;
        const scoped = als
          ? () => als.run({ callId: frame.id }, runStream)
          : runStream;
        const stream = scoped();
        this.runServerStream(frame.id, stream, ctx, hintBudget, cap, frame.method, frame.target.id);
      } catch (err) {
        this.emitObs("stream", { capId: frame.target.id, capName: cap.name, method: frame.method, callId: frame.id, event: "error" });
        this.transport.send({ op: "stream", id: frame.id, ev: "error", error: toStatus(err) });
      }
      return;
    }

    if (isCallDef(methodDef)) {
      const startedAt = performance.now();
      const deadlineTimer = methodDef.idempotent ? undefined : this.armServerDeadline(frame, ctx);
      this.serverActiveCalls.set(frame.id, {
        ctrl: (ctx as unknown as { _ctrl: AbortController })._ctrl,
        capId: frame.target.id,
        capName: cap.name,
        method: frame.method,
        startedAt,
      });
      const encoder = makeReturnEncoder(methodDef.returns);
      const runImpl = () => Promise.resolve(impl(frame.args, ctx));
      const als = callContextStorage;
      const scoped = als
        ? () => als.run({ callId: frame.id }, runImpl)
        : runImpl;
      try {
        const result = await scoped();
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (!this.serverActiveCalls.delete(frame.id)) return;
        const encoded = encoder(result);
        this.transport.send({ op: "result", id: frame.id, ok: true, value: encoded });
        this.emitObs("call", { capId: frame.target.id, capName: cap.name, method: frame.method, callId: frame.id, durationMs: performance.now() - startedAt, result: "ok" });
      } catch (err) {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (!this.serverActiveCalls.delete(frame.id)) return;
        const status = toStatus(err);
        this.sendErrorFromStatus(frame.id, status);
        this.emitObs("call", { capId: frame.target.id, capName: cap.name, method: frame.method, callId: frame.id, durationMs: performance.now() - startedAt, result: status.code });
      }
      return;
    }

    this.sendError(frame.id, "not_found", "unknown method kind");
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
      _ctrl: ctrl,
      exportCap: (capDef, impl) => this.exportCap(capDef, impl),
    };
    return ctx;
  }

  private exportCap<C extends CapDef<any, any>>(capDef: C, impl: unknown): ExportedCap<C> {
    const typeId = frameworkTypeIdOf(capDef) ?? FIRST_USER_TYPE_ID;
    const entry = this.capTable.allocate({
      typeId,
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

  private runServerStream(
    callId: number,
    stream: StreamType<unknown>,
    ctx: CallCtx,
    initialCredit: number,
    cap: CapDef<any, any>,
    method: string,
    capId: number,
  ): void {
    const iter = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    const abort = (ctx as unknown as { _ctrl: AbortController })._ctrl;
    const slot: ServerStreamCtx = {
      iter,
      abort,
      cancelled: false,
      credit: initialCredit,
      creditWaker: null,
      capId,
      capName: cap.name,
      method,
      callId,
      count: 0,
    };
    this.serverStreams.set(callId, slot);
    this.emitObs("stream", { capId, capName: cap.name, method, callId, event: "start" });

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
          slot.count += 1;
          this.transport.send({ op: "stream", id: callId, ev: "next", value });
        }
      } catch (err) {
        errored = true;
        this.transport.send({ op: "stream", id: callId, ev: "error", error: toStatus(err) });
        this.emitObs("stream", { capId, capName: cap.name, method, callId, event: "error", count: slot.count });
      } finally {
        if (!errored) {
          this.transport.send({ op: "stream", id: callId, ev: "end" });
          this.emitObs("stream", { capId, capName: cap.name, method, callId, event: slot.cancelled ? "cancel" : "end", count: slot.count });
        }
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
        ? new IpcError({ code: "invalid_argument", message: "stream method returned result frame" })
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
      active.ctrl.abort();
      this.transport.send({
        op: "result",
        id: frame.id,
        ok: false,
        error: { code: "cancelled", message: frame.reason },
      });
      this.emitObs("call", {
        capId: active.capId,
        capName: active.capName,
        method: active.method,
        callId: frame.id,
        durationMs: performance.now() - active.startedAt,
        result: "cancelled",
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
    if (typeof proxy !== "object" || proxy === null) return;
    const meta = (proxy as Record<symbol, unknown>)[CAP_PROXY_META] as { capId: number; dropped: boolean } | undefined;
    if (!meta || meta.dropped) return;
    meta.dropped = true;
    this.sendDrop(meta.capId);
  }

  private sendDrop(capId: number): void {
    if (this.closed_) return;
    if (capId < FIRST_USER_CAP_ID) return;
    this.transport.send({ op: "drop", caps: [{ id: capId, delta: 1 }] });
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

  private sendError(callId: number, code: IpcCode, message?: string, details?: unknown): void {
    const error: IpcStatus = { code, message };
    if (details !== undefined) error.details = details;
    this.transport.send({ op: "result", id: callId, ok: false, error });
  }

  private sendErrorFromStatus(callId: number, status: IpcStatus): void {
    this.transport.send({ op: "result", id: callId, ok: false, error: status });
  }

  private nextId(): number {
    return this.nextCallId++;
  }

  sendCallTyped(
    capId: number,
    method: string,
    args: unknown,
    decodeReturn: ReturnDecoder | undefined,
    meta?: CallMeta,
    capName?: string,
  ): Promise<unknown> {
    if (this.closed_) return Promise.reject(new IpcError({ code: "unavailable", message: "connection closed" }));
    if (this.revokedCapIds.has(capId)) {
      return Promise.reject(new IpcError({
        code: "failed_precondition",
        message: "cap revoked",
        details: { reason: "revoked" as FailedPreconditionReason },
      }));
    }
    if (this.pending.size >= this.maxInFlightCalls) {
      return Promise.reject(new IpcError({
        code: "resource_exhausted",
        message: `in-flight calls limit ${this.maxInFlightCalls}`,
        details: { reason: "max_concurrent_calls" as ResourceExhaustedReason },
      }));
    }
    const id = this.nextId();
    return new Promise((resolve, reject) => {
      const abort = new AbortController();
      const pending: PendingCall = {
        resolve, reject, abort, decodeReturn,
        startedAt: performance.now(),
        capId, method, capName,
        kind: "call",
      };
      if (meta?.deadlineMs) {
        pending.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            this.transport.send({ op: "cancel", id, reason: "deadline_exceeded" });
            reject(new IpcError({ code: "deadline_exceeded" }));
          }
        }, meta.deadlineMs + DEFAULT_DEADLINE_GRACE_MS);
      }
      this.pending.set(id, pending);
      let finalMeta = meta;
      if ((finalMeta?.parentCallId === undefined) && callContextStorage) {
        const scope = callContextStorage.getStore();
        if (scope) finalMeta = { ...(finalMeta ?? {}), parentCallId: scope.callId };
      }
      if (finalMeta?.parentCallId !== undefined) {
        this.serverCallChildren.set(id, { parentId: finalMeta.parentCallId });
      }
      this.transport.send({ op: "call", id, target: { kind: "cap", id: capId }, method, args, meta: finalMeta });
    });
  }

  openClientStream<T>(
    capId: number,
    method: string,
    args: unknown,
    meta?: CallMeta,
    capName?: string,
  ): StreamType<T> {
    if (this.closed_) {
      const empty = makeClientStream<T>(capId, 0, () => {}, () => {});
      empty.fail(new IpcError({ code: "unavailable", message: "connection closed" }));
      return empty.stream;
    }
    if (this.revokedCapIds.has(capId)) {
      const empty = makeClientStream<T>(capId, 0, () => {}, () => {});
      empty.fail(new IpcError({
        code: "failed_precondition",
        message: "cap revoked",
        details: { reason: "revoked" as FailedPreconditionReason },
      }));
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
    const ctx = makeClientStream<T>(capId, id, cancel, sendCredit);
    this.clientStreams.set(id, ctx);
    this.transport.send({ op: "call", id, target: { kind: "cap", id: capId }, method, args, meta });
    void capName;
    return ctx.stream;
  }

  makeCapProxy<C extends CapDef<any, any>>(capDef: C, capId: number): ClientOf<C> {
    const proxy: Record<string | symbol, unknown> = {};
    const meta = { capId, dropped: false };
    proxy[CAP_PROXY_META] = meta;
    const drop = () => {
      if (meta.dropped) return;
      meta.dropped = true;
      this.sendDrop(capId);
    };

    for (const name of Object.keys(capDef.methods)) {
      const def = capDef.methods[name] as MethodDef;
      if (isStreamDef(def)) {
        proxy[name] = (params?: unknown) => this.openClientStream(capId, name, params, undefined, capDef.name);
      } else if (isCallDef(def)) {
        const decoder = makeReturnDecoder(def.returns, (cd, cid) => this.makeCapProxy(cd, cid));
        proxy[name] = (params?: unknown) => this.sendCallTyped(capId, name, params, decoder, undefined, capDef.name);
      }
    }

    const disposal = capDef.disposal as DisposalSpec | undefined;
    if (disposal) {
      const conn = this;
      proxy[Symbol.dispose] = () => {
        try {
          const r = (proxy[disposal.method] as (() => unknown) | undefined)?.();
          if (r && typeof (r as Promise<unknown>).then === "function") {
            (r as Promise<unknown>).catch((err) =>
              conn.emitObs("error", { phase: "dispose", error: err instanceof Error ? err : new Error(String(err)) })
            );
          }
        } catch (err) {
          conn.emitObs("error", { phase: "dispose", error: err instanceof Error ? err : new Error(String(err)) });
        }
        drop();
      };
    }

    if (typeof FinalizationRegistry !== "undefined") {
      proxyFinalizers.register(proxy as object, {
        connRef: new WeakRef(this),
        capId,
        dropped: () => meta.dropped,
      });
    }

    return proxy as ClientOf<C>;
  }

  _dropFromFinalizer(capId: number): void {
    try { this.sendDrop(capId); } catch { /* swallow */ }
  }

  shutdown(reason: string = "shutdown"): void {
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
    for (const a of this.serverActiveCalls.values()) {
      a.ctrl.abort();
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

function makeReturnEncoder(returns: AnyCapToken | undefined): (v: unknown) => unknown {
  if (!returns) return (v) => v;
  const expectExportedCap = (v: unknown, expectedCap: CapDef<any, any>): CapRef => {
    if (!isExportedCap(v)) {
      throw new IpcError({
        code: "failed_precondition",
        message: "expected ctx.exportCap return for cap method",
        details: { reason: "unregistered_cap_return" as FailedPreconditionReason },
      });
    }
    if (v.cap !== expectedCap) {
      throw new IpcError({
        code: "failed_precondition",
        message: "exported cap type mismatch with method returns",
        details: { reason: "unregistered_cap_return" as FailedPreconditionReason },
      });
    }
    return new CapRef(v.capId);
  };
  if (isCapRef(returns)) return (v) => expectExportedCap(v, returns.cap);
  if (isCapArray(returns)) {
    return (v) => {
      if (!Array.isArray(v)) {
        throw new IpcError({ code: "invalid_argument", message: "expected ExportedCap[] for cap.array method" });
      }
      return v.map((item) => expectExportedCap(item, returns.cap));
    };
  }
  if (isCapRecord(returns)) {
    return (v) => {
      if (!v || typeof v !== "object") {
        throw new IpcError({ code: "invalid_argument", message: "expected Record<string, ExportedCap> for cap.record method" });
      }
      const out: Record<string, CapRef> = {};
      for (const k of Object.keys(v as object)) {
        out[k] = expectExportedCap((v as Record<string, unknown>)[k], returns.cap);
      }
      return out;
    };
  }
  return (v) => v;
}

function makeReturnDecoder(
  returns: { cap?: CapDef<any, any> } | undefined,
  spawn: (cap: CapDef<any, any>, capId: number) => unknown
): ReturnDecoder | undefined {
  if (!returns) return undefined;
  if (isCapRef(returns)) {
    const inner = returns.cap;
    return (raw) => {
      if (!(raw instanceof CapRef)) throw new IpcError({ code: "invalid_argument", message: "expected CapRef" });
      return spawn(inner, raw.capId);
    };
  }
  if (isCapArray(returns)) {
    const inner = returns.cap;
    const disposal = inner.disposal as DisposalSpec | undefined;
    return (raw) => {
      if (!Array.isArray(raw)) throw new IpcError({ code: "invalid_argument", message: "expected array" });
      const proxies = raw.map((item) => {
        if (!(item instanceof CapRef)) throw new IpcError({ code: "invalid_argument", message: "expected CapRef in array" });
        return spawn(inner, item.capId);
      });
      attachArrayDisposal(proxies, disposal);
      return proxies;
    };
  }
  if (isCapRecord(returns)) {
    const inner = returns.cap;
    return (raw) => {
      if (!raw || typeof raw !== "object") throw new IpcError({ code: "invalid_argument", message: "expected record" });
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(raw as object)) {
        const item = (raw as Record<string, unknown>)[k];
        if (!(item instanceof CapRef)) throw new IpcError({ code: "invalid_argument", message: "expected CapRef in record" });
        out[k] = spawn(inner, item.capId);
      }
      return out;
    };
  }
  return undefined;
}

function attachArrayDisposal(arr: unknown[], disposal: DisposalSpec | undefined): void {
  if (!disposal) return;
  (arr as any)[Symbol.dispose] = () => {
    for (const proxy of arr) {
      const fn = (proxy as Record<symbol, unknown>)[Symbol.dispose] as (() => void) | undefined;
      fn?.call(proxy);
    }
  };
}

function toStatus(err: unknown): IpcStatus {
  if (err instanceof IpcError) return err.toStatus();
  if (err instanceof Error) return { code: "internal", message: err.message };
  return { code: "internal", message: String(err) };
}

interface ClientStreamHandle<T> {
  capId: number;
  stream: StreamType<T>;
  push(chunk: unknown): void;
  end(): void;
  fail(error: IpcError): void;
}

function makeClientStream<T>(
  capId: number,
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
    capId,
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
