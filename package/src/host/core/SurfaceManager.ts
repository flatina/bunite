import { BrowserView } from "./BrowserView";
import {
  trackSurface, untrackSurface, getOwnedSurface,
  getHostSurfaceIds, getSurfaceRecord, onSurfaceDispose,
  MAX_SURFACES_PER_HOST
} from "./SurfaceRegistry";
import {
  SurfaceCap, type ImplOf, IpcError,
  type SurfaceEvent, type SurfaceEventBase, type DialogEvent, type ConsoleEntry,
  type NavigationState, type DownloadEvent, type WaitForDownloadResult,
} from "../../rpc/index";
import { Stream } from "../../rpc/stream";

function applyHostOffset(hostView: BrowserView, x: number, y: number) {
  return { x: x + hostView.frame.x, y: y + hostView.frame.y };
}

type SurfaceInitCallback = (surfaceId: number, hostViewId: number, view: BrowserView) => void;
const initCallbacks: SurfaceInitCallback[] = [];

export function onSurfaceInit(cb: SurfaceInitCallback) {
  initCallbacks.push(cb);
}

type SurfaceEventEmit = (event: { surfaceId: number; event: SurfaceEvent }) => void;
const surfaceEventSubs = new Map<number, Set<SurfaceEventEmit>>();

export function emitSurfaceEvent(
  hostViewId: number,
  surfaceId: number,
  event: SurfaceEventBase,
) {
  // Drop late events after dispose so dead surfaceIds don't resurrect state.
  if (!getSurfaceRecord(surfaceId)) return;
  // Mutate before the subscriber guard so `getNavigationState` stays correct.
  const state = getOrCreateState(surfaceId);
  if (event.type === "navigate") {
    state.lastLoadEpoch++;
    state.currentUrl = event.url;
  } else if (event.type === "load-start") {
    state.isLoading = true;
  } else if (event.type === "load-finish" || event.type === "load-fail") {
    state.isLoading = false;
  }
  const stamped: SurfaceEvent = { ...event, epoch: state.lastLoadEpoch };
  const subs = surfaceEventSubs.get(hostViewId);
  if (!subs) return;
  for (const emit of subs) emit({ surfaceId, event: stamped });
}

export function seedNavigationState(surfaceId: number, initialUrl: string) {
  const state = getOrCreateState(surfaceId);
  if (state.currentUrl === "") state.currentUrl = initialUrl;
}

type DialogEmit = (event: { surfaceId: number; event: DialogEvent }) => void;
const dialogSubs = new Map<number, Set<DialogEmit>>();

type ConsoleEmit = (event: { surfaceId: number; entry: ConsoleEntry }) => void;
const consoleSubs = new Map<number, Set<ConsoleEmit>>();

type DownloadEmit = (event: { surfaceId: number; event: DownloadEvent }) => void;
const downloadSubs = new Map<number, Set<DownloadEmit>>();

type PendingPopup = {
  newSurfaceId: number;
  openerHostViewId: number;
  openerSurfaceId: number;
  url: string;
  disposition: "tab" | "window" | "popup";
  timer: ReturnType<typeof setTimeout> | null;
  armTs: number;  // arm emit timestamp for the 60s extend cap
};
const pendingPopups = new Map<number, PendingPopup>();
const POPUP_ADOPT_TIMEOUT_MS = 5000;
const POPUP_EXTEND_CAP_MS = 60_000;
// Capped log so callers calling extendPopupTimeout after resolution get a
// distinct error code instead of bare not_found.
const popupResolutionLog = new Map<number, "adopted" | "dismissed">();
const POPUP_RESOLUTION_LOG_MAX = 64;
function recordResolution(id: number, kind: "adopted" | "dismissed") {
  if (popupResolutionLog.size >= POPUP_RESOLUTION_LOG_MAX) {
    const firstKey = popupResolutionLog.keys().next().value;
    if (firstKey !== undefined) popupResolutionLog.delete(firstKey);
  }
  popupResolutionLog.set(id, kind);
  popupCounters[kind] += 1;
}

// Process-lifetime popup lifecycle counters; surfaced via RuntimeCap.popupMetrics.
const popupCounters = { armed: 0, adopted: 0, dismissed: 0, timeoutFired: 0, extended: 0 };
export function getPopupMetricsSnapshot() { return { ...popupCounters }; }

