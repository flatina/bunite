// Shared resolution utilities for bunite-dev scripts.

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const PLATFORM_TAG = process.platform === "win32" ? "win" : process.platform === "darwin" ? "darwin" : process.platform;
const ARCH = process.arch;

export function findBuniteCoreRoot(): string {
  // 1. Explicit override
  if (process.env.BUNITE_CORE_ROOT && existsSync(process.env.BUNITE_CORE_ROOT)) {
    return process.env.BUNITE_CORE_ROOT;
  }
  // 2. Workspace: tools/bunite-dev/scripts/ → ../../../package/
  const workspacePath = join(import.meta.dirname, "..", "..", "..", "package");
  if (existsSync(join(workspacePath, "package.json"))) return workspacePath;
  // 3. npm installed: node_modules/bunite-core/
  try {
    return dirname(require.resolve("bunite-core/package.json"));
  } catch {}
  throw new Error("bunite-core not found. Set BUNITE_CORE_ROOT or install bunite-core.");
}

export function findNativeBuildRoot(coreRoot: string): string {
  // 1. bunite-native-{platform}-{arch} package (npm or workspace)
  const nativePkg = `bunite-native-${PLATFORM_TAG}-${ARCH}`;
  try {
    const pkgRoot = dirname(require.resolve(`${nativePkg}/package.json`));
    if (existsSync(join(pkgRoot, `libBuniteNative${process.platform === "win32" ? ".dll" : ".so"}`))) {
      return pkgRoot;
    }
  } catch {}
  // 2. Local build
  return join(coreRoot, "native-build", `${PLATFORM_TAG}-${ARCH}`);
}

export function findCefSource(coreRoot: string): string {
  const nativeBuild = findNativeBuildRoot(coreRoot);
  const candidates = [
    join(nativeBuild, "cef"),
    join(coreRoot, "vendors", "cef"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "libcef.dll")) || existsSync(join(dir, "Release", "libcef.dll"))) {
      return dir;
    }
  }
  return candidates[0]; // caller should check and trigger download
}

export function assertPlatform(): void {
  if (process.platform !== "win32") {
    console.error(`bunite-dev: only Windows is supported currently (got ${process.platform})`);
    process.exit(1);
  }
}
