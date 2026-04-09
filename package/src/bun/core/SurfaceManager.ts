import { BrowserView } from "./BrowserView";

import type { GlobalIPCHandler } from "./App";

type SurfaceRecord = {
  view: BrowserView;
  hostViewId: number;
};

const MAX_SURFACES_PER_HOST = 32;

const surfaces = new Map<number, SurfaceRecord>();
const hostSurfaceIds = new Map<number, Set<number>>();

function trackSurface(surfaceId: number, record: SurfaceRecord) {
  surfaces.set(surfaceId, record);
  let ids = hostSurfaceIds.get(record.hostViewId);
  if (!ids) {
    ids = new Set();
    hostSurfaceIds.set(record.hostViewId, ids);
  }
  ids.add(surfaceId);
}

function untrackSurface(surfaceId: number) {
  const record = surfaces.get(surfaceId);
  if (!record) return;
  surfaces.delete(surfaceId);
  const ids = hostSurfaceIds.get(record.hostViewId);
  if (ids) {
    ids.delete(surfaceId);
    if (ids.size === 0) hostSurfaceIds.delete(record.hostViewId);
  }
}

function getOwnedSurface(surfaceId: number, ctx: { viewId: number }): SurfaceRecord | null {
  const record = surfaces.get(surfaceId);
  if (!record) return null;
  if (record.hostViewId !== ctx.viewId) throw new Error("Surface access denied.");
  return record;
}

// NOTE: hostView.frame is only updated via JS setBounds(), not when native
// anchoring resizes the view. This is correct for fill-anchored host views
// at (0,0), but will be stale if the host view moves independently.
// A proper fix requires native→JS frame-change events.
function applyHostOffset(hostView: BrowserView, x: number, y: number) {
  return { x: x + hostView.frame.x, y: y + hostView.frame.y };
}

function assertNum(v: unknown, label: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`Invalid ${label}`);
  return v;
}

function assertStr(v: unknown, label: string): string {
  if (typeof v !== "string") throw new Error(`Invalid ${label}`);
  return v;
}

function assertBool(v: unknown, label: string): boolean {
  if (typeof v !== "boolean") throw new Error(`Invalid ${label}`);
  return v;
}

function assertObj(v: unknown, label: string): Record<string, unknown> {
  if (!v || typeof v !== "object") throw new Error(`Invalid ${label}`);
  return v as Record<string, unknown>;
}

export function removeSurfacesForHostView(hostViewId: number) {
  const ids = hostSurfaceIds.get(hostViewId);
  if (!ids || ids.size === 0) return;

  for (const surfaceId of Array.from(ids)) {
    const record = surfaces.get(surfaceId);
    if (!record) continue;
    untrackSurface(surfaceId);
    record.view.remove();
  }
}

const handleSurfaceInit: GlobalIPCHandler = async (params, ctx) => {
  const p = assertObj(params, "surface.init params");
  const src = assertStr(p.src, "src");
  const x = assertNum(p.x, "x");
  const y = assertNum(p.y, "y");
  const width = assertNum(p.width, "width");
  const height = assertNum(p.height, "height");

  const hostView = BrowserView.getById(ctx.viewId);
  if (!hostView) throw new Error(`Host view not found: ${ctx.viewId}`);
  if (!hostView.windowId) throw new Error(`Host window not found for view: ${ctx.viewId}`);

  const hostIds = hostSurfaceIds.get(ctx.viewId);
  if (hostIds && hostIds.size >= MAX_SURFACES_PER_HOST) {
    throw new Error(`Surface limit reached (${MAX_SURFACES_PER_HOST}) for host view ${ctx.viewId}`);
  }

  const offset = applyHostOffset(hostView, x, y);
  const view = new BrowserView({
    url: src,
    windowId: hostView.windowId,
    appresRoot: hostView.appresRoot,
    frame: { x: offset.x, y: offset.y, width, height },
    autoResize: false
  });
  view.bringToFront();
  trackSurface(view.id, { view, hostViewId: ctx.viewId });
  return { surfaceId: view.id };
};

const handleSurfaceResize: GlobalIPCHandler = async (params, ctx) => {
  const p = assertObj(params, "surface.resize params");
  const surfaceId = assertNum(p.surfaceId, "surfaceId");
  const x = assertNum(p.x, "x");
  const y = assertNum(p.y, "y");
  const w = assertNum(p.w, "w");
  const h = assertNum(p.h, "h");

  const record = getOwnedSurface(surfaceId, ctx);
  if (!record) return {};

  const hostView = BrowserView.getById(ctx.viewId);
  if (hostView) {
    const offset = applyHostOffset(hostView, x, y);
    record.view.setBounds(offset.x, offset.y, w, h);
  }
  return {};
};

const handleSurfaceRemove: GlobalIPCHandler = async (params, ctx) => {
  const p = assertObj(params, "surface.remove params");
  const surfaceId = assertNum(p.surfaceId, "surfaceId");

  const record = getOwnedSurface(surfaceId, ctx);
  if (!record) return {};

  untrackSurface(surfaceId);
  record.view.remove();
  return {};
};

const handleSurfaceSetHidden: GlobalIPCHandler = async (params, ctx) => {
  const p = assertObj(params, "surface.setHidden params");
  const surfaceId = assertNum(p.surfaceId, "surfaceId");
  const hidden = assertBool(p.hidden, "hidden");

  const record = getOwnedSurface(surfaceId, ctx);
  if (!record) return {};

  record.view.setVisible(!hidden);
  return {};
};

const handleSurfaceUpdateSrc: GlobalIPCHandler = async (params, ctx) => {
  const p = assertObj(params, "surface.updateSrc params");
  const surfaceId = assertNum(p.surfaceId, "surfaceId");
  const src = assertStr(p.src, "src");

  const record = getOwnedSurface(surfaceId, ctx);
  if (!record) return {};

  record.view.loadURL(src);
  return {};
};

const handleSurfaceBringAllToFront: GlobalIPCHandler = async (_params, ctx) => {
  const ids = hostSurfaceIds.get(ctx.viewId);
  if (!ids) return {};

  for (const surfaceId of ids) {
    const record = surfaces.get(surfaceId);
    if (record) {
      record.view.bringToFront();
    }
  }
  return {};
};

export function getSurfaceIPCHandlers(): Map<string, GlobalIPCHandler> {
  return new Map([
    ["__bunite:surface.init", handleSurfaceInit],
    ["__bunite:surface.resize", handleSurfaceResize],
    ["__bunite:surface.remove", handleSurfaceRemove],
    ["__bunite:surface.setHidden", handleSurfaceSetHidden],
    ["__bunite:surface.updateSrc", handleSurfaceUpdateSrc],
    ["__bunite:surface.bringAllToFront", handleSurfaceBringAllToFront]
  ]);
}
