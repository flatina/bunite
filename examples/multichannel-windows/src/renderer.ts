import {
  BuniteView,
  createTransportDemuxer,
  defineBuniteRPC,
} from "bunite-core/view";
import type { CalcSchema, LogEntry, LogSchema } from "./schema";

const view = new BuniteView();
const demux = createTransportDemuxer(view.transport);

const calcRpc = defineBuniteRPC<CalcSchema, "webview">("webview", { handlers: {} });
calcRpc.setTransport(demux.channel("calc"));

const logRpc = defineBuniteRPC<LogSchema, "webview">("webview", {
  handlers: {
    messages: {
      entry: (e: LogEntry) => appendLogEntry(e),
    },
  },
});
logRpc.setTransport(demux.channel("log"));

const aInput = document.getElementById("a") as HTMLInputElement;
const bInput = document.getElementById("b") as HTMLInputElement;
const opSelect = document.getElementById("op") as HTMLSelectElement;
const resultEl = document.getElementById("result")!;
const logEl = document.getElementById("log")!;
const goBtn = document.getElementById("go")!;

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
