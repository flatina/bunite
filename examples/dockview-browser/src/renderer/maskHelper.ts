/**
 * Punch holes in native surfaces where dockview drop indicators overlap,
 * so the DOM-rendered indicators remain visible during tab drag.
 */

import { type ClientOf, RuntimeCap, SurfaceCap } from "bunite-core/view";

type RuntimeClient = ClientOf<typeof RuntimeCap>;
type SurfaceClient = ClientOf<typeof SurfaceCap>;

declare global {
  interface Window {
    bunite?: { runtime(): Promise<RuntimeClient> };
  }
}

type WebviewElement = HTMLElement & { _surfaceId?: number | null };

let _surfaceCap: Promise<SurfaceClient> | null = null;
function getSurfaceCap(): Promise<SurfaceClient> {
  if (_surfaceCap) return _surfaceCap;
  if (!window.bunite?.runtime) return Promise.reject(new Error("bunite preload not ready"));
  const attempt = window.bunite.runtime().then((r) => r.surface());
  _surfaceCap = attempt;
  attempt.catch(() => { if (_surfaceCap === attempt) _surfaceCap = null; });
  return attempt;
}

export function setupDropIndicatorMasks() {
  if (!window.bunite?.runtime) return;

  let scheduled = false;
  let dragging = false;

  function syncMasks() {
    const dpr = devicePixelRatio || 1;
    const indicators = document.querySelectorAll<HTMLElement>(
      ".dv-drop-target-anchor, .dv-drop-target-selection"
    );
    for (const wv of document.querySelectorAll<HTMLElement>("bunite-webview")) {
      const wr = wv.getBoundingClientRect();
      if (wr.width === 0 || wr.height === 0) continue;
      const sid = (wv as WebviewElement)._surfaceId;
      if (sid == null) continue;

      const masks: Array<{ x: number; y: number; w: number; h: number }> = [];
      for (const el of indicators) {
        const ir = el.getBoundingClientRect();
        if (ir.width === 0 || ir.height === 0) continue;
        const ox = Math.max(wr.left, ir.left);
        const oy = Math.max(wr.top, ir.top);
        const ox2 = Math.min(wr.right, ir.right);
        const oy2 = Math.min(wr.bottom, ir.bottom);
        if (ox < ox2 && oy < oy2) {
          masks.push({
            x: Math.round(ox * dpr), y: Math.round(oy * dpr),
            w: Math.round((ox2 - ox) * dpr), h: Math.round((oy2 - oy) * dpr)
          });
        }
      }
      void getSurfaceCap().then((s) => s.setMasks({ surfaceId: sid, masks })).catch(() => {});
    }
  }

  function clearAll() {
    for (const wv of document.querySelectorAll<HTMLElement>("bunite-webview")) {
      const sid = (wv as WebviewElement)._surfaceId;
      if (sid == null) continue;
      void getSurfaceCap().then((s) => s.setMasks({ surfaceId: sid, masks: [] })).catch(() => {});
    }
  }

  function endDrag() { dragging = false; clearAll(); }

  document.addEventListener("dragstart", () => { dragging = true; syncMasks(); }, true);
  document.addEventListener("dragover", () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; if (dragging) syncMasks(); });
  }, true);
  document.addEventListener("dragend", endDrag, true);
  document.addEventListener("drop", endDrag, true);
}
