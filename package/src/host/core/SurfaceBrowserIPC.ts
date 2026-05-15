import { onSurfaceInit, emitDidNavigate } from "./SurfaceManager";

onSurfaceInit((surfaceId, hostViewId, view) => {
  view.on("did-navigate", (event: any) => {
    emitDidNavigate(hostViewId, surfaceId, event.data.detail);
  });
});
