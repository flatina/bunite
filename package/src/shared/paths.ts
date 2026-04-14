import { dirname, join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { ARCH, BIN_EXT, NATIVE_LIB_EXT, PLATFORM_TAG } from "./platform";
import { CEF_VERSION } from "./cefVersion";

const require = createRequire(import.meta.url);

export type ResolvedNativeArtifacts = {
  packageRoot: string;
  source: "optional-package" | "local-build" | "missing";
  nativePackageName: string | null;
  cefPackageName: string | null;
  nativeLibPath: string | null;
  processHelperPath: string | null;
  cefDir: string | null;
};

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
  // 0. Explicit override (testing / development)
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

  // 3. vendors/cef inside bunite-core package (monorepo dev)
  const packageRoot = resolveBunitePackageRoot();
  if (packageRoot) {
    const vendorPath = join(packageRoot, "vendors", "cef");
    if (hasCefRuntime(vendorPath)) {
      return vendorPath;
    }
  }

  return null;
}

/** Entry script dir (dev) or exe dir (compiled binary). */
export function getBaseDir(): string {
  const main = Bun.main;
  if (main && existsSync(main)) return dirname(main);
  return dirname(process.execPath);
}

export function resolveDefaultAppResRoot(): string | null {
  const candidate = join(process.cwd(), "appres");
  return existsSync(candidate) ? candidate : null;
}

export function resolveNativeArtifacts(): ResolvedNativeArtifacts {
  const exeDir = dirname(process.execPath);

  // 1. Executable-relative (compiled standalone binary)
  const exeNativeLib = join(exeDir, `libBuniteNative${NATIVE_LIB_EXT}`);
  const exeProcessHelper = join(exeDir, `process_helper${BIN_EXT}`);
  if (existsSync(exeNativeLib) && existsSync(exeProcessHelper)) {
    return {
      packageRoot: exeDir,
      source: "local-build",
      nativePackageName: null,
      cefPackageName: null,
      nativeLibPath: exeNativeLib,
      processHelperPath: exeProcessHelper,
      cefDir: resolveCefDir([exeDir])
    };
  }

  const packageRoot = resolveBunitePackageRoot();

  // 2. Optional npm packages (bunite-native-*, bunite-cef-*)
  const nativePackageName = `bunite-native-${PLATFORM_TAG}-${ARCH}`;
  const cefPackageName = `bunite-cef-${PLATFORM_TAG}-${ARCH}`;
  const nativePackageRoot = resolvePackageRoot(nativePackageName);
  const cefPackageRoot = resolvePackageRoot(cefPackageName);

  const packagedNativeLibPath = nativePackageRoot
    ? join(nativePackageRoot, `libBuniteNative${NATIVE_LIB_EXT}`)
    : null;
  const packagedProcessHelperPath = nativePackageRoot
    ? join(nativePackageRoot, `process_helper${BIN_EXT}`)
    : null;
  const packagedCefDir = cefPackageRoot ?? null;

  if (
    packagedNativeLibPath &&
    packagedProcessHelperPath &&
    existsSync(packagedNativeLibPath) &&
    existsSync(packagedProcessHelperPath)
  ) {
    return {
      packageRoot: packageRoot ?? exeDir,
      source: "optional-package",
      nativePackageName,
      cefPackageName: packagedCefDir && existsSync(packagedCefDir) ? cefPackageName : null,
      nativeLibPath: packagedNativeLibPath,
      processHelperPath: packagedProcessHelperPath,
      cefDir: (packagedCefDir && existsSync(packagedCefDir))
        ? packagedCefDir
        : resolveCefDir([nativePackageRoot, packageRoot].filter(Boolean) as string[])
    };
  }

  // 3. Local build (development)
  if (packageRoot) {
    const localBuildRoot = join(packageRoot, "native-build", `${PLATFORM_TAG}-${ARCH}`);
    const directLib = join(localBuildRoot, `libBuniteNative${NATIVE_LIB_EXT}`);
    const directHelper = join(localBuildRoot, `process_helper${BIN_EXT}`);

    if (existsSync(directLib) && existsSync(directHelper)) {
      return {
        packageRoot,
        source: "local-build",
        nativePackageName: null,
        cefPackageName: null,
        nativeLibPath: directLib,
        processHelperPath: directHelper,
        cefDir: resolveCefDir([localBuildRoot])
      };
    }

    const releaseLib = join(localBuildRoot, "Release", `libBuniteNative${NATIVE_LIB_EXT}`);
    const releaseHelper = join(localBuildRoot, "Release", `process_helper${BIN_EXT}`);

    if (existsSync(releaseLib) && existsSync(releaseHelper)) {
      return {
        packageRoot,
        source: "local-build",
        nativePackageName: null,
        cefPackageName: null,
        nativeLibPath: releaseLib,
        processHelperPath: releaseHelper,
        cefDir: resolveCefDir([localBuildRoot])
      };
    }
  }

  return {
    packageRoot: packageRoot ?? exeDir,
    source: "missing",
    nativePackageName: nativePackageRoot ? nativePackageName : null,
    cefPackageName: cefPackageRoot ? cefPackageName : null,
    nativeLibPath: null,
    processHelperPath: null,
    cefDir: null
  };
}
