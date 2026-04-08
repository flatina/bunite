import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const projectRoot = dirname(import.meta.dir);
const outdir = join(projectRoot, "dist", "renderer", "smoke");

mkdirSync(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(projectRoot, "src", "renderer", "index.ts")],
  target: "browser",
  outdir
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("Failed to build smoke renderer.");
}

for (const name of ["index.html", "nav-ok.html", "nav-blocked.html"]) {
  copyFileSync(join(projectRoot, "src", "renderer", name), join(outdir, name));
}

console.log("[smoke] renderer built", result.outputs.map(o => o.path));
