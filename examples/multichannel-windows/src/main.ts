import { AppRuntime, BrowserWindow, Stream, type ImplOf } from "bunite-core";
import indexHtml from "./index.html" with { type: "text" };
import { schema, calcCap, logCap, type LogEntry } from "./schema";

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
  const calcImpl: ImplOf<typeof calcCap> = {
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
  };

  const logImpl: ImplOf<typeof logCap> = {
    entries: () => Stream.from<LogEntry>((emit, signal) => {
      logSubs.add(emit);
      signal.addEventListener("abort", () => logSubs.delete(emit));
    }),
  };

  new BrowserWindow({
    title: `Multi-channel — ${label}`,
    html,
    frame: { x, y: 100, width: 420, height: 520 },
    serve: schema.serve({ calc: calcImpl, log: logImpl }),
  });
}

createDemoWindow("Window A", 80);
createDemoWindow("Window B", 540);

app.run();
