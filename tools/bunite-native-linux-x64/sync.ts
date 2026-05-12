#!/usr/bin/env bun
// Sync Linux x64 native artifacts into this package. Run after `bun run build:native:linux`.

import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

const pkgDir = import.meta.dirname;
const nativeBuild = join(pkgDir, "..", "..", "package", "native-build", "linux-x64");

const files = ["libBuniteNative.so"];

for (const f of files) {
  const src = join(nativeBuild, f);
  if (!existsSync(src)) {
    console.error(`${f} not found at ${nativeBuild}. Build the linux native first.`);
    process.exit(1);
  }
  cpSync(src, join(pkgDir, f));
  console.log(`  ${f}`);
}
console.log("done");
