import { bootstrap } from "bunite-core/rpc/renderer";
import { schema, type LogEntry } from "./schema";

const aInput = document.getElementById("a") as HTMLInputElement;
const bInput = document.getElementById("b") as HTMLInputElement;
const opSelect = document.getElementById("op") as HTMLSelectElement;
const resultEl = document.getElementById("result")!;
const logEl = document.getElementById("log")!;
const goBtn = document.getElementById("go")!;

goBtn.setAttribute("disabled", "true");

const calc = await bootstrap(schema, "calc");
const log = await bootstrap(schema, "log");

goBtn.removeAttribute("disabled");

goBtn.addEventListener("click", async () => {
  const a = Number(aInput.value);
  const b = Number(bInput.value);
  const op = opSelect.value as "add" | "multiply";
  const result = await calc.compute({ a, b, op });
  resultEl.textContent = String(result);
});

void (async () => {
  for await (const entry of log.entries()) {
    appendLogEntry(entry);
  }
})();

function appendLogEntry(e: LogEntry) {
  const row = document.createElement("div");
  row.className = "log-row";
  const ts = new Date(e.at).toLocaleTimeString();
  row.textContent = `[${ts}] ${e.from}: ${e.expr}`;
  logEl.prepend(row);
  while (logEl.children.length > 20) logEl.lastChild?.remove();
}
