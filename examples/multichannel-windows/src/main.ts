import {
  AppRuntime,
  BrowserWindow,
  createTransportDemuxer,
  defineBunRPC,
} from "bunite-core";
import indexHtml from "./index.html" with { type: "text" };
import type { CalcSchema, ComputeParams, LogEntry, LogSchema } from "./schema";

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

type LogRpc = ReturnType<typeof defineBunRPC<LogSchema>>;
const logRpcs = new Set<LogRpc>();

function broadcastLog(entry: LogEntry) {
  for (const rpc of logRpcs) rpc.send("entry", entry);
}

function createDemoWindow(label: string, x: number) {
  const win = new BrowserWindow({
    title: `Multi-channel — ${label}`,
    html,
    frame: { x, y: 100, width: 420, height: 520 },
  });

  const demux = createTransportDemuxer(win.view.transport);

  const calcRpc = defineBunRPC<CalcSchema>({
    handlers: {
      requests: {
        compute: ({ a, b, op }: ComputeParams) => {
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
      },
    },
  });
  demux.channel("calc").bindTo(calcRpc).catch((err: Error) => {
    console.error(`[${label}] calc channel: ${err.message}`);
  });

  const logRpc = defineBunRPC<LogSchema>({ handlers: {} });
  // Only broadcast after renderer registers the log channel — earlier entries would drop.
  demux.channel("log").bindTo(logRpc).then(() => logRpcs.add(logRpc)).catch((err: Error) => {
    console.error(`[${label}] log channel: ${err.message}`);
  });

  win.on("close", () => {
    calcRpc.dispose();
    logRpc.dispose();
    demux.dispose();
    logRpcs.delete(logRpc);
  });
}

createDemoWindow("Window A", 80);
createDemoWindow("Window B", 540);

app.run();
