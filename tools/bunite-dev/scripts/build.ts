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
import { join, basename } from "node:path";
import { $ } from "bun";
import { parseArgs } from "node:util";
import { assertPlatform, findBuniteCoreRoot, findNativeBuildRoot, findCefSource } from "./resolve";

assertPlatform();

const coreRoot = findBuniteCoreRoot();
const nativeBuild = findNativeBuildRoot(coreRoot);
const cefSrc = findCefSource(coreRoot);

// Auto-download CEF if not present
if (!existsSync(join(cefSrc, "libcef.dll")) && !existsSync(join(cefSrc, "Release", "libcef.dll"))) {
  console.log("0. CEF not found — downloading...");
  await $`bun ${join(import.meta.dirname, "setup-cef.ts")}`.cwd(coreRoot).env({
    ...process.env, BUNITE_CORE_ROOT: coreRoot
  });
}

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
  await $`bun build ${join(appDir, entry)} --compile --minify --outfile ${exePath}`.cwd(appDir);

  // PE patch: CUI → GUI (no console window on launch)
  const pe = readFileSync(exePath);
  if (pe[0] === 0x4D && pe[1] === 0x5A) {
    const peOffset = pe.readUInt32LE(0x3c);
    if (peOffset + 0x5e <= pe.length
      && pe[peOffset] === 0x50 && pe[peOffset + 1] === 0x45
      && pe.readUInt16LE(peOffset + 0x5c) === 3) {
      pe.writeUInt16LE(2, peOffset + 0x5c);
      writeFileSync(exePath, pe);
    }
  }
} else {
  const outFile = join(dist, "main.js");
  console.log(`1. bundle ${entry} → main.js`);
  await $`bun build ${join(appDir, entry)} --target bun --minify --outfile ${outFile}`.cwd(appDir);
}

// 2. Native artifacts
console.log("2. native artifacts");
const nativeFiles = ["libBuniteNative.dll", "process_helper.exe"];
for (const f of nativeFiles) {
  const src = join(nativeBuild, f);
  if (!existsSync(src)) {
    console.error(`   ERROR: ${f} not found at ${nativeBuild}`);
    console.error("   Run 'bun run build:native:win' in the bunite-core package first.");
    process.exit(1);
  }
  cpSync(src, join(dist, f));
}

// 3. CEF minimal
console.log("3. cef minimal");

// Resolve file from flat or Release/Resources subdirectory layout
function findCefFile(name: string): string | null {
  const effectiveSrc = findCefSource(coreRoot);
  for (const dir of [effectiveSrc, join(effectiveSrc, "Release"), join(effectiveSrc, "Resources")]) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

const requiredCefFiles = [
  "libcef.dll", "chrome_elf.dll", "icudtl.dat", "v8_context_snapshot.bin",
  "resources.pak", "chrome_100_percent.pak", "chrome_200_percent.pak",
];
const optionalCefFiles = [
  "d3dcompiler_47.dll", "dxcompiler.dll", "dxil.dll",
  "libEGL.dll", "libGLESv2.dll",
];

const cefDist = join(dist, "cef");
mkdirSync(cefDist, { recursive: true });

for (const f of requiredCefFiles) {
  const src = findCefFile(f);
  if (!src) {
    console.error(`   ERROR: required CEF file '${f}' not found.`);
    process.exit(1);
  }
  cpSync(src, join(cefDist, f));
}
for (const f of optionalCefFiles) {
  const src = findCefFile(f);
  if (src) cpSync(src, join(cefDist, f));
}

// Locales
const localesDirs = [
  join(cefSrc, "Resources", "locales"),
  join(cefSrc, "locales"),
];
const localesSrcDir = localesDirs.find(d => existsSync(d));
const localesDist = join(cefDist, "Resources", "locales");
mkdirSync(localesDist, { recursive: true });
for (const locale of locales) {
  const pak = `${locale}.pak`;
  const src = localesSrcDir ? join(localesSrcDir, pak) : null;
  if (!src || !existsSync(src)) {
    console.warn(`   WARN: locale '${locale}' not found, skipping.`);
    continue;
  }
  cpSync(src, join(localesDist, pak));
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
