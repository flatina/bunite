import { getOwnedSurface } from "./SurfaceRegistry";
import { sendMessageToView } from "./Socket";
import { onSurfaceInit } from "./SurfaceManager";

import type { GlobalIPCHandler } from "./App";

// --- did-navigate forwarding ---

onSurfaceInit((surfaceId, hostViewId, view) => {
  view.on("did-navigate", (event: any) => {
    sendMessageToView(hostViewId, {
      type: "event",
      channel: "__bunite:webview.didNavigate",
      data: { surfaceId, url: event.data.detail }
    });
  });
});

// --- Helpers ---

function assertNum(v: unknown, label: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`Invalid ${label}`);
  return v;
}

function assertStr(v: unknown, label: string): string {
  if (typeof v !== "string") throw new Error(`Invalid ${label}`);
  return v;
}

function assertObj(v: unknown, label: string): Record<string, unknown> {
  if (!v || typeof v !== "object") throw new Error(`Invalid ${label}`);
  return v as Record<string, unknown>;
}

// --- Handlers ---

const handleGoBack: GlobalIPCHandler = async (params, ctx) => {
  const record = getOwnedSurface(assertNum(assertObj(params, "p").surfaceId, "surfaceId"), ctx);
  if (record) record.view.goBack();
  return {};
};

const handleReload: GlobalIPCHandler = async (params, ctx) => {
  const record = getOwnedSurface(assertNum(assertObj(params, "p").surfaceId, "surfaceId"), ctx);
  if (record) record.view.reload();
  return {};
};

const handleNavigate: GlobalIPCHandler = async (params, ctx) => {
  const p = assertObj(params, "webview.navigate params");
  const surfaceId = assertNum(p.surfaceId, "surfaceId");
  const url = assertStr(p.url, "url");
  const record = getOwnedSurface(surfaceId, ctx);
  if (record) record.view.loadURL(url);
  return {};
};

export function getWebviewIPCHandlers(): Map<string, GlobalIPCHandler> {
  return new Map([
    ["__bunite:webview.goBack", handleGoBack],
    ["__bunite:webview.reload", handleReload],
    ["__bunite:webview.navigate", handleNavigate]
  ]);
}
