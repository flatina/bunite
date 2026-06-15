// Symbol.for() — shared identity across separately-built bundles (preload vs renderer).
const CALL_TAG = Symbol.for("bunite.rpc.CallDef");
const STREAM_TAG = Symbol.for("bunite.rpc.StreamDef");
const CAP_TAG = Symbol.for("bunite.rpc.CapDef");
const CAP_REF_TAG = Symbol.for("bunite.rpc.CapRefToken");
const CAP_ARRAY_TAG = Symbol.for("bunite.rpc.CapArrayToken");
const CAP_RECORD_TAG = Symbol.for("bunite.rpc.CapRecordToken");
const SCHEMA_TAG = Symbol.for("bunite.rpc.Schema");
declare const EXPORTED_CAP_BRAND: unique symbol;

export type ReturnsKind = "type" | "cap" | "capArray" | "capRecord";

export type CapRefToken<C extends AnyCapDef> = {
  readonly [CAP_REF_TAG]: true;
  readonly cap: C;
};

export type CapArrayToken<C extends AnyCapDef> = {
  readonly [CAP_ARRAY_TAG]: true;
  readonly cap: C;
};

export type CapRecordToken<C extends AnyCapDef> = {
  readonly [CAP_RECORD_TAG]: true;
  readonly cap: C;
};

export type AnyCapToken<C extends AnyCapDef = AnyCapDef> =
  | CapRefToken<C>
  | CapArrayToken<C>
  | CapRecordToken<C>;

function _cap<C extends AnyCapDef>(c: C): CapRefToken<C> {
  return { [CAP_REF_TAG]: true, cap: c };
}
_cap.array = <C extends AnyCapDef>(c: C): CapArrayToken<C> => ({
  [CAP_ARRAY_TAG]: true,
  cap: c,
});
_cap.record = <C extends AnyCapDef>(c: C): CapRecordToken<C> => ({
  [CAP_RECORD_TAG]: true,
  cap: c,
});
export const cap = _cap;

export function isCapRef(v: unknown): v is CapRefToken<any> {
  return typeof v === "object" && v !== null && (v as any)[CAP_REF_TAG] === true;
}
export function isCapArray(v: unknown): v is CapArrayToken<any> {
  return typeof v === "object" && v !== null && (v as any)[CAP_ARRAY_TAG] === true;
}
export function isCapRecord(v: unknown): v is CapRecordToken<any> {
  return typeof v === "object" && v !== null && (v as any)[CAP_RECORD_TAG] === true;
}
export function returnsKindOf(v: unknown): ReturnsKind {
  if (isCapRef(v)) return "cap";
  if (isCapArray(v)) return "capArray";
  if (isCapRecord(v)) return "capRecord";
  return "type";
}

export interface CallDef<P = unknown, R = unknown> {
  readonly [CALL_TAG]: true;
  readonly idempotent: boolean;
  readonly returns?: AnyCapToken;
  readonly _phantom?: (p: P) => R;
}

export interface StreamDef<P = unknown, Y = unknown> {
  readonly [STREAM_TAG]: true;
  readonly hint?: Record<string, unknown>;
  readonly _phantom?: (p: P) => Y;
}

export type MethodDef = CallDef<any, any> | StreamDef<any, any>;

export function isCallDef(v: unknown): v is CallDef {
  return typeof v === "object" && v !== null && (v as any)[CALL_TAG] === true;
}
export function isStreamDef(v: unknown): v is StreamDef {
  return typeof v === "object" && v !== null && (v as any)[STREAM_TAG] === true;
}

export function call<P, C extends AnyCapDef>(opts: {
  returns: CapRefToken<C>;
  idempotent?: boolean;
}): CallDef<P, CapRefToken<C>>;
export function call<P, C extends AnyCapDef>(opts: {
  returns: CapArrayToken<C>;
  idempotent?: boolean;
}): CallDef<P, CapArrayToken<C>>;
export function call<P, C extends AnyCapDef>(opts: {
  returns: CapRecordToken<C>;
  idempotent?: boolean;
}): CallDef<P, CapRecordToken<C>>;
export function call<P = void, R = void>(opts?: { idempotent?: boolean }): CallDef<P, R>;
export function call(opts?: { idempotent?: boolean; returns?: AnyCapToken }): CallDef<any, any> {
  return {
    [CALL_TAG]: true,
    idempotent: !!opts?.idempotent,
    returns: opts?.returns,
  };
}

export function stream<P = void, Y = unknown>(opts?: {
  hint?: Record<string, unknown>;
}): StreamDef<P, Y> {
  return { [STREAM_TAG]: true, hint: opts?.hint };
}

