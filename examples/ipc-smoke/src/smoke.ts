import { app } from "bunite";
import { smokeState } from "./main";

setTimeout(() => {
  const ok =
    smokeState.pingCount > 0 &&
    smokeState.lastPing === "ipc-smoke" &&
    smokeState.okNavigationSeen &&
    smokeState.popupSeen;

  if (!ok) {
    console.error("[ipc-smoke] failed", smokeState);
  }

  app.quit(ok ? 0 : 1);
}, 5_000);
