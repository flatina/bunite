#!/usr/bin/env bun
// Copies native build artifacts into this package directory.
// Run after `bun run build:native:win` in the repo root.

import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

const pkgDir = import.meta.dirname;
const nativeBuild = join(pkgDir, "..", "..", "package", "native-build", "win-x64");

const files = ["libBuniteNative.dll", "process_helper.exe"];

for (const f of files) {
  const src = join(nativeBuild, f);
  if (!existsSync(src)) {
    console.error(`${f} not found at ${nativeBuild}. Run 'bun run build:native:win' first.`);
    process.exit(1);
  }
  cpSync(src, join(pkgDir, f));
  console.log(`  ${f}`);
}
console.log("done");
