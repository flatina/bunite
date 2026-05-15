import { registerBuniteWebviewPolyfill } from "../shared/webviewPolyfill";

export { registerBuniteWebviewPolyfill };

export {
  call,
  stream,
  cap,
  defineCap,
  defineSchema,
  IpcError,
  RuntimeCap,
  SurfaceCap,
} from "../shared/rpc/index";

export { Stream } from "../shared/rpc/server";

export type {
  Schema,
  SchemaShape,
  ServerDescriptor,
  ImplsOf,
  CapDef,
  CallDef,
  StreamDef,
  CallCtx,
  ClientOf,
  ImplOf,
  ExportedCap,
  IpcCode,
  IpcStatus,
  RetrySpec,
  FailedPreconditionReason,
  AnyCapToken,
  ReturnsKind,
  Attestation,
} from "../shared/rpc/index";

registerBuniteWebviewPolyfill();
