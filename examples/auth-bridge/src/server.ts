import { type ImplOf, IpcError } from "bunite-core/rpc";
import { type BridgeCap, SessionCap } from "./schema";

/** Per-user counter — shared across tabs / sessions for the same userId. */
const counts = new Map<string, number>();
function bump(userId: string): number {
  const next = (counts.get(userId) ?? 0) + 1;
  counts.set(userId, next);
  return next;
}

/** Demo credential stores. A real app would use signed tokens, not maps. */
const webTokens = new Map<string, string>([
  ["t-alice", "alice"],
  ["t-bob", "bob"],
]);
const resumeTokens = new Map<string, string>();

function issueResumeToken(userId: string): string {
  const t = `r-${crypto.randomUUID()}`;
  resumeTokens.set(t, userId);
  return t;
}

function makeSessionImpl(
  userId: string,
  source: "web" | "native" | "resume",
): ImplOf<typeof SessionCap> {
  return {
    whoami: () => ({ userId, source }),
    getResumeToken: () => issueResumeToken(userId),
    count: () => counts.get(userId) ?? 0,
    bump: () => bump(userId),
  };
}

export function makeBridgeImpl(): ImplOf<typeof BridgeCap> {
  return {
    createWebSession: ({ token }, ctx) => {
      const userId = webTokens.get(token);
      if (!userId) {
        throw new IpcError({
          code: "failed_precondition",
          message: "invalid token",
          details: { reason: "unauthorized" },
        });
      }
      return ctx.exportCap(SessionCap, makeSessionImpl(userId, "web"));
    },

    createDesktopSession: (_, ctx) => {
      // Native preload connection: attestation is engine-mined, unforgeable.
      // WebSocket callers arrive with `level: "untrusted"` → reject.
      if (ctx.attestation.level !== "app-internal") {
        throw new IpcError({
          code: "failed_precondition",
          message: `desktop session requires app-internal attestation (got ${ctx.attestation.level})`,
          details: { reason: "unauthorized" },
        });
      }
      return ctx.exportCap(SessionCap, makeSessionImpl("desktop-owner", "native"));
    },

    resumeSession: ({ resumeToken }, ctx) => {
      const userId = resumeTokens.get(resumeToken);
      if (!userId) {
        throw new IpcError({
          code: "failed_precondition",
          message: "unknown or expired resume token",
          details: { reason: "unauthorized" },
        });
      }
      return ctx.exportCap(SessionCap, makeSessionImpl(userId, "resume"));
    },
  };
}
