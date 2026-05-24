import { dirname, join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { ARCH, NATIVE_LIB_EXT, PLATFORM_TAG } from "./platform";
import { CEF_VERSION } from "./cefVersion";

const require = createRequire(import.meta.url);

export type WindowsEngine = "webview2" | "cef";

export type ResolvedNativeArtifacts = {
  packageRoot: string;
  source: "optional-package" | "local-build" | "missing";
  nativePackageName: string | null;
  enginePackageName: string | null;
  nativeLibPath: string | null;
  /** CEF framework dir containing libcef.dll. Null on macOS/Linux (system framework). */
  cefDir: string | null;
  /** Selected Windows engine. Undefined on mac/linux. */
  engine?: WindowsEngine;
};

function nativeLibBasename(engine: WindowsEngine | undefined): string {
  if (PLATFORM_TAG === "win" && engine === "webview2") {
    return `libBuniteNativeWebView2${NATIVE_LIB_EXT}`;
  }
  return `libBuniteNative${NATIVE_LIB_EXT}`;
}

export function resolvePackageRoot(packageName: string): string | null {
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    return dirname(packageJsonPath);
  } catch {
    return null;
  }
}

export function resolveBunitePackageRoot(): string | null {
  try {
    const packageJsonPath = require.resolve("bunite-core/package.json");
    return dirname(packageJsonPath);
  } catch {
    return null;
  }
}

function hasCefRuntime(dir: string): boolean {
  return existsSync(join(dir, "libcef.dll")) || existsSync(join(dir, "libcef.so"));
}

function parseCefVersion(name: string): number[] | null {
  const m = name.match(/^cef-(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function resolveCefDir(searchDirs: string[]): string | null {
  // CEF-only (Win). mac/linux use system frameworks.
  if (PLATFORM_TAG !== "win") return null;

  // 0. Explicit override.
  const forceDir = process.env.BUNITE_CEF_DIR;
  if (forceDir && hasCefRuntime(forceDir)) {
    return forceDir;
  }

  // 1. Local cef/ adjacent to native artifacts (standalone dist)
  for (const dir of searchDirs) {
    const candidate = join(dir, "cef");
    if (hasCefRuntime(candidate)) {
      return candidate;
    }
  }

  // 1b. App's own dist/cef (dev mode reuses `bunite-build`-produced binaries).
  const cwdDist = join(process.cwd(), "dist", "cef");
  if (hasCefRuntime(cwdDist)) {
    return cwdDist;
  }

  // 2. Shared CEF root: BUNITE_CEF_ROOTDIR/cef-<version>/
  const rootDir = process.env.BUNITE_CEF_ROOTDIR;
  if (rootDir && existsSync(rootDir)) {
    const exact = join(rootDir, `cef-${CEF_VERSION}`);
    if (hasCefRuntime(exact)) {
      return exact;
    }
    // Same major fallback — numeric version comparison
    const [targetMajor] = CEF_VERSION.split(".").map(Number);
    try {
      let best: { dir: string; ver: number[] } | null = null;
      for (const name of readdirSync(rootDir)) {
        const ver = parseCefVersion(name);
        if (!ver || ver[0] !== targetMajor) continue;
        const full = join(rootDir, name);
        if (!hasCefRuntime(full)) continue;
        if (!best || ver[1] > best.ver[1] || (ver[1] === best.ver[1] && ver[2] > best.ver[2])) {
          best = { dir: full, ver };
        }
      }
      if (best) return best.dir;
    } catch {}
  }

  return null;
}

/** Entry-script dir (dev) or real exe dir (compiled binary). */
export function getBaseDir(): string {
  const main = Bun.main;
  // Compiled standalone: Bun.main is a virtual embedded-fs path (win `B:/~BUN/…`,
  // posix `/$bunfs/…`) for which existsSync() returns true — so it can't gate the
  // dev branch. Detect the virtual root and use the real executable dir instead.
  const compiled = main.includes("~BUN") || main.includes("$bunfs");
  if (!compiled && main && existsSync(main)) return dirname(main);
  return dirname(process.execPath);
}

export function resolveDefaultAppResRoot(): string | null {
  const candidate = join(process.cwd(), "appres");
  return existsSync(candidate) ? candidate : null;
}

export function resolveNativeArtifacts(engine?: WindowsEngine): ResolvedNativeArtifacts {
  const exeDir = getBaseDir();
  const resolvedEngine: WindowsEngine | undefined =
    PLATFORM_TAG === "win" ? (engine ?? "webview2") : undefined;
  const libName = nativeLibBasename(resolvedEngine);

  // 1. Entry-script-dir / executable-relative.
  const exeNativeLib = join(exeDir, libName);
  if (existsSync(exeNativeLib)) {
    return {
      packageRoot: exeDir,
      source: "local-build",
      nativePackageName: null,
      enginePackageName: null,
      nativeLibPath: exeNativeLib,
      cefDir: resolvedEngine === "cef" ? resolveCefDir([exeDir]) : null,
      engine: resolvedEngine
    };
  }

  const packageRoot = resolveBunitePackageRoot();

  // 2. Optional npm packages.
  const nativePackageName = `bunite-native-${PLATFORM_TAG}-${ARCH}`;
  const enginePackageName = PLATFORM_TAG === "win" && resolvedEngine === "cef"
    ? `bunite-cef-${PLATFORM_TAG}-${ARCH}`
    : null;
  const nativePackageRoot = resolvePackageRoot(nativePackageName);
  const enginePackageRoot = enginePackageName ? resolvePackageRoot(enginePackageName) : null;

  const packagedNativeLibPath = nativePackageRoot ? join(nativePackageRoot, libName) : null;
  const packagedEngineDir = enginePackageRoot ?? null;

  if (packagedNativeLibPath && existsSync(packagedNativeLibPath)) {
    return {
      packageRoot: packageRoot ?? exeDir,
      source: "optional-package",
      nativePackageName,
      enginePackageName: packagedEngineDir && existsSync(packagedEngineDir) ? enginePackageName : null,
      nativeLibPath: packagedNativeLibPath,
      cefDir: resolvedEngine === "cef"
        ? ((packagedEngineDir && existsSync(packagedEngineDir))
            ? packagedEngineDir
            : resolveCefDir([nativePackageRoot, packageRoot].filter(Boolean) as string[]))
        : null,
      engine: resolvedEngine
    };
  }

  // 3. Local build (development).
  if (packageRoot) {
    const localBuildRoot = join(packageRoot, "native-build", `${PLATFORM_TAG}-${ARCH}`);
    const directLib = join(localBuildRoot, libName);

    if (existsSync(directLib)) {
      return {
        packageRoot,
        source: "local-build",
        nativePackageName: null,
        enginePackageName: null,
        nativeLibPath: directLib,
        cefDir: resolvedEngine === "cef" ? resolveCefDir([localBuildRoot]) : null,
        engine: resolvedEngine
      };
    }

    const releaseLib = join(localBuildRoot, "Release", libName);
    if (existsSync(releaseLib)) {
      return {
        packageRoot,
        source: "local-build",
        nativePackageName: null,
        enginePackageName: null,
        nativeLibPath: releaseLib,
        cefDir: resolvedEngine === "cef" ? resolveCefDir([localBuildRoot]) : null,
        engine: resolvedEngine
      };
    }
  }

  return {
    packageRoot: packageRoot ?? exeDir,
    source: "missing",
    nativePackageName: nativePackageRoot ? nativePackageName : null,
    enginePackageName: enginePackageRoot ? enginePackageName : null,
    nativeLibPath: null,
    cefDir: null,
    engine: resolvedEngine
  };
}
