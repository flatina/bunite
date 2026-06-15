import type { WsData } from "bunite-core";
import { serveWeb } from "bunite-core";
import { type ImplOf, IpcError, Stream } from "bunite-core/rpc";
import { BridgeCap, SessionCap, type Task, type TaskEvent } from "./schema";

type UserState = {
  tasks: Map<string, Task>;
  subs: Set<(e: TaskEvent) => void>;
};
const users = new Map<string, UserState>();
function userState(userId: string): UserState {
  let s = users.get(userId);
  if (!s) {
    s = { tasks: new Map(), subs: new Set() };
    users.set(userId, s);
  }
  return s;
}

function makeSessionImpl(userId: string): ImplOf<typeof SessionCap> {
  const state = userState(userId);
  const broadcast = (e: TaskEvent) => {
    for (const fn of state.subs) fn(e);
  };

  return {
    whoami: () => ({ userId }),
    tasks: () => Array.from(state.tasks.values()),
    add: ({ title }) => {
      const trimmed = title.trim();
      if (!trimmed) throw new IpcError({ code: "invalid_argument", message: "title required" });
      const task: Task = { id: crypto.randomUUID(), title: trimmed, done: false };
      state.tasks.set(task.id, task);
      broadcast({ type: "added", task });
      return task;
    },
    toggle: ({ id }) => {
      const t = state.tasks.get(id);
      if (!t) throw new IpcError({ code: "not_found", message: id });
      t.done = !t.done;
      broadcast({ type: "toggled", id, done: t.done });
    },
    edit: ({ id, title }) => {
      const trimmed = title.trim();
      if (!trimmed) throw new IpcError({ code: "invalid_argument", message: "title required" });
      const t = state.tasks.get(id);
      if (!t) throw new IpcError({ code: "not_found", message: id });
      t.title = trimmed;
      broadcast({ type: "edited", id, title: trimmed });
    },
    remove: ({ id }) => {
      if (!state.tasks.delete(id)) throw new IpcError({ code: "not_found", message: id });
      broadcast({ type: "removed", id });
    },
    events: () =>
      Stream.from((emit, signal) => {
        state.subs.add(emit);
        signal.addEventListener("abort", () => state.subs.delete(emit));
      }),
  };
}

interface AuthData extends WsData {
  userId: string | null;
}

function parseUserCookie(cookie: string): string | null {
  const m = cookie.match(/(?:^|;\s*)user=([^;]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

// Bundle renderer once at startup.
const rendererJs = await (async () => {
  const out = await Bun.build({
    entrypoints: ["src/renderer/index.ts"],
    target: "browser",
  });
  if (!out.success) throw new Error(out.logs.join("\n"));
  return await out.outputs[0]!.text();
})();
const indexHtml = await Bun.file("src/renderer/index.html").text();
const stylesCss = await Bun.file("src/renderer/styles.css").text();
const html = indexHtml.replace("/*STYLES*/", stylesCss).replace("/*BUNDLE*/", rendererJs);

const mount = serveWeb<AuthData>(
  (conn, data) => {
    conn.serve(BridgeCap, {
      openSession: (_, ctx) => {
        if (!data.userId) {
          throw new IpcError({
            code: "failed_precondition",
            message: "not signed in",
            details: { reason: "unauthorized" },
          });
        }
        return ctx.exportCap(SessionCap, makeSessionImpl(data.userId));
      },
    });
  },
  {
    onUpgrade: (req) => ({
      userId: parseUserCookie(req.headers.get("cookie") ?? ""),
    }),
  },
);

const port = Number(process.env.PORT ?? 3000);
Bun.serve({
  hostname: "127.0.0.1",
  port,
  routes: {
    "/login": {
      POST: async (req) => {
        const form = await req.formData();
        const user = String(form.get("user") ?? "").trim();
        if (!user) return new Response("user required", { status: 400 });
        return new Response(null, {
          status: 302,
          headers: {
            "set-cookie": `user=${encodeURIComponent(user)}; Path=/; HttpOnly; SameSite=Strict`,
            location: "/",
          },
        });
      },
    },
    "/logout": () =>
      new Response(null, {
        status: 302,
        headers: { "set-cookie": "user=; Path=/; Max-Age=0", location: "/" },
      }),
  },
  fetch(req, srv) {
    const rpc = mount.fetch(req, srv);
    if (rpc !== undefined) return rpc;
    const path = new URL(req.url).pathname;
    if (path === "/" || path === "/index.html") {
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("Not Found", { status: 404 });
  },
  websocket: mount.websocket,
});

console.log(`session-todo listening on http://127.0.0.1:${port}`);
