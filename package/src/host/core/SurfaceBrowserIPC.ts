import {
  onSurfaceInit, emitSurfaceEvent, emitConsole, emitDownload,
  registerDialogRequest, disposeSurfaceState, clearConsoleBuffer,
} from "./SurfaceManager";

onSurfaceInit((surfaceId, hostViewId, view) => {
  view.on("did-navigate", (event: any) => {
    emitSurfaceEvent(hostViewId, surfaceId, { type: "navigate", url: event.data.detail });
  });
  view.on("title-changed", (event: any) => {
    emitSurfaceEvent(hostViewId, surfaceId, { type: "title-change", title: event.data.detail });
  });
  view.on("load-start", (event: any) => {
    // Reload / fresh nav — clear retained host buffer so consumers don't see
    // stale entries from the prior document.
    clearConsoleBuffer(surfaceId);
    emitSurfaceEvent(hostViewId, surfaceId, { type: "load-start", url: event.data.detail });
  });
  view.on("load-finish", (event: any) => {
    emitSurfaceEvent(hostViewId, surfaceId, { type: "load-finish", url: event.data.detail });
  });
  view.on("load-fail", (event: any) => {
    const d = event.data;
    emitSurfaceEvent(hostViewId, surfaceId, {
      type: "load-fail", url: d.url ?? "", reason: d.reason,
    });
  });
  view.on("dialog", (event: any) => {
    const d = event.data as {
      requestId: number;
      kind: "alert" | "confirm" | "prompt" | "beforeunload";
      message: string;
      defaultPrompt?: string;
    };
    registerDialogRequest(hostViewId, surfaceId, d);
  });
  view.on("console-message", (event: any) => {
    // PageReportingCap impl already wraps the whole batch in a single
    // microtask — no extra deferral needed at the listener level.
    emitConsole(hostViewId, surfaceId, event.data);
  });
  view.on("download-event", (event: any) => {
    emitDownload(hostViewId, surfaceId, event.data);
  });
});

// Surface registry's untrackSurface doesn't fire a teardown event — wire it
// at the call site if needed. For now state TTL aligns with the view lifetime
// since surfaceId is reused only after view destruction; the buffer is GC'd
// once the surface is removed via `remove()` which eventually triggers
// `disposeSurfaceState` here.
export function disposeSurface(surfaceId: number) {
  disposeSurfaceState(surfaceId);
}
