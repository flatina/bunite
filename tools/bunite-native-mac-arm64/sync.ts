#!/usr/bin/env bun
// Copies macOS arm64 native build artifacts into this package directory.
// Run after `bun run build:native:mac` (or equivalent) on a Darwin host.

import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

const pkgDir = import.meta.dirname;
const nativeBuild = join(pkgDir, "..", "..", "package", "native-build", "mac-arm64");

const files = ["libBuniteNative.dylib"];

for (const f of files) {
  const src = join(nativeBuild, f);
  if (!existsSync(src)) {
    console.error(`${f} not found at ${nativeBuild}. Build the mac native first.`);
    process.exit(1);
  }
  cpSync(src, join(pkgDir, f));
  console.log(`  ${f}`);
}
console.log("done");
