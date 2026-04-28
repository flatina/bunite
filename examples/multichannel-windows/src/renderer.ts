import {
  BuniteView,
  createRpcTransportDemuxer,
  defineWebviewRpc,
} from "bunite-core/view";
import type { CalcSchema, LogEntry, LogSchema } from "./schema";

const view = new BuniteView();
const demux = createRpcTransportDemuxer(view.transport);

const calcRpc = defineWebviewRpc<CalcSchema>({ handlers: {} });
const logRpc = defineWebviewRpc<LogSchema>({
  handlers: {
    messages: {
      entry: (e: LogEntry) => appendLogEntry(e),
    },
  },
});

const aInput = document.getElementById("a") as HTMLInputElement;
const bInput = document.getElementById("b") as HTMLInputElement;
const opSelect = document.getElementById("op") as HTMLSelectElement;
const resultEl = document.getElementById("result")!;
const logEl = document.getElementById("log")!;
const goBtn = document.getElementById("go")!;

// Disable the button until the main-side calc channel is up.
goBtn.setAttribute("disabled", "true");
demux.channel("calc").bindTo(calcRpc)
  .then(() => goBtn.removeAttribute("disabled"))
  .catch((err: Error) => { resultEl.textContent = `calc not ready: ${err.message}`; });

// log is receive-only in the renderer — no need to await.
demux.channel("log").bindTo(logRpc);

goBtn.addEventListener("click", async () => {
  const a = Number(aInput.value);
  const b = Number(bInput.value);
  const op = opSelect.value as "add" | "multiply";
  const result = await calcRpc.request("compute", { a, b, op });
  resultEl.textContent = String(result);
});

function appendLogEntry(e: LogEntry) {
  const row = document.createElement("div");
  row.className = "log-row";
  const ts = new Date(e.at).toLocaleTimeString();
  row.textContent = `[${ts}] ${e.from}: ${e.expr}`;
  logEl.prepend(row);
  while (logEl.children.length > 20) logEl.lastChild?.remove();
}
