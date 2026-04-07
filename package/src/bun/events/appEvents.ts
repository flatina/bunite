import { BuniteEvent } from "./event";

export default {
  ready: (data: Record<string, unknown>) => new BuniteEvent("ready", data),
  beforeQuit: (data: Record<string, unknown>) =>
    new BuniteEvent<Record<string, unknown>, { allow?: boolean }>("before-quit", data)
};
