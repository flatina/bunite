import { AppRuntime, BrowserWindow } from "bunite-core";
import { type ImplOf, Stream } from "bunite-core/rpc";
import indexHtml from "./index.html" with { type: "text" };
import { calcCap, type LogEntry, logCap } from "./schema";

const app = new AppRuntime();
await app.ready;

const rendererBundle = await Bun.build({
  entrypoints: [app.resolve("./renderer.ts")],
  target: "browser",
});
if (!rendererBundle.success) {
  throw new Error(`renderer bundle failed:\n${rendererBundle.logs.join("\n")}`);
}
const rendererJs = await rendererBundle.outputs[0]!.text();
const html = (indexHtml as unknown as string).replace("<!--RENDERER_BUNDLE-->", rendererJs);

const logSubs = new Set<(entry: LogEntry) => void>();

function broadcastLog(entry: LogEntry) {
  for (const emit of logSubs) emit(entry);
}

function createDemoWindow(label: string, x: number) {
  const calcImpl = {
    compute: ({ a, b, op }) => {
      const result = op === "add" ? a + b : a * b;
      const symbol = op === "add" ? "+" : "×";
      broadcastLog({
        from: label,
        expr: `${a} ${symbol} ${b} = ${result}`,
        result,
        at: Date.now(),
      });
      return result;
    },
  } satisfies ImplOf<typeof calcCap>;

  const logImpl = {
    entries: () =>
      Stream.from<LogEntry>((emit, signal) => {
        logSubs.add(emit);
        signal.addEventListener("abort", () => logSubs.delete(emit));
      }),
  } satisfies ImplOf<typeof logCap>;

  new BrowserWindow({
    title: `Multi-channel — ${label}`,
    html,
    frame: { x, y: 100, width: 420, height: 520 },
    serve: (conn) => {
      conn.serve(calcCap, calcImpl);
      conn.serve(logCap, logImpl);
    },
  });
}

createDemoWindow("Window A", 80);
createDemoWindow("Window B", 540);

app.run();
