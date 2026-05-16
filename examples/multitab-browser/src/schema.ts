import { call, defineCap } from "bunite-core/rpc";

export type QuickLink = { url: string; label: string };
export type TabInfo = { id: string; url: string; title: string };

export const apiCap = defineCap("multitab.api", {
  getQuickLinks: call<void, QuickLink[]>({ idempotent: true }),
  createTab: call<{ url?: string }, TabInfo>(),
  closeTab: call<{ id: string }, void>(),
  navigateTo: call<{ id: string; url: string }, void>(),
});
