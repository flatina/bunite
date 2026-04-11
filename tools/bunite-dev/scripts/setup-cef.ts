/**
 * Download CEF binary distribution into package/vendors/cef/
 *
 * Usage:
 *   bun run setup:cef                       # latest stable, auto-detect arch
 *   bun run setup:cef -- --arch arm64       # specific arch
 *   bun run setup:cef -- --version 145.0.23 # specific version (resolves chromium ver from index)
 */

import { existsSync, mkdirSync, rmSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CryptoHasher } from "bun";

const CEF_INDEX_URL = "https://cef-builds.spotifycdn.com/index.json";
const CEF_CDN_BASE = "https://cef-builds.spotifycdn.com";

const PLATFORM_MAP: Record<string, string> = {
  "win32-x64": "windows64",
  "win32-arm64": "windowsarm64",
  "darwin-x64": "macosx64",
  "darwin-arm64": "macosarm64",
  "linux-x64": "linux64",
  "linux-arm64": "linuxarm64",
};

const VENDORS_CEF = join(import.meta.dir, "..", "vendors", "cef");
const VERSION_STAMP = join(VENDORS_CEF, ".cef-version");

// --- args ---

function parseArgs() {
  const args = process.argv.slice(2);
  let version: string | undefined;
  let arch = process.arch;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--version" && args[i + 1]) version = args[++i];
    else if (args[i] === "--arch" && args[i + 1]) arch = args[++i];
    else if (args[i] === "--force") force = true;
  }

  const platformKey = `${process.platform}-${arch}`;
  const cefPlatform = PLATFORM_MAP[platformKey];
  if (!cefPlatform) {
    console.error(`Unsupported platform: ${platformKey}`);
    process.exit(1);
  }

  return { version, cefPlatform, force };
}

// --- index ---

type CefIndexPlatform = {
  versions: Array<{
    cef_version: string;
    chromium_version: string;
    channel: string;
    files: Array<{ type: string; name: string; sha1: string }>;
  }>;
};

async function fetchIndex(cefPlatform: string): Promise<CefIndexPlatform> {
  console.log("Fetching CEF build index...");
  const res = await fetch(CEF_INDEX_URL);
  if (!res.ok) throw new Error(`Failed to fetch index: ${res.status}`);
  const data = (await res.json()) as Record<string, CefIndexPlatform>;
  const platform = data[cefPlatform];
  if (!platform) throw new Error(`Platform ${cefPlatform} not found in index`);
  return platform;
}

function parseCefTuple(cefVersion: string): number[] {
  return cefVersion.split("+")[0].split(".").map((s) => parseInt(s, 10) || 0);
}

function compareCefVersions(a: string, b: string): number {
  const ta = parseCefTuple(a);
  const tb = parseCefTuple(b);
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const diff = (tb[i] ?? 0) - (ta[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function resolveVersion(index: CefIndexPlatform, requestedVersion?: string) {
  const stableVersions = index.versions.filter((v) => v.channel === "stable");
  if (stableVersions.length === 0) throw new Error("No stable versions found");

  if (requestedVersion) {
    // match exact prefix up to the "+" boundary
    const match = stableVersions.find((v) => v.cef_version.split("+")[0] === requestedVersion
      || v.cef_version.split("+")[0].startsWith(requestedVersion + "."));
    if (!match) throw new Error(`Version ${requestedVersion} not found in stable channel`);
    return match;
  }

  // index is ordered by build date, not version — sort by full version tuple descending
  return stableVersions.sort((a, b) => compareCefVersions(a.cef_version, b.cef_version))[0];
}

// --- download & extract ---

async function download(url: string, dest: string) {
  console.log(`Downloading: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  const total = Number(res.headers.get("content-length") ?? 0);
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastPct = -10;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total > 0) {
      const pct = Math.floor((received / total) * 100);
      if (pct >= lastPct + 10) {
        process.stdout.write(`\r  ${pct}% (${(received / 1024 / 1024).toFixed(1)} MB)`);
        lastPct = pct;
      }
    }
  }
  console.log();

  if (received < 50 * 1024 * 1024) {
    throw new Error(`Download too small (${(received / 1024 / 1024).toFixed(1)} MB) — likely an error page`);
  }

  const blob = new Blob(chunks);
  await Bun.write(dest, blob);
  console.log(`Saved: ${dest} (${(received / 1024 / 1024).toFixed(1)} MB)`);
}

async function extract(archive: string, dest: string) {
  console.log(`Extracting to ${dest} ...`);
  mkdirSync(dest, { recursive: true });

  // tar is available natively on Windows 10+, macOS, and Linux
  const proc = Bun.spawn(["tar", "-xjf", archive, "--strip-components=1", "-C", dest], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`tar extraction failed with exit code ${exitCode}`);
}

// --- main ---

async function main() {
  const { version, cefPlatform, force } = parseArgs();
  const index = await fetchIndex(cefPlatform);
  const resolved = resolveVersion(index, version);

  // cef_version may already contain "+chromium-..." suffix
  const fullVersion = resolved.cef_version.includes("+chromium-")
    ? resolved.cef_version
    : `${resolved.cef_version}+chromium-${resolved.chromium_version}`;
  console.log(`CEF version: ${fullVersion} (${cefPlatform})`);

  // skip if already present
  if (!force && existsSync(VERSION_STAMP)) {
    const stamp = readFileSync(VERSION_STAMP, "utf-8").trim();
    if (stamp === fullVersion) {
      console.log("Already up to date. Use --force to re-download.");
      return;
    }
  }

  // find minimal distribution filename from index
  const minimalFile = resolved.files.find((f) => f.type === "minimal");
  if (!minimalFile) throw new Error("No minimal distribution found for this version");

  const url = `${CEF_CDN_BASE}/${minimalFile.name}`;
  const tmpArchive = join(import.meta.dir, "..", `cef-download.tar.bz2`);
  const tmpExtract = VENDORS_CEF + ".tmp";

  try {
    await download(url, tmpArchive);

    // verify sha1
    if (minimalFile.sha1) {
      console.log("Verifying SHA-1...");
      const hasher = new CryptoHasher("sha1");
      hasher.update(readFileSync(tmpArchive));
      const actual = hasher.digest("hex");
      if (actual !== minimalFile.sha1) {
        throw new Error(`SHA-1 mismatch: expected ${minimalFile.sha1}, got ${actual}`);
      }
    }

    // extract to temp dir, then swap
    if (existsSync(tmpExtract)) rmSync(tmpExtract, { recursive: true, force: true });
    await extract(tmpArchive, tmpExtract);

    if (existsSync(VENDORS_CEF)) rmSync(VENDORS_CEF, { recursive: true, force: true });
    renameSync(tmpExtract, VENDORS_CEF);

    writeFileSync(VERSION_STAMP, fullVersion + "\n");
    console.log(`Done. CEF installed at ${VENDORS_CEF}`);
  } finally {
    if (existsSync(tmpArchive)) rmSync(tmpArchive);
    if (existsSync(tmpExtract)) rmSync(tmpExtract, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
