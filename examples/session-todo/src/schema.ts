import { call, cap, defineCap, stream } from "bunite-core/rpc";

export type Task = { id: string; title: string; done: boolean };

export type TaskEvent =
  | { type: "added"; task: Task }
  | { type: "toggled"; id: string; done: boolean }
  | { type: "edited"; id: string; title: string }
  | { type: "removed"; id: string };

export const SessionCap = defineCap("todo.Session", {
  whoami: call<void, { userId: string }>({ idempotent: true }),
  tasks: call<void, Task[]>({ idempotent: true }),
  add: call<{ title: string }, Task>(),
  toggle: call<{ id: string }, void>(),
  edit: call<{ id: string; title: string }, void>(),
  remove: call<{ id: string }, void>(),
  events: stream<void, TaskEvent>(),
});

/** Anonymous entry — `openSession` mints a SessionCap with the authenticated userId baked into closure. */
export const BridgeCap = defineCap("todo.Bridge", {
  openSession: call<void, typeof SessionCap>({ returns: cap(SessionCap) }),
});
