import type { BrowserView } from "bunite-core";
import type { ImplOf } from "bunite-core/rpc";
import { apiCap, schema } from "./schema";

const ipcState = {
  rpcPingOk: false,
  navAllowOk: false,
  navBlockAttempted: false,
  navBlockLeaked: false,
};

const apiImpl = {
  ping: ({ value }) => {
    ipcState.rpcPingOk = value === "smoke";
    return { pong: `pong:${value}` };
  },
} satisfies ImplOf<typeof apiCap>;

export const descriptor = schema.serve({ api: apiImpl });

export function attachNavigationChecks(view: BrowserView) {
  view.on("will-navigate", (event: unknown) => {
    const detail = String((event as { data?: { detail?: string } }).data?.detail ?? "");
    if (detail.includes("nav-blocked.html")) ipcState.navBlockAttempted = true;
  });
  view.on("did-navigate", (event: unknown) => {
    const detail = String((event as { data?: { detail?: string } }).data?.detail ?? "");
    if (detail.includes("nav-blocked.html")) ipcState.navBlockLeaked = true;
    if (detail.includes("nav-ok.html")) ipcState.navAllowOk = true;
  });
}

export function checkIPC() {
  return {
    rpcPingOk: ipcState.rpcPingOk,
    navAllowOk: ipcState.navAllowOk,
    navBlockOk: ipcState.navBlockAttempted && !ipcState.navBlockLeaked,
  };
}