// Disposal: method only. Sync Disposable — wire drop is fire-and-forget.
export interface DisposalSpec<M extends MethodsRecord = MethodsRecord> {
  method: keyof M & string;
}

export type MethodsRecord = Record<string, MethodDef>;

export interface CapDef<
  M extends MethodsRecord = MethodsRecord,
  D extends DisposalSpec<M> | undefined = undefined,
> {
  readonly [CAP_TAG]: true;
  readonly name: string;
  readonly version?: string;
  readonly methods: M;
  readonly disposal: D;
}

export type AnyCapDef = CapDef<any, any>;

export interface DefineCapOpts<M extends MethodsRecord, D extends DisposalSpec<M> | undefined> {
  version?: string | number;
  disposal?: D;
}

export function defineCap<
  M extends MethodsRecord,
  D extends DisposalSpec<M> | undefined = undefined,
>(name: string, methods: M, opts?: DefineCapOpts<M, D>): CapDef<M, D> {
  return {
    [CAP_TAG]: true,
    name,
    version: opts?.version != null ? String(opts.version) : undefined,
    methods,
    disposal: (opts?.disposal as D) ?? (undefined as D),
  };
}

export function isCapDef(v: unknown): v is CapDef {
  return typeof v === "object" && v !== null && (v as any)[CAP_TAG] === true;
}

// Schema = grouping sugar (Record<rootName, CapDef>). TS atomicity for serveAll.
export type SchemaRoots = Record<string, AnyCapDef>;

export interface Schema<R extends SchemaRoots = SchemaRoots> {
  readonly [SCHEMA_TAG]: true;
  readonly roots: R;
}

export type ImplsOf<R extends SchemaRoots> = {
  [K in keyof R]: ImplOf<R[K]>;
};

export function defineSchema<R extends SchemaRoots>(roots: R): Schema<R> {
  return { [SCHEMA_TAG]: true, roots };
}

export function isSchema(v: unknown): v is Schema {
  return typeof v === "object" && v !== null && (v as any)[SCHEMA_TAG] === true;
}

export interface ExportedCap<C extends AnyCapDef> {
  readonly [EXPORTED_CAP_BRAND]: true;
  readonly cap: C;
  readonly capId: number;
  readonly typeId: number;
}

export interface CallCtx {
  callId: number;
  peerId: string;
  attestation: Attestation;
  signal: AbortSignal;
  deadline?: number;
  exportCap<C extends AnyCapDef>(capDef: C, impl: ImplOf<C>): ExportedCap<C>;
}

export interface Attestation {
  origin: string;
  topOrigin: string;
  partition: string;
  isAppRes: boolean;
  isMainFrame: boolean;
  userGesture: boolean;
  level: "app-internal" | "trusted-origin" | "untrusted";
}

type MaybePromise<T> = T | Promise<T>;

type ServerReturn<R> =
  R extends CapRefToken<infer C>
    ? ExportedCap<C>
    : R extends CapArrayToken<infer C>
      ? ExportedCap<C>[]
      : R extends CapRecordToken<infer C>
        ? Record<string, ExportedCap<C>>
        : R;

export type ClientReturn<R> =
  R extends CapRefToken<infer C>
    ? ClientOf<C>
    : R extends CapArrayToken<infer C>
      ? C extends CapDef<any, infer D>
        ? [D] extends [DisposalSpec]
          ? ClientOf<C>[] & Disposable
          : ClientOf<C>[]
        : ClientOf<C>[]
      : R extends CapRecordToken<infer C>
        ? Record<string, ClientOf<C>>
        : R;

export type Stream<T> = AsyncIterable<T> & Disposable & { cancel(): void };

export type ClientOf<T> =
  T extends CapDef<infer M, infer D>
    ? {
        [K in keyof M]: M[K] extends CallDef<infer P, infer R>
          ? [P] extends [void]
            ? () => Promise<ClientReturn<R>>
            : (params: P) => Promise<ClientReturn<R>>
          : M[K] extends StreamDef<infer P, infer Y>
            ? [P] extends [void]
              ? () => Stream<Y>
              : (params: P) => Stream<Y>
            : never;
      } & ([D] extends [DisposalSpec] ? Disposable : unknown)
    : never;

export type ImplOf<T> =
  T extends CapDef<infer M, any>
    ? {
        [K in keyof M]: M[K] extends CallDef<infer P, infer R>
          ? (params: P, ctx: CallCtx) => MaybePromise<ServerReturn<R>>
          : M[K] extends StreamDef<infer P, infer Y>
            ? (params: P, ctx: CallCtx) => Stream<Y>
            : never;
      }
    : never;

export function methodKeys(cap: AnyCapDef): string[] {
  return Object.keys(cap.methods);
}
