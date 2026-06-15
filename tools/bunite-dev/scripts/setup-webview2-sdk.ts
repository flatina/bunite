/**
 * Download Microsoft.Web.WebView2 NuGet package into package/vendors/webview2/
 *
 * Usage:
 *   bun run setup:webview2                            # pinned version
 *   bun run setup:webview2 -- --version 1.0.2210.55
 *   bun run setup:webview2 -- --force
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findBuniteCoreRoot } from "./resolve";

const PINNED_VERSION = "1.0.2792.45"; // recent stable; adjust as Edge SDK ships
const NUGET_BASE = "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2";

const SDK_DIR = join(findBuniteCoreRoot(), "vendors", "webview2");
const VERSION_STAMP = join(SDK_DIR, ".webview2-version");

function parseArgs() {
  const args = process.argv.slice(2);
  let version = PINNED_VERSION;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--version" && args[i + 1]) version = args[++i];
    else if (args[i] === "--force") force = true;
  }
  return { version, force };
}

async function download(url: string, dest: string) {
  console.log(`Downloading: ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length < 256 * 1024) {
    throw new Error(`Download too small (${buf.length} bytes) — likely an error page`);
  }
  await Bun.write(dest, buf);
  console.log(`Saved: ${dest} (${(buf.length / 1024).toFixed(0)} KB)`);
}

async function extract(zipPath: string, dest: string) {
  console.log(`Extracting to ${dest} ...`);
  mkdirSync(dest, { recursive: true });
  // Windows 10+ tar supports zip via the libarchive backend.
  const proc = Bun.spawn(["tar", "-xf", zipPath, "-C", dest], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`tar zip extraction failed with exit code ${code}`);
}

async function main() {
  const { version, force } = parseArgs();
  if (!force && existsSync(VERSION_STAMP)) {
    const stamp = readFileSync(VERSION_STAMP, "utf-8").trim();
    if (stamp === version) {
      console.log(`WebView2 SDK ${version} already present at ${SDK_DIR}`);
      return;
    }
  }

  const url = `${NUGET_BASE}/${version}`;
  const tmpZip = join(SDK_DIR, "..", `webview2-${version}.nupkg`);
  const tmpExtract = `${SDK_DIR}.tmp`;

  try {
    mkdirSync(join(SDK_DIR, ".."), { recursive: true });
    await download(url, tmpZip);

    if (existsSync(tmpExtract)) rmSync(tmpExtract, { recursive: true, force: true });
    await extract(tmpZip, tmpExtract);

    // Validate expected layout.
    const header = join(tmpExtract, "build", "native", "include", "WebView2.h");
    if (!existsSync(header)) {
      throw new Error(`Expected ${header} after extraction — NuGet layout changed?`);
    }

    if (existsSync(SDK_DIR)) rmSync(SDK_DIR, { recursive: true, force: true });
    mkdirSync(SDK_DIR, { recursive: true });

    // Copy what the build needs: headers + import libs + redistributable loader DLL.
    cpSync(join(tmpExtract, "build", "native", "include"), join(SDK_DIR, "include"), {
      recursive: true,
    });
    cpSync(join(tmpExtract, "build", "native", "x64"), join(SDK_DIR, "lib-x64"), {
      recursive: true,
    });
    cpSync(
      join(tmpExtract, "runtimes", "win-x64", "native", "WebView2Loader.dll"),
      join(SDK_DIR, "WebView2Loader.dll"),
    );

    writeFileSync(VERSION_STAMP, version + "\n");
    console.log(`Done. WebView2 SDK installed at ${SDK_DIR}`);
  } finally {
    if (existsSync(tmpZip)) rmSync(tmpZip);
    if (existsSync(tmpExtract)) rmSync(tmpExtract, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
