import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { acquireSingleInstanceLock, lockPathFor } from "../package/src/bun/core/singleInstanceLock";

const pathFor = lockPathFor;

const acquired: Array<{ release(): void }> = [];
const lockFiles: string[] = [];

afterEach(() => {
  for (const l of acquired.splice(0)) l.release();
  for (const p of lockFiles.splice(0)) {
    try { unlinkSync(p); } catch { /* gone */ }
  }
});

function uniqueKey(label: string): string {
  const key = `bunite-test-${label}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  lockFiles.push(pathFor(key));
  return key;
}

describe("acquireSingleInstanceLock", () => {
  test("first acquire succeeds and writes pid", () => {
    const key = uniqueKey("first");
    const r = acquireSingleInstanceLock(key);
    expect(r.acquired).toBe(true);
    if (!r.acquired) return;
    acquired.push(r);

    const path = pathFor(key);
    expect(existsSync(path)).toBe(true);
    expect(parseInt(readFileSync(path, "utf8"), 10)).toBe(process.pid);
  });

  test("second acquire while holder alive returns holderPid", () => {
    const key = uniqueKey("contention");
    const first = acquireSingleInstanceLock(key);
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;
    acquired.push(first);

    const second = acquireSingleInstanceLock(key);
    expect(second.acquired).toBe(false);
    if (second.acquired) return;
    expect(second.holderPid).toBe(process.pid);
  });

  test("release frees the lock for re-acquisition", () => {
    const key = uniqueKey("release");
    const first = acquireSingleInstanceLock(key);
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;
    first.release();
    expect(existsSync(pathFor(key))).toBe(false);

    const second = acquireSingleInstanceLock(key);
    expect(second.acquired).toBe(true);
    if (!second.acquired) return;
    acquired.push(second);
  });

  test("release is idempotent", () => {
    const key = uniqueKey("idempotent");
    const r = acquireSingleInstanceLock(key);
    expect(r.acquired).toBe(true);
    if (!r.acquired) return;
    r.release();
    expect(() => r.release()).not.toThrow();
  });

  test("stale lock (dead pid) is reclaimed", () => {
    const key = uniqueKey("stale");
    const path = pathFor(key);
    // PID 0 / negative / impossibly-large pids never identify a live process here.
    writeFileSync(path, "999999999");

    const r = acquireSingleInstanceLock(key);
    expect(r.acquired).toBe(true);
    if (!r.acquired) return;
    expect(parseInt(readFileSync(path, "utf8"), 10)).toBe(process.pid);
    acquired.push(r);
  });

  test("empty / non-numeric lock file returns contention without holderPid (TOCTOU-safe)", () => {
    const key = uniqueKey("empty");
    writeFileSync(pathFor(key), "");

    const r = acquireSingleInstanceLock(key);
    expect(r.acquired).toBe(false);
    if (r.acquired) return;
    expect(r.holderPid).toBeUndefined();

    // Empty / partial lockfile is not unlinked — contender may still be writing.
    expect(existsSync(pathFor(key))).toBe(true);
  });

  test("release() refuses to unlink a lockfile owned by another pid", () => {
    const key = uniqueKey("ownership");
    const r = acquireSingleInstanceLock(key);
    expect(r.acquired).toBe(true);
    if (!r.acquired) return;

    // Simulate the case where the lockfile was reclaimed by another process
    // (different PID) before our release fires.
    writeFileSync(pathFor(key), "999999999");
    r.release();
    expect(existsSync(pathFor(key))).toBe(true);
    expect(readFileSync(pathFor(key), "utf8")).toBe("999999999");

    unlinkSync(pathFor(key));
  });
});
