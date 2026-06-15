import { BuniteEvent } from "./event";

export default {
  beforeQuit: (data: Record<string, unknown>) =>
    new BuniteEvent<Record<string, unknown>, { allow?: boolean }>("before-quit", data),
  allWindowsClosed: () => new BuniteEvent("all-windows-closed", {}),
};
