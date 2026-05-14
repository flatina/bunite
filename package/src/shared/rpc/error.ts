export const IPC_CODES = [
  "ok",
  "cancelled",
  "unknown",
  "invalid_argument",
  "deadline_exceeded",
  "not_found",
  "not_supported",
  "already_exists",
  "permission_denied",
  "unauthenticated",
  "resource_exhausted",
  "failed_precondition",
  "unavailable",
  "protocol_error",
] as const;

export type IpcCode = (typeof IPC_CODES)[number];

export type FailedPreconditionReason =
  | "cap_disposed"
  | "cap_revoked"
  | "owner_disconnect"
  | "protocol_violation";

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

export function ipcError(code: IpcCode, message?: string, details?: unknown, retry?: RetrySpec): IpcError {
  return new IpcError({ code, message, details, retry });
}