/** Called when a backend mints a popup view. Stashes the pending adoption +
 *  arms a timer that auto-dismisses if the host doesn't respond. */
export function emitPopupRequested(
  hostViewId: number,
  openerSurfaceId: number,
  args: { newSurfaceId: number; url: string; disposition: "tab" | "window" | "popup" },
) {
  const armTs = Date.now();
  popupCounters.armed += 1;
  const entry: PendingPopup = {
    newSurfaceId: args.newSurfaceId,
    openerHostViewId: hostViewId,
    openerSurfaceId,
    url: args.url,
    disposition: args.disposition,
    timer: null,
    armTs,
  };
  entry.timer = setTimeout(() => {
    if (!pendingPopups.delete(args.newSurfaceId)) return;
    popupCounters.timeoutFired += 1;
    recordResolution(args.newSurfaceId, "dismissed");
    BrowserView.dismissPopupById(args.newSurfaceId);
  }, POPUP_ADOPT_TIMEOUT_MS);
  pendingPopups.set(args.newSurfaceId, entry);
  emitSurfaceEvent(hostViewId, openerSurfaceId, {
    type: "popup",
    url: args.url,
    disposition: args.disposition,
    openerSurfaceId,
    newSurfaceId: args.newSurfaceId,
  });
}
type DownloadWaiter = {
  /** Resolved on the next `completed` event (or `failed`/`blocked`). */
  resolve: (r: WaitForDownloadResult) => void;
  /** Captured at registration; only events with `id` started after this are eligible. */
  pendingId: string | null;
};
const downloadWaiters = new Map<number, DownloadWaiter[]>();
const downloadStartedMeta = new Map<number, Map<string, { url: string; suggestedFilename: string; mimeType?: string; sizeBytes?: number }>>();
// Recent started events that no waiter has claimed yet — lets a `waitForDownload`
// registered *after* the started event still bind. Per-surface, trimmed to 30s.
const recentUnownedStarts = new Map<number, { id: string; ts: number }[]>();

export function emitDownload(hostViewId: number, surfaceId: number, event: DownloadEvent) {
  if (event.kind === "started") {
    let bySurface = downloadStartedMeta.get(surfaceId);
    if (!bySurface) { bySurface = new Map(); downloadStartedMeta.set(surfaceId, bySurface); }
    bySurface.set(event.id, { url: event.url, suggestedFilename: event.suggestedFilename, mimeType: event.mimeType, sizeBytes: event.sizeBytes });
    // Track unowned started events so a waitForDownload registering AFTER the
    // started event can still bind. Trimmed to recent 30s on each insert.
    let recents = recentUnownedStarts.get(surfaceId);
    if (!recents) { recents = []; recentUnownedStarts.set(surfaceId, recents); }
    const now = Date.now();
    recents.push({ id: event.id, ts: now });
    while (recents.length && now - recents[0].ts > 30_000) recents.shift();
    const queue = downloadWaiters.get(surfaceId);
    if (queue) for (const w of queue) if (w.pendingId === null) {
      w.pendingId = event.id;
      // Take the unowned entry out — it's now bound.
      const idx = recents.findIndex((r) => r.id === event.id);
      if (idx >= 0) recents.splice(idx, 1);
      break;
    }
  }
  const subs = downloadSubs.get(hostViewId);
  if (subs) for (const emit of subs) emit({ surfaceId, event });
  if (event.kind === "completed" || event.kind === "failed" || event.kind === "blocked") {
    const queue = downloadWaiters.get(surfaceId);
    if (queue) {
      // First match by id (started → terminal pair). Else for blocked-without-started
      // (policy=block emits only blocked), bind to the first waiting waiter.
      let idx = queue.findIndex((w) => w.pendingId === event.id);
      if (idx < 0 && event.kind === "blocked") idx = queue.findIndex((w) => w.pendingId === null);
      if (idx >= 0) {
        const [waiter] = queue.splice(idx, 1);
        if (event.kind === "completed") {
          const meta = downloadStartedMeta.get(surfaceId)?.get(event.id);
          waiter.resolve({
            ok: true, id: event.id, localPath: event.localPath,
            url: meta?.url ?? "", suggestedFilename: meta?.suggestedFilename ?? "",
            mimeType: meta?.mimeType, sizeBytes: meta?.sizeBytes,
          });
        } else if (event.kind === "failed") {
          waiter.resolve({ ok: false, code: "failed", message: event.reason });
        } else {
          waiter.resolve({ ok: false, code: "blocked", message: event.reason });
        }
      }
    }
    downloadStartedMeta.get(surfaceId)?.delete(event.id);
  }
}

