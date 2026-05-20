import { BrowserView } from "./BrowserView";
import {
  trackSurface, untrackSurface, getOwnedSurface,
  getHostSurfaceIds, getSurfaceRecord,
  MAX_SURFACES_PER_HOST
} from "./SurfaceRegistry";
import { SurfaceCap, type ImplOf, IpcError, type SurfaceEvent } from "../../rpc/index";
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

export function emitSurfaceEvent(hostViewId: number, surfaceId: number, event: SurfaceEvent) {
  const subs = surfaceEventSubs.get(hostViewId);
  if (!subs) return;
  for (const emit of subs) emit({ surfaceId, event });
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

    evaluate: async ({ surfaceId, script }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return { ok: false, code: "not_supported", message: "surface not found" };
      return record.view.evaluate(script);
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

    screenshot: async ({ surfaceId, format = "png", quality = 90 }) => {
      const record = ownedSurface(surfaceId);
      if (!record) return { ok: false as const, code: "not_supported" as const, message: "surface not found" };
      return record.view.screenshot(format, quality);
    },

    capabilities: ({ surfaceId }) => {
      const record = ownedSurface(surfaceId);
      if (!record) {
        return {
          evaluate: false, crossOriginEval: false, surfaceEvents: false,
          nativeInputTrusted: false, click: false, type: false, press: false,
          scroll: false, screenshot: false,
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
  };
}
