import type { BrowserView } from "./BrowserView";

export type SurfaceRecord = {
  view: BrowserView;
  hostViewId: number;
  hidden: boolean;
};

export const MAX_SURFACES_PER_HOST = 32;

const surfaces = new Map<number, SurfaceRecord>();
const hostSurfaceIds = new Map<number, Set<number>>();

export function trackSurface(surfaceId: number, record: SurfaceRecord) {
  surfaces.set(surfaceId, record);
  let ids = hostSurfaceIds.get(record.hostViewId);
  if (!ids) {
    ids = new Set();
    hostSurfaceIds.set(record.hostViewId, ids);
  }
  ids.add(surfaceId);
}

export function untrackSurface(surfaceId: number) {
  const record = surfaces.get(surfaceId);
  if (!record) return;
  surfaces.delete(surfaceId);
  const ids = hostSurfaceIds.get(record.hostViewId);
  if (ids) {
    ids.delete(surfaceId);
    if (ids.size === 0) hostSurfaceIds.delete(record.hostViewId);
  }
}

export function getOwnedSurface(surfaceId: number, ctx: { viewId: number }): SurfaceRecord | null {
  const record = surfaces.get(surfaceId);
  if (!record) return null;
  if (record.hostViewId !== ctx.viewId) throw new Error("Surface access denied.");
  return record;
}

export function getHostSurfaceIds(hostViewId: number): Set<number> | undefined {
  return hostSurfaceIds.get(hostViewId);
}

export function getSurfaceRecord(surfaceId: number): SurfaceRecord | undefined {
  return surfaces.get(surfaceId);
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
