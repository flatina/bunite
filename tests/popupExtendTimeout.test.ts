import { describe, test, expect, beforeEach } from "bun:test";
import "../package/src/host/core/SurfaceBrowserIPC";
import {
  emitPopupRequested,
  createSurfaceCapImpl,
} from "../package/src/host/core/SurfaceManager";
import {
  trackSurface,
  removeSurfacesForHostView,
} from "../package/src/host/core/SurfaceRegistry";
import type { BrowserView } from "../package/src/host/core/BrowserView";

const stubView = { remove() {} } as unknown as BrowserView;
const HOST = 1;
const OPENER = 100;

function extend(newSurfaceId: number, gracePeriodMs: number) {
  const cap = createSurfaceCapImpl(HOST);
  return cap.extendPopupTimeout({ newSurfaceId, gracePeriodMs }, {} as any) as
    { ok: true; deadlineMs: number } | { ok: false; code: string; message: string };
}

function dismiss(newSurfaceId: number) {
  const cap = createSurfaceCapImpl(HOST);
  cap.dismissPopup({ newSurfaceId }, {} as any);
}

describe("SurfaceManager — extendPopupTimeout", () => {
  beforeEach(() => {
    removeSurfacesForHostView(HOST);
    trackSurface(OPENER, { view: stubView, hostViewId: HOST, hidden: false });
  });

  test("extend on unknown id → not_found", () => {
    const r = extend(0xdead, 10_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_found");
  });

  test("extend on pending popup → ok + deadline = now + grace", () => {
    emitPopupRequested(HOST, OPENER, { newSurfaceId: 0x80000001, url: "x", disposition: "popup" });
    const before = Date.now();
    const r = extend(0x80000001, 10_000);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.deadlineMs).toBeGreaterThanOrEqual(before + 10_000);
    dismiss(0x80000001);
  });

  test("extend beyond 60s cap → cap_exceeded", () => {
    emitPopupRequested(HOST, OPENER, { newSurfaceId: 0x80000002, url: "x", disposition: "popup" });
    const r = extend(0x80000002, 70_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cap_exceeded");
    dismiss(0x80000002);
  });

  test("extend after dismiss → already_dismissed", () => {
    emitPopupRequested(HOST, OPENER, { newSurfaceId: 0x80000003, url: "x", disposition: "popup" });
    dismiss(0x80000003);
    const r = extend(0x80000003, 10_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("already_dismissed");
  });

  test("extend is reset semantic — second call overwrites, not cumulative", () => {
    emitPopupRequested(HOST, OPENER, { newSurfaceId: 0x80000004, url: "x", disposition: "popup" });
    const r1 = extend(0x80000004, 10_000);
    const r2 = extend(0x80000004, 5_000);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      // r2 deadline (~ now+5s) must be strictly less than r1 deadline (~ now+10s).
      expect(r2.deadlineMs).toBeLessThan(r1.deadlineMs);
    }
    dismiss(0x80000004);
  });
});
