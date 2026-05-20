import { BuniteEvent } from "./event";

export default {
  willNavigate: (data: { detail: string }) => new BuniteEvent("will-navigate", data),
  didNavigate: (data: { detail: string }) => new BuniteEvent("did-navigate", data),
  domReady: (data: { detail: string }) => new BuniteEvent("dom-ready", data),
  newWindowOpen: (data: { detail: string | { url: string } }) =>
    new BuniteEvent("new-window-open", data),
  permissionRequested: (data: { requestId: number; kind: number; url?: string }) =>
    new BuniteEvent("permission-requested", data),
  titleChanged: (data: { detail: string }) => new BuniteEvent("title-changed", data),
  loadStart: (data: { detail: string }) => new BuniteEvent("load-start", data),
  loadFinish: (data: { detail: string }) => new BuniteEvent("load-finish", data),
  loadFail: (data: { url: string; reason?: string }) => new BuniteEvent("load-fail", data)
};
