#!/usr/bin/env bun
// bunite build script — generic for any bunite app.
//
// Usage:
//   bunite-build              # bundle only (dist/main.js)
//   bunite-build --compile    # bundle + standalone exe (dist/<name>.exe)
//   bunite-build --entry src/main.ts --locales en-US,ko --compile
//
// package.json "bunite" field (all optional):
//   { "entry": "src/main.ts", "name": "my-app", "locales": ["en-US"] }

import {
  mkdirSync, cpSync, existsSync, readdirSync, statSync, rmSync,
  readFileSync, writeFileSync
} from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { $ } from "bun";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function findBuniteCoreRoot(): string {
  const workspacePath = resolve(import.meta.dirname, "..", "..", "..", "package");
  if (existsSync(join(workspacePath, "native-build"))) return workspacePath;
  try {
    return dirname(require.resolve("bunite-core/package.json"));
  } catch {}
  throw new Error("bunite-core not found.");
}

const coreRoot = findBuniteCoreRoot();
const nativeBuild = join(coreRoot, "native-build", "win-x64");
const cefSrc = join(nativeBuild, "cef");

// App config
const appDir = process.cwd();
const appPkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
const buniteConfig = appPkg.bunite ?? {};

const { values: args } = parseArgs({
  options: {
    entry: { type: "string" },
    locales: { type: "string" },
    compile: { type: "boolean", default: false },
  },
  strict: false,
});

const entry = args.entry ?? buniteConfig.entry ?? "src/main.ts";
const appName = buniteConfig.name ?? appPkg.name ?? basename(appDir);
const compile = args.compile as boolean;
const locales: string[] = args.locales
  ? (args.locales as string).split(",")
  : buniteConfig.locales ?? ["en-US"];

const dist = join(appDir, "dist");

// Clean
if (existsSync(dist)) {
  try { rmSync(dist, { recursive: true }); }
  catch { try { require("node:fs").renameSync(dist, `${dist}-old-${Date.now()}`); } catch {} }
}
mkdirSync(dist, { recursive: true });

// 1. Bundle / Compile
if (compile) {
  const exeName = `${appName}.exe`;
  const exePath = join(dist, exeName);
  console.log(`1. compile ${entry} → ${exeName}`);
  await $`bun build ${join(appDir, entry)} --compile --outfile ${exePath}`.cwd(appDir);

  // PE patch: CUI → GUI (no console window on launch)
  const pe = readFileSync(exePath);
  if (pe[0] === 0x4D && pe[1] === 0x5A) { // MZ signature
    const peOffset = pe.readUInt32LE(0x3c);
    if (peOffset + 0x5e <= pe.length
      && pe[peOffset] === 0x50 && pe[peOffset + 1] === 0x45 // PE\0\0
      && pe.readUInt16LE(peOffset + 0x5c) === 3) {
      pe.writeUInt16LE(2, peOffset + 0x5c);
      writeFileSync(exePath, pe);
    }
  }
} else {
  const outFile = join(dist, "main.js");
  console.log(`1. bundle ${entry} → main.js`);
  await $`bun build ${join(appDir, entry)} --target bun --outfile ${outFile}`.cwd(appDir);
}

// 2. Native artifacts
console.log("2. native artifacts");
cpSync(join(nativeBuild, "libBuniteNative.dll"), join(dist, "libBuniteNative.dll"));
cpSync(join(nativeBuild, "process_helper.exe"), join(dist, "process_helper.exe"));

// 3. CEF minimal
console.log("3. cef minimal");
const cefDist = join(dist, "cef");
mkdirSync(cefDist, { recursive: true });

const requiredFiles = [
  "libcef.dll", "chrome_elf.dll", "d3dcompiler_47.dll",
  "dxcompiler.dll", "dxil.dll", "libEGL.dll", "libGLESv2.dll",
  "icudtl.dat", "v8_context_snapshot.bin",
  "resources.pak", "chrome_100_percent.pak", "chrome_200_percent.pak",
];
for (const f of requiredFiles) {
  const src = join(cefSrc, f);
  if (existsSync(src)) cpSync(src, join(cefDist, f));
}

const localesSrc = join(cefSrc, "Resources", "locales");
const localesDist = join(cefDist, "Resources", "locales");
mkdirSync(localesDist, { recursive: true });
for (const locale of locales) {
  const src = join(localesSrc, `${locale}.pak`);
  if (existsSync(src)) cpSync(src, join(localesDist, `${locale}.pak`));
}

// 4. Size report
console.log("");
let totalBytes = 0;
function getDirSize(dir: string): number {
  let s = 0;
  for (const e of readdirSync(dir, { withFileTypes: true }))
    s += e.isDirectory() ? getDirSize(join(dir, e.name)) : statSync(join(dir, e.name)).size;
  return s;
}
const mb = (b: number) => (b / 1024 / 1024).toFixed(1);
for (const e of readdirSync(dist, { withFileTypes: true })) {
  const full = join(dist, e.name);
  const size = e.isDirectory() ? getDirSize(full) : statSync(full).size;
  totalBytes += size;
  console.log(`  ${e.name}${e.isDirectory() ? "/" : ""}  ${mb(size)} MB`);
}
console.log(`\n  Total: ${mb(totalBytes)} MB`);
console.log(`  → ${dist}`);