const CONSOLE_BUFFER_LIMIT = 200;
const DEFAULT_DIALOG_TIMEOUT_MS = 5000;

type PendingDialog = {
  requestId: number;
  originalKind: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  timer: ReturnType<typeof setTimeout> | null;
};

type SurfaceState = {
  consoleBuffer: ConsoleEntry[];
  dialogTimeoutMs: number | null;  // null = no auto-dismiss
  pendingDialogs: Map<number, PendingDialog>;
  lastLoadEpoch: number;
  isLoading: boolean;
  currentUrl: string;
};

const surfaceState = new Map<number, SurfaceState>();

function getOrCreateState(surfaceId: number): SurfaceState {
  let s = surfaceState.get(surfaceId);
  if (!s) {
    s = {
      consoleBuffer: [],
      dialogTimeoutMs: DEFAULT_DIALOG_TIMEOUT_MS,
      pendingDialogs: new Map(),
      lastLoadEpoch: 0,
      isLoading: false,
      currentUrl: "",
    };
    surfaceState.set(surfaceId, s);
  }
  return s;
}

export function disposeSurfaceState(surfaceId: number) {
  const s = surfaceState.get(surfaceId);
  if (s) {
    for (const p of s.pendingDialogs.values()) if (p.timer) clearTimeout(p.timer);
    surfaceState.delete(surfaceId);
  }
  const waiters = downloadWaiters.get(surfaceId);
  if (waiters) {
    for (const w of waiters) w.resolve({ ok: false, code: "not_supported", message: "surface destroyed" });
    downloadWaiters.delete(surfaceId);
  }
  downloadStartedMeta.delete(surfaceId);
  recentUnownedStarts.delete(surfaceId);
}

// Wire dispose to any untrack path (remove + removeSurfacesForHostView).
onSurfaceDispose(disposeSurfaceState);

export function clearConsoleBuffer(surfaceId: number) {
  const s = surfaceState.get(surfaceId);
  if (s) s.consoleBuffer.length = 0;
}

export function emitDialog(hostViewId: number, surfaceId: number, event: DialogEvent) {
  const subs = dialogSubs.get(hostViewId);
  if (!subs) return;
  for (const emit of subs) emit({ surfaceId, event });
}

export function emitConsole(hostViewId: number, surfaceId: number, entry: ConsoleEntry) {
  const state = getOrCreateState(surfaceId);
  state.consoleBuffer.push(entry);
  if (state.consoleBuffer.length > CONSOLE_BUFFER_LIMIT) {
    state.consoleBuffer.splice(0, state.consoleBuffer.length - CONSOLE_BUFFER_LIMIT);
  }
  const subs = consoleSubs.get(hostViewId);
  if (!subs) return;
  for (const emit of subs) emit({ surfaceId, entry });
}

/** Called by SurfaceBrowserIPC on native `dialog` event. Stashes pending entry
 *  + arms the auto-dismiss timer, then broadcasts to subscribers. */
export function registerDialogRequest(
  hostViewId: number,
  surfaceId: number,
  request: { requestId: number; kind: "alert" | "confirm" | "prompt" | "beforeunload"; message: string; defaultPrompt?: string }
) {
  const state = getOrCreateState(surfaceId);
  const view = getSurfaceRecord(surfaceId)?.view;

  const entry: PendingDialog = {
    requestId: request.requestId,
    originalKind: request.kind,
    message: request.message,
    timer: null,
  };
  if (state.dialogTimeoutMs !== null && view) {
    entry.timer = setTimeout(() => {
      if (!state.pendingDialogs.delete(request.requestId)) return;
      view.respondToDialog(request.requestId, false);
      emitDialog(hostViewId, surfaceId, {
        kind: "auto-dismissed",
        originalKind: entry.originalKind,
        message: entry.message,
      });
    }, state.dialogTimeoutMs);
  }
  state.pendingDialogs.set(request.requestId, entry);

  emitDialog(hostViewId, surfaceId, {
    kind: request.kind,
    requestId: request.requestId,
    message: request.message,
    defaultPrompt: request.defaultPrompt,
  });
}

