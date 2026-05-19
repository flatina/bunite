import { onSurfaceInit, emitDidNavigate, emitTitleChanged } from "./SurfaceManager";

onSurfaceInit((surfaceId, hostViewId, view) => {
  view.on("did-navigate", (event: any) => {
    emitDidNavigate(hostViewId, surfaceId, event.data.detail);
  });
  view.on("title-changed", (event: any) => {
    emitTitleChanged(hostViewId, surfaceId, event.data.detail);
  });
});
