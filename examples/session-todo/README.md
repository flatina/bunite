# session-todo

Per-user todo with cookie auth, served entirely over WebSocket. A small but realistic
example of how to scope capabilities by user: the renderer never declares "who I am" —
the server mints a `SessionCap` with the authenticated user baked into closure scope.

## Run

```sh
bun src/main.ts
# open http://127.0.0.1:3000, pick a username, add some todos
```

Open the same URL in a second tab with the same username — task changes propagate live.
Pick a different username and the tasks are isolated.

## Key patterns

**Anonymous bridge → server-mint session cap.** `BridgeCap.openSession`
(`src/schema.ts`) is the only cap callable before sign-in. Its impl
(`src/main.ts`) checks the cookie-derived `userId`; on success it returns
`ctx.exportCap(SessionCap, makeSessionImpl(userId))`. The renderer never
gets to declare its identity — it just calls `bridge.openSession()` and
either gets a SessionCap or a `failed_precondition` rejection.

**Identity via closure-capture.** `makeSessionImpl(userId)` is a factory:
the returned impl methods read `userId` as a free variable, not from
`ctx`. The cap *is* the identity — there's no way for the client to
forge it, and no race window where identity is "not yet set".

**Auth via `serveWeb<TData>` + `onUpgrade`.** Cookie parsing happens once
at WebSocket upgrade time; the result is passed to the setup callback
as `data.userId`. A real app would use a signed token instead of the
raw username, but the wiring is the same.

**Streams for fan-out.** `SessionCap.events()` returns a stream of
`TaskEvent`s. The impl registers the emit callback in a per-user set;
broadcasts deliver to every subscribed tab. When a tab disconnects the
stream's abort signal removes its callback.

## What this does *not* show

- Multi-trust-tier auth (web token vs native attestation vs resume) —
  see `examples/auth-bridge`.
- Cap-returning sub-caps with disposal — task mutations here are
  id-based and don't need their own capability. Use a sub-cap only
  when you have a transient resource with explicit teardown.
