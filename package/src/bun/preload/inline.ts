import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { log } from "../../shared/log";

function escapeRootForComparison(path: string) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function resolveAppResFile(appresRoot: string, url: string) {
  const relativePath = url.replace(/^appres:\/\/app\.internal\//, "").replace(/^[\\/]+/, "");
  const normalizedRoot = resolve(appresRoot);
  const candidate = resolve(normalizedRoot, relativePath.split("/").join(sep));
  const comparableRoot = escapeRootForComparison(normalizedRoot);
  const comparableCandidate = escapeRootForComparison(candidate);

  if (
    comparableCandidate !== comparableRoot &&
    !comparableCandidate.startsWith(`${comparableRoot}${sep}`)
  ) {
    throw new Error(`preload path escapes appresRoot: ${url}`);
  }

  return candidate;
}

function readCustomPreload(preload: string | null, appresRoot: string | null) {
  if (!preload) {
    return "";
  }

  try {
    const resolvedPath = preload.startsWith("appres://app.internal/")
      ? appresRoot
        ? resolveAppResFile(appresRoot, preload)
        : null
      : isAbsolute(preload)
        ? preload
        : resolve(preload);

    if (!resolvedPath) {
      log.warn(`Cannot resolve preload without appresRoot: ${preload}`);
      return "";
    }
    if (!existsSync(resolvedPath)) {
      log.warn(`Preload file was not found: ${resolvedPath}`);
      return "";
    }

    return readFileSync(resolvedPath, "utf8");
  } catch (error) {
    log.warn("Failed to resolve preload script.", error);
    return "";
  }
}

// Pre-built preload runtime (built via `bun run build:preload` in package/).
// Embedded at bundle time so bun --compile includes it without filesystem access.
// @ts-ignore — text import attribute
import embeddedPreloadRuntime from "../../preload/runtime.built.js" with { type: "text" };

function getPreloadRuntime(): string {
  return embeddedPreloadRuntime;
}

export function buildViewPreloadScript(options: {
  preload: string | null;
  appresRoot: string | null;
  webviewId: number;
  rpcSocketPort: number;
  secretKey: Uint8Array;
}) {
  const secretKeyBase64 = Buffer.from(options.secretKey).toString("base64");

  // Per-view config — these globals are consumed by the pre-built runtime
  const config = `var __buniteWebviewId=${options.webviewId},__buniteRpcSocketPort=${options.rpcSocketPort},__buniteSecretKeyBase64=${JSON.stringify(secretKeyBase64)};`;

  const runtime = getPreloadRuntime();
  const customPreload = readCustomPreload(options.preload, options.appresRoot).trim();

  return [config, runtime, customPreload].filter(Boolean).join("\n");
}
