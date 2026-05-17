import { call, cap, defineCap } from "bunite-core/rpc";

/** Anyone, anywhere can call openSession with the right credential for their mode. */
export const SessionCap = defineCap("auth-bridge.Session", {
  whoami: call<void, { userId: string; source: "web" | "native" | "resume" }>({ idempotent: true }),
  /** Server-issued, bound to this user. Caller stashes it to resume later. */
  getResumeToken: call<void, string>(),
  count: call<void, number>({ idempotent: true }),
  bump: call<void, number>(),
});

/** Three trust tiers — each verifies its credential, then mints the same SessionCap. */
export const BridgeCap = defineCap("auth-bridge.Bridge", {
  /** Web mode: caller supplies a token verified server-side (here: a hardcoded demo map). */
  createWebSession: call<{ token: string }, typeof SessionCap>({ returns: cap(SessionCap) }),

  /** Native mode: no credential needed — the bunite preload connection's `app-internal`
   *  attestation is the proof. WebSocket clients fail this gate because their attestation
   *  level is `untrusted`. */
  createDesktopSession: call<void, typeof SessionCap>({ returns: cap(SessionCap) }),

  /** Web mode resume: caller supplies a token previously returned by createWebSession,
   *  bound to a userId in the server's session table. */
  resumeSession: call<{ resumeToken: string }, typeof SessionCap>({ returns: cap(SessionCap) }),
});