function consumePendingDialog(surfaceId: number, requestId: number): boolean {
  const state = surfaceState.get(surfaceId);
  if (!state) return false;
  const entry = state.pendingDialogs.get(requestId);
  if (!entry) return false;
  if (entry.timer) clearTimeout(entry.timer);
  state.pendingDialogs.delete(requestId);
  return true;
}

export function createSurfaceCapImpl(hostViewId: number): ImplOf<typeof SurfaceCap> {
  function ownedSurface(surfaceId: number) {
    const record = getOwnedSurface(surfaceId, { viewId: hostViewId });
    return record;
  }

  return {
    init: async ({ src, x, y, width, height, hidden = false }) => {
      const hostView = BrowserView.getById(hostViewId);
      if (!hostView) throw new IpcError({ code: "not_found", message: `Host view not found: ${hostViewId}` });
      if (!hostView.windowId) throw new IpcError({ code: "failed_precondition", message: `Host window not found` });

      const hostIds = getHostSurfaceIds(hostViewId);
      if (hostIds && hostIds.size >= MAX_SURFACES_PER_HOST) {
        throw new IpcError({ code: "resource_exhausted", message: `Surface limit reached (${MAX_SURFACES_PER_HOST})` });
      }

      const offset = applyHostOffset(hostView, x, y);
      const view = new BrowserView({
        url: src,
        windowId: hostView.windowId,
        appresRoot: hostView.appresRoot,
        frame: { x: offset.x, y: offset.y, width, height },
        autoResize: false,
      });
      trackSurface(view.id, { view, hostViewId, hidden });
      seedNavigationState(view.id, src);
      try {
        await view.whenReady();
      } catch {
        untrackSurface(view.id);
        view.remove();
        throw new IpcError({ code: "unavailable", message: "Surface browser creation failed or timed out" });
      }
      for (const cb of initCallbacks) cb(view.id, hostViewId, view);
      if (hidden) view.setVisible(false); else view.bringToFront();
      return { surfaceId: view.id };
    },

    resize: ({ surfaceId, x, y, w, h }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return;
      const hostView = BrowserView.getById(hostViewId);
      if (!hostView) return;
      const offset = applyHostOffset(hostView, x, y);
      record.view.setBoundsAsync(offset.x, offset.y, w, h);
    },

    remove: ({ surfaceId }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return;
      untrackSurface(surfaceId);
      disposeSurfaceState(surfaceId);
      record.view.remove();
    },

    setHidden: ({ surfaceId, hidden }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return;
      record.hidden = hidden;
      record.view.setVisible(!hidden);
      if (!hidden) record.view.bringToFront();
    },

    setMasks: ({ surfaceId, masks }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return;
      const hostView = BrowserView.getById(hostViewId);
      if (!hostView) return;
      const offset = applyHostOffset(hostView, 0, 0);
      record.view.setMaskRegion(masks.map((m) => ({
        x: m.x + offset.x,
        y: m.y + offset.y,
        w: m.w,
        h: m.h,
      })));
    },

    setAllPassthrough: ({ passthrough }) => {
      const ids = getHostSurfaceIds(hostViewId);
      if (!ids) return;
      for (const surfaceId of ids) {
        const record = getSurfaceRecord(surfaceId);
        record?.view.setInputPassthrough(passthrough);
      }
    },

    bringAllVisiblesToFront: () => {
      const ids = getHostSurfaceIds(hostViewId);
      if (!ids) return;
      for (const surfaceId of ids) {
        const record = getSurfaceRecord(surfaceId);
        if (record && !record.hidden) record.view.bringToFront();
      }
    },

    navigate: ({ surfaceId, url }) => {
      const record = ownedSurface(surfaceId);
      record?.view.loadURL(url);
    },

    goBack: ({ surfaceId }) => {
      const record = ownedSurface(surfaceId);
      record?.view.goBack();
    },

    reload: ({ surfaceId }) => {
      const record = ownedSurface(surfaceId);
      record?.view.reload();
    },

    evaluate: async ({ surfaceId, script, frameId }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return { ok: false, code: "not_supported", message: "surface not found" };
      return record.view.evaluate(script, frameId);
    },

    click: ({ surfaceId, ...args }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return;
      record.view.click(args);
    },

    type: ({ surfaceId, text }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return;
      record.view.type(text);
    },

    press: ({ surfaceId, key, modifiers, action }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return;
      record.view.press(key, modifiers, action);
    },

    scroll: ({ surfaceId, ...args }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return;
      record.view.scroll(args);
    },

    mouse: ({ surfaceId, ...args }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return;
      record.view.mouse(args);
    },

    screenshot: async ({ surfaceId, format = "png", quality = 90 }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return { ok: false as const, code: "not_supported" as const, message: "surface not found" };
      return record.view.screenshot(format, quality);
    },

    waitForSelector: async ({ surfaceId, selector, timeoutMs = 5000, frameId }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return { ok: false as const, code: "runtime_error" as const, message: "surface not found" };
      const deadline = Date.now() + timeoutMs;
      const expr = `!!document.querySelector(${JSON.stringify(selector)})`;
      while (Date.now() < deadline) {
        const res = await record.view.evaluate(expr, frameId);
        if (res.ok && res.value === true) return { ok: true as const };
        if (!res.ok && res.code !== "timeout") {
          const code = res.code === "cross_origin" ? "cross_origin" as const : "runtime_error" as const;
          return { ok: false as const, code, message: res.message };
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return { ok: false as const, code: "timeout" as const, message: `selector ${JSON.stringify(selector)} not found within ${timeoutMs}ms` };
    },

    waitForFunction: async ({ surfaceId, expression, timeoutMs = 5000, pollIntervalMs = 50, frameId }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return { ok: false as const, code: "runtime_error" as const, message: "surface not found" };
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const res = await record.view.evaluate(expression, frameId);
        if (res.ok && res.value) return { ok: true as const };
        if (!res.ok && res.code !== "timeout") {
          const code = res.code === "cross_origin" ? "cross_origin" as const : "runtime_error" as const;
          return { ok: false as const, code, message: res.message };
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
      return { ok: false as const, code: "timeout" as const, message: `function did not satisfy within ${timeoutMs}ms` };
    },

    respondToDialog: ({ surfaceId, requestId, accept, text }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return;
      if (!consumePendingDialog(surfaceId, requestId)) return;  // stale or already auto-dismissed
      record.view.respondToDialog(requestId, accept, text);
    },

    setDialogTimeout: ({ surfaceId, ms }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return;
      const state = getOrCreateState(surfaceId);
      state.dialogTimeoutMs = ms;
    },

    getConsoleBuffer: ({ surfaceId, clear }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return [];
      const state = getOrCreateState(surfaceId);
      const snapshot = state.consoleBuffer.slice();
      if (clear) state.consoleBuffer.length = 0;
      return snapshot;
    },

    capabilities: ({ surfaceId }) => {
      const record = ownedSurface(surfaceId);
      if (!record) {
        return {
          evaluate: false, crossOriginEval: false, surfaceEvents: false,
          nativeInputTrusted: false, click: false, type: false, press: false,
          scroll: false, mouse: false, dialogs: false, console: false,
          screenshot: false, accessibilitySnapshot: false, getBoundingRect: false,
          frames: false, downloads: false, popups: false, resolveAndClick: false,
        };
      }
      return record.view.capabilities();
    },

    surfaceEvents: ({ surfaceId: filterId }) => Stream.from<SurfaceEvent>((emit, signal) => {
      let subs = surfaceEventSubs.get(hostViewId);
      if (!subs) {
        subs = new Set();
        surfaceEventSubs.set(hostViewId, subs);
      }
      const wrapped: SurfaceEventEmit = ({ surfaceId, event }) => {
        if (surfaceId === filterId) emit(event);
      };
      subs.add(wrapped);
      signal.addEventListener("abort", () => {
        const set = surfaceEventSubs.get(hostViewId);
        if (!set) return;
        set.delete(wrapped);
        if (set.size === 0) surfaceEventSubs.delete(hostViewId);
      });
    }),

    dialogs: ({ surfaceId: filterId }) => Stream.from<DialogEvent>((emit, signal) => {
      let subs = dialogSubs.get(hostViewId);
      if (!subs) {
        subs = new Set();
        dialogSubs.set(hostViewId, subs);
      }
      const wrapped: DialogEmit = ({ surfaceId, event }) => {
        if (surfaceId === filterId) emit(event);
      };
      subs.add(wrapped);
      signal.addEventListener("abort", () => {
        const set = dialogSubs.get(hostViewId);
        if (!set) return;
        set.delete(wrapped);
        if (set.size === 0) dialogSubs.delete(hostViewId);
      });
    }),

    getNavigationState: ({ surfaceId }): NavigationState => {
      const record = ownedSurface(surfaceId);
      if (!record) return { lastLoadEpoch: 0, isLoading: false, currentUrl: "" };
      const state = getOrCreateState(surfaceId);
      return {
        lastLoadEpoch: state.lastLoadEpoch,
        isLoading: state.isLoading,
        currentUrl: state.currentUrl,
      };
    },

    accessibilitySnapshot: async ({ surfaceId, interestingOnly = true }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return { ok: false as const, code: "runtime_error" as const, message: "surface not found" };
      return record.view.accessibilitySnapshot(interestingOnly);
    },

    getBoundingRect: async ({ surfaceId, selector, frameId }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return { ok: false as const, code: "runtime_error" as const, message: "surface not found" };
      const expr = `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;var r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,visible:r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth};})()`;
      const res = await record.view.evaluate(expr, frameId);
      if (!res.ok) {
        const code = res.code === "cross_origin" ? "cross_origin" as const
          : res.code === "not_supported" ? "not_supported" as const
          : "runtime_error" as const;
        return { ok: false as const, code, message: res.message };
      }
      const v = res.value as null | { x: number; y: number; width: number; height: number; visible: boolean };
      if (!v) return { ok: false as const, code: "not_found" as const, message: `selector ${JSON.stringify(selector)} not found` };
      return { ok: true as const, rect: { x: v.x, y: v.y, width: v.width, height: v.height }, visible: v.visible };
    },

    listFrames: async ({ surfaceId }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return { ok: false as const, code: "runtime_error" as const, message: "surface not found" };
      return record.view.listFrames();
    },

    resolveAndClick: async (args) => {
      const record = ownedSurface(args.surfaceId);
      if (!record) return { ok: false as const, code: "runtime_error" as const, message: "surface not found" };
      if (!record.view.capabilities().resolveAndClick) {
        return { ok: false as const, code: "not_supported" as const, message: "resolveAndClick not supported on this backend" };
      }
      return record.view.resolveAndClick(args);
    },

    downloadEvents: ({ surfaceId: filterId }) => Stream.from<DownloadEvent>((emit, signal) => {
      let subs = downloadSubs.get(hostViewId);
      if (!subs) { subs = new Set(); downloadSubs.set(hostViewId, subs); }
      const wrapped: DownloadEmit = ({ surfaceId, event }) => {
        if (surfaceId === filterId) emit(event);
      };
      subs.add(wrapped);
      signal.addEventListener("abort", () => {
        const set = downloadSubs.get(hostViewId);
        if (!set) return;
        set.delete(wrapped);
        if (set.size === 0) downloadSubs.delete(hostViewId);
      });
    }),

    waitForDownload: async ({ surfaceId, timeoutMs = 30000 }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return { ok: false as const, code: "not_supported" as const, message: "surface not found" };
      if (!record.view.capabilities().downloads) {
        return { ok: false as const, code: "not_supported" as const, message: "downloads not supported on this backend" };
      }
      return new Promise<WaitForDownloadResult>((resolve) => {
        // If a `started` already arrived without a waiter, consume it.
        const recents = recentUnownedStarts.get(surfaceId);
        const claimed = recents?.shift();
        const waiter: DownloadWaiter = {
          resolve: (r) => { clearTimeout(timer); resolve(r); },
          pendingId: claimed?.id ?? null,
        };
        let queue = downloadWaiters.get(surfaceId);
        if (!queue) { queue = []; downloadWaiters.set(surfaceId, queue); }
        queue.push(waiter);
        const timer = setTimeout(() => {
          const q = downloadWaiters.get(surfaceId);
          if (!q) return;
          const idx = q.indexOf(waiter);
          if (idx >= 0) q.splice(idx, 1);
          resolve({ ok: false, code: "timeout", message: `no download started within ${timeoutMs}ms` });
        }, timeoutMs);
      });
    },

    setDownloadPolicy: ({ surfaceId, policy, downloadDir }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return;
      if (!record.view.capabilities().downloads) return;  // mac/linux silent no-op signal — caller should gate on cap.
      record.view.setDownloadPolicy(policy, downloadDir);
    },

    acceptPopup: async ({ newSurfaceId, hostViewId: targetHostId, bounds }) => {
      const pending = pendingPopups.get(newSurfaceId);
      if (!pending) return { ok: false as const, code: "not_found" as const, message: "popup not pending" };
      // Only the opener's host page can adopt the popup. The target host
      // (where the new pane lands) is a separate decision.
      if (pending.openerHostViewId !== hostViewId) {
        return { ok: false as const, code: "not_found" as const, message: "popup not owned by this host" };
      }
      const targetHost = BrowserView.getById(targetHostId);
      if (!targetHost || !targetHost.windowId) {
        // Don't consume pending state on validation failure — host can retry
        // with a different target until the auto-dismiss timer fires.
        return { ok: false as const, code: "host_view_invalid" as const, message: "host view not found" };
      }
      const existing = getHostSurfaceIds(targetHostId);
      if (existing && existing.size >= MAX_SURFACES_PER_HOST) {
        return { ok: false as const, code: "host_view_invalid" as const, message: `host surface limit reached (${MAX_SURFACES_PER_HOST})` };
      }
      if (pending.timer) clearTimeout(pending.timer);
      pendingPopups.delete(newSurfaceId);
      recordResolution(newSurfaceId, "adopted");
      const offset = applyHostOffset(targetHost, bounds.x, bounds.y);
      const view = BrowserView.adopt({
        nativeViewId: newSurfaceId,
        hostWindowId: targetHost.windowId,
        bounds: { x: offset.x, y: offset.y, width: bounds.width, height: bounds.height },
        appresRoot: targetHost.appresRoot,
      });
      trackSurface(view.id, { view, hostViewId: targetHostId, hidden: false });
      seedNavigationState(view.id, pending.url);
      for (const cb of initCallbacks) cb(view.id, targetHostId, view);
      return { ok: true as const };
    },

    dismissPopup: ({ newSurfaceId }) => {
      const pending = pendingPopups.get(newSurfaceId);
      if (!pending) return;
      if (pending.openerHostViewId !== hostViewId) return;  // not this host's popup
      if (pending.timer) clearTimeout(pending.timer);
      pendingPopups.delete(newSurfaceId);
      recordResolution(newSurfaceId, "dismissed");
      BrowserView.dismissPopupById(newSurfaceId);
    },

    extendPopupTimeout: ({ newSurfaceId, gracePeriodMs }) => {
      if (!Number.isFinite(gracePeriodMs) || gracePeriodMs <= 0) {
        return { ok: false as const, code: "not_found" as const, message: "gracePeriodMs must be a positive finite number" };
      }
      const pending = pendingPopups.get(newSurfaceId);
      if (!pending) {
        const prior = popupResolutionLog.get(newSurfaceId);
        if (prior === "adopted") return { ok: false as const, code: "already_adopted" as const, message: "popup adopted" };
        if (prior === "dismissed") return { ok: false as const, code: "already_dismissed" as const, message: "popup dismissed" };
        return { ok: false as const, code: "not_found" as const, message: "popup not pending" };
      }
      if (pending.openerHostViewId !== hostViewId) {
        return { ok: false as const, code: "not_found" as const, message: "popup not owned by this host" };
      }
      const now = Date.now();
      const requested = now + gracePeriodMs;
      const cap = pending.armTs + POPUP_EXTEND_CAP_MS;
      if (requested > cap) {
        return { ok: false as const, code: "cap_exceeded" as const, message: `extend exceeds ${POPUP_EXTEND_CAP_MS}ms cap since arm` };
      }
      if (pending.timer) clearTimeout(pending.timer);
      pending.timer = setTimeout(() => {
        if (!pendingPopups.delete(newSurfaceId)) return;
        popupCounters.timeoutFired += 1;
        recordResolution(newSurfaceId, "dismissed");
        BrowserView.dismissPopupById(newSurfaceId);
      }, gracePeriodMs);
      popupCounters.extended += 1;
      return { ok: true as const, deadlineMs: requested };
    },

    consoleEvents: ({ surfaceId: filterId }) => Stream.from<ConsoleEntry>((emit, signal) => {
      let subs = consoleSubs.get(hostViewId);
      if (!subs) {
        subs = new Set();
        consoleSubs.set(hostViewId, subs);
      }
      const wrapped: ConsoleEmit = ({ surfaceId, entry }) => {
        if (surfaceId === filterId) emit(entry);
      };
      subs.add(wrapped);
      signal.addEventListener("abort", () => {
        const set = consoleSubs.get(hostViewId);
        if (!set) return;
        set.delete(wrapped);
        if (set.size === 0) consoleSubs.delete(hostViewId);
      });
    }),
  };
}
