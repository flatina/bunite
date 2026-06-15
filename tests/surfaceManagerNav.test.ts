import { beforeEach, describe, expect, test } from "bun:test";
// Side-effect import first — SurfaceManager direct import trips TDZ via the
// App ↔ SurfaceBrowserIPC ↔ SurfaceManager cycle.
import "../package/src/host/core/SurfaceBrowserIPC";
import type { BrowserView } from "../package/src/host/core/BrowserView";
import {
  createSurfaceCapImpl,
  disposeSurfaceState,
  emitSurfaceEvent,
  seedNavigationState,
} from "../package/src/host/core/SurfaceManager";
import {
  removeSurfacesForHostView,
  trackSurface,
  untrackSurface,
} from "../package/src/host/core/SurfaceRegistry";
import type { SurfaceEvent } from "../package/src/rpc/framework";

const stubView = { remove() {} } as unknown as BrowserView;

const HOST = 1;
const SID = 100;

function captureEvents(): { events: SurfaceEvent[]; abort: AbortController } {
  const cap = createSurfaceCapImpl(HOST);
  const events: SurfaceEvent[] = [];
  const abort = new AbortController();
  const stream = cap.surfaceEvents({ surfaceId: SID }, { signal: abort.signal } as any);
  (async () => {
    for await (const e of stream) events.push(e);
  })().catch(() => {});
  return { events, abort };
}

function readState() {
  const cap = createSurfaceCapImpl(HOST);
  return cap.getNavigationState({ surfaceId: SID }, {} as any) as {
    lastLoadEpoch: number;
    isLoading: boolean;
    currentUrl: string;
  };
}

describe("SurfaceManager — navigation epoch", () => {
  beforeEach(() => {
    removeSurfacesForHostView(HOST);
    disposeSurfaceState(SID);
    trackSurface(SID, { view: stubView, hostViewId: HOST, hidden: false });
  });

  test("seeds initial currentUrl", () => {
    seedNavigationState(SID, "https://seed.example/");
    const s = readState();
    expect(s.lastLoadEpoch).toBe(0);
    expect(s.isLoading).toBe(false);
    expect(s.currentUrl).toBe("https://seed.example/");
  });

  test("navigate arm bumps epoch and updates currentUrl", () => {
    seedNavigationState(SID, "https://seed/");
    emitSurfaceEvent(HOST, SID, { type: "navigate", url: "https://a/" });
    expect(readState()).toEqual({ lastLoadEpoch: 1, isLoading: false, currentUrl: "https://a/" });
    emitSurfaceEvent(HOST, SID, { type: "navigate", url: "https://b/" });
    expect(readState()).toEqual({ lastLoadEpoch: 2, isLoading: false, currentUrl: "https://b/" });
  });

  test("load-start / load-finish toggle isLoading; epoch unchanged", () => {
    emitSurfaceEvent(HOST, SID, { type: "load-start", url: "https://x/" });
    expect(readState().isLoading).toBe(true);
    expect(readState().lastLoadEpoch).toBe(0);
    emitSurfaceEvent(HOST, SID, { type: "navigate", url: "https://x/" });
    expect(readState().lastLoadEpoch).toBe(1);
    emitSurfaceEvent(HOST, SID, { type: "load-finish", url: "https://x/" });
    expect(readState().isLoading).toBe(false);
    expect(readState().lastLoadEpoch).toBe(1);
  });

  test("load-fail clears isLoading", () => {
    emitSurfaceEvent(HOST, SID, { type: "load-start", url: "https://x/" });
    emitSurfaceEvent(HOST, SID, { type: "load-fail", url: "https://x/", reason: "boom" });
    expect(readState().isLoading).toBe(false);
  });

  test("emitted events carry the current epoch", async () => {
    const { events, abort } = captureEvents();
    await new Promise((r) => setTimeout(r, 0)); // let subscribe register
    emitSurfaceEvent(HOST, SID, { type: "load-start", url: "https://x/" });
    emitSurfaceEvent(HOST, SID, { type: "navigate", url: "https://x/" });
    emitSurfaceEvent(HOST, SID, { type: "load-finish", url: "https://x/" });
    emitSurfaceEvent(HOST, SID, { type: "title-change", title: "X" });
    await new Promise((r) => setTimeout(r, 0));
    abort.abort();
    expect(events.map((e) => ({ type: e.type, epoch: e.epoch }))).toEqual([
      { type: "load-start", epoch: 0 },
      { type: "navigate", epoch: 1 },
      { type: "load-finish", epoch: 1 },
      { type: "title-change", epoch: 1 },
    ]);
  });

  test("events dropped after dispose (no state resurrection)", () => {
    emitSurfaceEvent(HOST, SID, { type: "navigate", url: "https://a/" });
    expect(readState().lastLoadEpoch).toBe(1);
    untrackSurface(SID);
    // Late event after dispose must not mutate state nor resurrect it.
    emitSurfaceEvent(HOST, SID, { type: "navigate", url: "https://b/" });
    // Re-track to read state; should be fresh defaults, not bumped.
    trackSurface(SID, { view: stubView, hostViewId: HOST, hidden: false });
    expect(readState()).toEqual({ lastLoadEpoch: 0, isLoading: false, currentUrl: "" });
  });
});
