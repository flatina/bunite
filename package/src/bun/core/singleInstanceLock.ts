import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SingleInstanceLock =
  | { acquired: true; release(): void }
  | { acquired: false; holderPid?: number };

export function lockPathFor(key: string): string {
  const slug = createHash("sha1").update(key).digest("hex").slice(0, 16);
  return join(tmpdir(), `bunite-instance-${slug}.lock`);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EPERM means the process exists but is owned by someone else.
    return code === "EPERM";
  }
}

function readHolderPid(path: string): number | undefined {
  try {
    const pid = parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Acquire a process-wide single-instance lock keyed by `key`. Returns a release
 * handle on success, or the current holder's PID on contention. Dead-PID locks
 * are reclaimed automatically; in-flight contention (lockfile present but PID
 * not yet written / unreadable) is surfaced as `acquired: false` without a PID
 * rather than racing to unlink the contender's lockfile.
 *
 * Use BEFORE app.init() — second instance can prompt UX and exit instead of
 * crashing on engine-specific userDataDir locks.
 *
 * Caveats: `process.on("exit")` cleanup does not run on SIGKILL or crash; the
 * next instance reclaims via PID-liveness probe. PID reuse can mask a dead
 * original holder until the unrelated process exits.
 */
export function acquireSingleInstanceLock(key: string): SingleInstanceLock {
  const path = lockPathFor(key);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        // Verify ownership before unlinking — guards against deleting a lockfile
        // that has been reclaimed by another process if our exit was delayed.
        if (readHolderPid(path) === process.pid) {
          try { unlinkSync(path); } catch { /* already gone */ }
        }
        process.off("exit", release);
      };
      process.on("exit", release);
      return { acquired: true, release };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw e;

      const holderPid = readHolderPid(path);
      if (holderPid === undefined) {
        // Lockfile present but PID not written yet (contender between
        // openSync and writeFileSync) or content corrupt. Don't race to unlink.
        return { acquired: false };
      }
      if (isProcessAlive(holderPid)) {
        return { acquired: false, holderPid };
      }
      // Stale: holder is dead. Drop and retry once.
      try { unlinkSync(path); } catch { /* lost the race; loop retries */ }
    }
  }

  // Second attempt also lost the race — surface as contention without a PID.
  return { acquired: false };
}
