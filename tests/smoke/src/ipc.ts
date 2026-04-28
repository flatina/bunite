import { BrowserView, defineBunRpc } from "bunite-core";

type SmokeSchema = {
  bun: {
    requests: {
      ping: { params: { value: string }; response: { pong: string } };
    };
    messages: {};
  };
  webview: { requests: {}; messages: {} };
};

export const ipcState = {
  rpcPingOk: false,
  navAllowOk: false,
  navBlockAttempted: false,
  navBlockLeaked: false,
};

export const rpcDefinition = defineBunRpc<SmokeSchema>({
  handlers: {
    requests: {
      ping({ value }) {
        ipcState.rpcPingOk = value === "smoke";
        return { pong: `pong:${value}` };
      }
    }
  }
});

export function attachNavigationChecks(view: BrowserView) {
  view.on("will-navigate", (event: unknown) => {
    const detail = String((event as { data?: { detail?: string } }).data?.detail ?? "");
    if (detail.includes("nav-blocked.html")) {
      ipcState.navBlockAttempted = true;
    }
  });

  view.on("did-navigate", (event: unknown) => {
    const detail = String((event as { data?: { detail?: string } }).data?.detail ?? "");
    if (detail.includes("nav-blocked.html")) {
      ipcState.navBlockLeaked = true;
    }
    if (detail.includes("nav-ok.html")) {
      ipcState.navAllowOk = true;
    }
  });
}

export function checkIPC() {
  return {
    rpcPingOk: ipcState.rpcPingOk,
    navAllowOk: ipcState.navAllowOk,
    navBlockOk: ipcState.navBlockAttempted && !ipcState.navBlockLeaked,
  };
}
