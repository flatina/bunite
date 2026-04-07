import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const projectRoot = dirname(import.meta.dir);
const distRendererDir = join(projectRoot, "dist", "renderer");
const distRendererMainDir = join(distRendererDir, "main");

mkdirSync(distRendererMainDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(projectRoot, "src", "renderer", "index.ts")],
  target: "browser",
  outdir: distRendererMainDir
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  throw new Error("Failed to build ipc-smoke renderer bundle.");
}

copyFileSync(
  join(projectRoot, "src", "renderer", "index.html"),
  join(distRendererMainDir, "index.html")
);
copyFileSync(
  join(projectRoot, "src", "renderer", "rpc-ok.html"),
  join(distRendererMainDir, "rpc-ok.html")
);
copyFileSync(
  join(projectRoot, "src", "renderer", "rpc-fail.html"),
  join(distRendererMainDir, "rpc-fail.html")
);
copyFileSync(
  join(projectRoot, "src", "renderer", "preload.js"),
  join(distRendererMainDir, "preload.js")
);

console.log("[ipc-smoke] renderer prepared", {
  outdir: distRendererMainDir,
  outputs: result.outputs.map((output) => output.path)
});
