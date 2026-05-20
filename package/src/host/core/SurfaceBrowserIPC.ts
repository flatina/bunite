import { onSurfaceInit, emitSurfaceEvent } from "./SurfaceManager";

onSurfaceInit((surfaceId, hostViewId, view) => {
  view.on("did-navigate", (event: any) => {
    emitSurfaceEvent(hostViewId, surfaceId, { type: "navigate", url: event.data.detail });
  });
  view.on("title-changed", (event: any) => {
    emitSurfaceEvent(hostViewId, surfaceId, { type: "title-change", title: event.data.detail });
  });
  view.on("load-start", (event: any) => {
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
});
