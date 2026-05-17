# auth-bridge

The same `SessionCap` minted by three different trust paths. Demonstrates how
a bunite app can serve both web and desktop modes from one bridge, without
ever letting the client declare its own identity.

## Run

```sh
# Web mode (default, no native binary needed):
bun src/web.ts
# open http://127.0.0.1:3000, paste `t-alice` or `t-bob`

# Native mode (Windows, requires CEF — see operations.md):
bun src/native.ts
# the desktop session auto-authenticates via bunite attestation
```

## Trust paths

| Method | Credential | When |
|---|---|---|
| `createWebSession({token})` | Caller-supplied token, server-verified | WS-mounted web app, cookie/token auth |
| `createDesktopSession()` | `ctx.attestation.level === "app-internal"` | Preload-injected renderer in a BrowserWindow |
| `resumeSession({resumeToken})` | Previously-issued resume token | Continuity across reloads — token issued by `session.getResumeToken()`, stashed by the client (here: localStorage) |

All three return the same `SessionCap` shape. The caller can't tell — and shouldn't
care — which path was used; the server's `whoami()` exposes it for the demo.

## Why three methods, not one?

Each trust path has a *different* credential type and verification rule. Modeling
them as separate methods makes the trust contract visible in the schema (and lets
TypeScript enforce the right argument shape per path). It also keeps the impl
clear: each branch does exactly one credential check.

The alternative — a single `createSession({mode, token?})` — collapses the trust
distinction into a runtime tag, which is exactly the kind of "guess what the
caller meant" anti-pattern bunite is trying to avoid.

## Native mode gate

`createDesktopSession` rejects WebSocket callers because `serveWeb`'s connection
attestation is `"untrusted"`. The preload-injected renderer inside a
`BrowserWindow` arrives with `"app-internal"` (set by `BrowserView.attachNewConnection`),
which is unforgeable from JS. Calling `createDesktopSession` from `bun src/web.ts`
fails; calling it from `bun src/native.ts` succeeds.

## What this does *not* show

- A live multi-user session (see `examples/session-todo` for cookie-auth scope).
- Streaming events / sub-cap chains — kept off here so the trust-tier mechanics
  stay the focus.
