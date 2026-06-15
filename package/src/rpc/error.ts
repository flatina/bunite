export type IpcCode =
  | "not_found"
  | "failed_precondition"
  | "already_exists"
  | "invalid_argument"
  | "cancelled"
  | "deadline_exceeded"
  | "resource_exhausted"
  | "unavailable"
  | "internal";

export type FailedPreconditionReason =
  | "version_mismatch"
  | "unauthorized"
  | "unregistered_cap_return"
  | "revoked";

export type ResourceExhaustedReason =
  | "max_frame_bytes"
  | "max_concurrent_calls"
  | "max_caps_per_connection"
  | "stream_credit_window"
  | "rate_limited";

export type UnavailableReason = "peer_closing" | "goaway" | "plugin_unloading";

export type AlreadyExistsReason = "name_collision" | "reserved_namespace";

export type RetrySpec =
  | { kind: "never" }
  | { kind: "transparent" }
  | { kind: "after-cooldown"; minMs: number }
  | { kind: "after-resync" };

export interface IpcStatus {
  code: IpcCode;
  message?: string;
  details?: unknown;
  retry?: RetrySpec;
}

export class IpcError extends Error {
  readonly code: IpcCode;
  readonly details: unknown;
  readonly retry?: RetrySpec;

  constructor(status: IpcStatus) {
    super(status.message ?? status.code);
    this.name = "IpcError";
    this.code = status.code;
    this.details = status.details;
    this.retry = status.retry;
  }

  toStatus(): IpcStatus {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      retry: this.retry,
    };
  }
}
