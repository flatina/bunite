import { BuniteEvent } from "./event";

export default {
  willNavigate: (data: { detail: string }) => new BuniteEvent("will-navigate", data),
  didNavigate: (data: { detail: string }) => new BuniteEvent("did-navigate", data),
  domReady: (data: { detail: string }) => new BuniteEvent("dom-ready", data),
  newWindowOpen: (data: { detail: string | { url: string } }) =>
    new BuniteEvent("new-window-open", data),
  permissionRequested: (data: { requestId: number; kind: number; url?: string }) =>
    new BuniteEvent("permission-requested", data),
  messageBoxResponse: (data: { requestId: number; response: number }) =>
    new BuniteEvent("message-box-response", data)
};
