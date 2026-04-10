/**
 * Punch holes in native surfaces where dockview drop indicators overlap,
 * so the DOM-rendered indicators remain visible during tab drag.
 */

type WebviewElement = HTMLElement & { _surfaceId?: number | null };

export function setupDropIndicatorMasks() {
  if (!window.bunite?.invoke) return;
  const invoke = window.bunite.invoke;

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
      invoke("__bunite:surface.setMasks", { surfaceId: sid, masks }).catch(() => {});
    }
  }

  function clearAll() {
    for (const wv of document.querySelectorAll<HTMLElement>("bunite-webview")) {
      const sid = (wv as WebviewElement)._surfaceId;
      if (sid == null) continue;
      invoke("__bunite:surface.setMasks", { surfaceId: sid, masks: [] }).catch(() => {});
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
