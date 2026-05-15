const CALL_TAG = Symbol("CallDef");
const STREAM_TAG = Symbol("StreamDef");
const CAP_TAG = Symbol("CapDef");
const CAP_REF_TAG = Symbol("CapRefToken");
const CAP_ARRAY_TAG = Symbol("CapArrayToken");
const CAP_RECORD_TAG = Symbol("CapRecordToken");
const SCHEMA_TAG = Symbol("Schema");
declare const EXPORTED_CAP_BRAND: unique symbol;

export type ReturnsKind = "type" | "cap" | "capArray" | "capRecord";

export type CapRefToken<C extends CapDef<any, any>> = {
  readonly [CAP_REF_TAG]: true;
  readonly cap: C;
};

export type CapArrayToken<C extends CapDef<any, any>> = {
  readonly [CAP_ARRAY_TAG]: true;
  readonly cap: C;
};

export type CapRecordToken<C extends CapDef<any, any>> = {
  readonly [CAP_RECORD_TAG]: true;
  readonly cap: C;
};

export type AnyCapToken<C extends CapDef<any, any> = CapDef<any, any>> =
  | CapRefToken<C>
  | CapArrayToken<C>
  | CapRecordToken<C>;

function _cap<C extends CapDef<any, any>>(c: C): CapRefToken<C> {
  return { [CAP_REF_TAG]: true, cap: c };
}
_cap.array = <C extends CapDef<any, any>>(c: C): CapArrayToken<C> => ({ [CAP_ARRAY_TAG]: true, cap: c });
_cap.record = <C extends CapDef<any, any>>(c: C): CapRecordToken<C> => ({ [CAP_RECORD_TAG]: true, cap: c });
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

export function call<P, C extends CapDef<any, any>>(
  opts: { returns: CapRefToken<C>; idempotent?: boolean }
): CallDef<P, CapRefToken<C>>;
export function call<P, C extends CapDef<any, any>>(
  opts: { returns: CapArrayToken<C>; idempotent?: boolean }
): CallDef<P, CapArrayToken<C>>;
export function call<P, C extends CapDef<any, any>>(
  opts: { returns: CapRecordToken<C>; idempotent?: boolean }
): CallDef<P, CapRecordToken<C>>;
export function call<P = void, R = void>(opts?: { idempotent?: boolean }): CallDef<P, R>;
export function call(opts?: { idempotent?: boolean; returns?: AnyCapToken }): CallDef<any, any> {
  return {
    [CALL_TAG]: true,
    idempotent: !!opts?.idempotent,
    returns: opts?.returns,
  };
}

export function stream<P = void, Y = unknown>(opts?: { hint?: Record<string, unknown> }): StreamDef<P, Y> {
  return { [STREAM_TAG]: true, hint: opts?.hint };
}

export interface DisposalSpec<M extends MethodsRecord = MethodsRecord> {
  method: keyof M & string;
  async?: boolean;
}

export type MethodsRecord = Record<string, MethodDef>;

export interface CapDef<M extends MethodsRecord = MethodsRecord, D extends DisposalSpec<M> | undefined = undefined> {
  readonly [CAP_TAG]: true;
  readonly methods: M;
  readonly disposal: D;
}

export function defineCap<M extends MethodsRecord, D extends DisposalSpec<M> | undefined = undefined>(
  methods: M,
  opts?: { disposal?: D }
): CapDef<M, D> {
  return {
    [CAP_TAG]: true,
    methods,
    disposal: (opts?.disposal as D) ?? (undefined as D),
  };
}

export function isCapDef(v: unknown): v is CapDef {
  return typeof v === "object" && v !== null && (v as any)[CAP_TAG] === true;
}

export interface SchemaShape {
  roots: Record<string, CapDef<any, any>>;
  caps?: readonly CapDef<any, any>[];
}

export interface Schema<S extends SchemaShape = SchemaShape> {
  readonly [SCHEMA_TAG]: true;
  readonly roots: S["roots"];
  readonly caps: readonly CapDef<any, any>[];
  topologyHash(): Promise<string>;
  serve(impls: ImplsOf<S>): ServerDescriptor<S>;
}

export type ImplsOf<S extends SchemaShape> = {
  [K in keyof S["roots"]]: ImplOf<S["roots"][K]>;
};

export interface ServerDescriptor<S extends SchemaShape = SchemaShape> {
  readonly schema: Schema<S>;
  readonly impls: ImplsOf<S>;
}

export function defineSchema<S extends SchemaShape>(shape: S): Schema<S> {
  const schema: Schema<S> = {
    [SCHEMA_TAG]: true,
    roots: shape.roots,
    caps: shape.caps ?? [],
    topologyHash: () => topologyHashImpl(schema),
    serve(impls) {
      return { schema, impls };
    },
  };
  return schema;
}

let topologyHashImpl: (s: Schema<any>) => Promise<string> = () => {
  throw new Error("schema.topologyHash bound after hash.ts import");
};

export function _bindTopologyHash(fn: (s: Schema<any>) => Promise<string>) {
  topologyHashImpl = fn;
}

export function isSchema(v: unknown): v is Schema {
  return typeof v === "object" && v !== null && (v as any)[SCHEMA_TAG] === true;
}

export interface ExportedCap<C extends CapDef<any, any>> {
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
  context?: Record<string, string>;
  exportCap<C extends CapDef<any, any>>(capDef: C, impl: ImplOf<C>): ExportedCap<C>;
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
  R extends CapRefToken<infer C> ? ExportedCap<C> :
  R extends CapArrayToken<infer C> ? ExportedCap<C>[] :
  R extends CapRecordToken<infer C> ? Record<string, ExportedCap<C>> :
  R;

export type ClientReturn<R> =
  R extends CapRefToken<infer C> ? ClientOf<C> :
  R extends CapArrayToken<infer C> ?
    C extends CapDef<any, infer D>
      ? [D] extends [{ async: true }] ? ClientOf<C>[] & AsyncDisposable
      : [D] extends [DisposalSpec] ? ClientOf<C>[] & Disposable
      : ClientOf<C>[]
    : ClientOf<C>[] :
  R extends CapRecordToken<infer C> ? Record<string, ClientOf<C>> :
  R;

export type Stream<T> = AsyncIterable<T> & Disposable & { cancel(): void };

export type ClientOf<T> = T extends CapDef<infer M, infer D>
  ? {
      [K in keyof M]: M[K] extends CallDef<infer P, infer R>
        ? [P] extends [void] ? () => Promise<ClientReturn<R>>
        : (params: P) => Promise<ClientReturn<R>>
        : M[K] extends StreamDef<infer P, infer Y>
          ? [P] extends [void] ? () => Stream<Y>
          : (params: P) => Stream<Y>
          : never;
    } & ([D] extends [{ async: true }] ? AsyncDisposable : [D] extends [DisposalSpec] ? Disposable : {})
  : never;

export type ImplOf<T> = T extends CapDef<infer M, any>
  ? {
      [K in keyof M]: M[K] extends CallDef<infer P, infer R>
        ? (params: P, ctx: CallCtx) => MaybePromise<ServerReturn<R>>
        : M[K] extends StreamDef<infer P, infer Y>
          ? (params: P, ctx: CallCtx) => Stream<Y>
          : never;
    }
  : never;

export function methodKeys(cap: CapDef<any, any>): string[] {
  return Object.keys(cap.methods);
}
