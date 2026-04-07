import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { ARCH, BIN_EXT, NATIVE_LIB_EXT, PLATFORM_TAG } from "./platform";

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

export function resolveBunitePackageRoot(): string {
  const packageJsonPath = require.resolve("bunite-core/package.json");
  return dirname(packageJsonPath);
}

export function resolveFallbackCefDir(): string | null {
  const envOverride = process.env.BUNITE_CEF_DIR ?? process.env.BUNITE_CEF_ROOT;
  if (envOverride && existsSync(envOverride)) {
    return envOverride;
  }

  const bunitePackageRoot = resolveBunitePackageRoot();
  const localVendorPath = join(bunitePackageRoot, "vendors", "cef");
  if (existsSync(localVendorPath)) {
    return localVendorPath;
  }

  const upstreamVendorPath = "C:\\project\\electrobun\\package\\vendors\\cef";
  if (existsSync(upstreamVendorPath)) {
    return upstreamVendorPath;
  }

  return null;
}

export function resolveDefaultViewsRoot(): string | null {
  const candidate = join(process.cwd(), "views");
  return existsSync(candidate) ? candidate : null;
}

export function resolveNativeArtifacts(): ResolvedNativeArtifacts {
  const packageRoot = resolveBunitePackageRoot();
  const nativePackageName = `@bunite/native-${PLATFORM_TAG}-${ARCH}`;
  const cefPackageName = `@bunite/cef-${PLATFORM_TAG}-${ARCH}`;
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
      packageRoot,
      source: "optional-package",
      nativePackageName,
      cefPackageName: packagedCefDir && existsSync(packagedCefDir) ? cefPackageName : null,
      nativeLibPath: packagedNativeLibPath,
      processHelperPath: packagedProcessHelperPath,
      cefDir: packagedCefDir && existsSync(packagedCefDir) ? packagedCefDir : null
    };
  }

  const localBuildRoot = join(packageRoot, "native-build", `${PLATFORM_TAG}-${ARCH}`);
  const localCefDir = join(localBuildRoot, "cef");
  const directLocalNativeLibPath = join(localBuildRoot, `libBuniteNative${NATIVE_LIB_EXT}`);
  const directLocalProcessHelperPath = join(localBuildRoot, `process_helper${BIN_EXT}`);

  if (existsSync(directLocalNativeLibPath) && existsSync(directLocalProcessHelperPath)) {
    const resolvedLocalCefDir = existsSync(localCefDir) ? localCefDir : resolveFallbackCefDir();
    return {
      packageRoot,
      source: "local-build",
      nativePackageName: null,
      cefPackageName: null,
      nativeLibPath: directLocalNativeLibPath,
      processHelperPath: directLocalProcessHelperPath,
      cefDir: resolvedLocalCefDir
    };
  }

  const localBuildBinRoot = join(localBuildRoot, "Release");
  const localNativeLibPath = join(localBuildBinRoot, `libBuniteNative${NATIVE_LIB_EXT}`);
  const localProcessHelperPath = join(localBuildBinRoot, `process_helper${BIN_EXT}`);

  if (existsSync(localNativeLibPath) && existsSync(localProcessHelperPath)) {
    const resolvedLocalCefDir = existsSync(localCefDir) ? localCefDir : resolveFallbackCefDir();
    return {
      packageRoot,
      source: "local-build",
      nativePackageName: null,
      cefPackageName: null,
      nativeLibPath: localNativeLibPath,
      processHelperPath: localProcessHelperPath,
      cefDir: resolvedLocalCefDir
    };
  }

  return {
    packageRoot,
    source: "missing",
    nativePackageName: nativePackageRoot ? nativePackageName : null,
    cefPackageName: cefPackageRoot ? cefPackageName : null,
    nativeLibPath: null,
    processHelperPath: null,
    cefDir: null
  };
}
