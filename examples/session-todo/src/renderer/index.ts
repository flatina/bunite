import { bootstrap } from "bunite-core/rpc/renderer";
import { IpcError, type ClientOf } from "bunite-core/rpc";
import { BridgeCap, type SessionCap, type Task, type TaskEvent } from "../schema";

const $ = <T extends Element = HTMLElement>(s: string): T => document.querySelector<T>(s)!;
const login = $("#login");
const app = $("#app");
const userBar = $("#user-bar");
const whoami = $<HTMLSpanElement>("#whoami");
const titleInput = $<HTMLInputElement>("#title");
const addBtn = $<HTMLButtonElement>("#add");
const list = $<HTMLDivElement>("#list");

const bridge = await bootstrap(BridgeCap);

let session: ClientOf<typeof SessionCap>;
try {
  session = await bridge.openSession();
} catch (e) {
  if (e instanceof IpcError && e.code === "failed_precondition") {
    login.hidden = false;
  } else {
    login.hidden = false;
    console.error("openSession failed:", e);
  }
  throw e;
}

app.hidden = false;
userBar.hidden = false;
whoami.textContent = (await session.whoami()).userId;

const tasks = new Map<string, Task>();
for (const t of await session.tasks()) tasks.set(t.id, t);
render();

void (async () => {
  try {
    for await (const ev of session.events()) {
      applyEvent(tasks, ev);
      render();
    }
  } catch (e) {
    console.error("events stream ended:", e);
  }
})();


const submit = () => {
  const title = titleInput.value.trim();
  if (!title) return;
  titleInput.value = "";
  session.add({ title }).catch((e) => console.error("add failed:", e));
};
addBtn.addEventListener("click", submit);
titleInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

function render(): void {
  list.replaceChildren(...Array.from(tasks.values(), renderRow));
}

function renderRow(t: Task): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "task" + (t.done ? " done" : "");

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = t.done;
  cb.addEventListener("change", () => {
    session.toggle({ id: t.id }).catch((e) => console.error("toggle failed:", e));
  });

  const title = document.createElement("span");
  title.className = "title";
  title.textContent = t.title;
  title.addEventListener("dblclick", () => {
    const next = prompt("edit", t.title);
    if (next != null && next.trim() && next !== t.title) {
      session.edit({ id: t.id, title: next }).catch((e) => console.error("edit failed:", e));
    }
  });

  const rm = document.createElement("button");
  rm.className = "remove";
  rm.textContent = "×";
  rm.addEventListener("click", () => {
    session.remove({ id: t.id }).catch((e) => console.error("remove failed:", e));
  });

  row.append(cb, title, rm);
  return row;
}

function applyEvent(tasks: Map<string, Task>, ev: TaskEvent): void {
  switch (ev.type) {
    case "added": tasks.set(ev.task.id, ev.task); break;
    case "toggled": { const t = tasks.get(ev.id); if (t) t.done = ev.done; break; }
    case "edited":  { const t = tasks.get(ev.id); if (t) t.title = ev.title; break; }
    case "removed": tasks.delete(ev.id); break;
  }
}
