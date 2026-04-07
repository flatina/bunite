import { BuniteEvent } from "./event";

export default {
  close: (data: { id: number }) => new BuniteEvent("close", data),
  focus: (data: { id: number }) => new BuniteEvent("focus", data),
  blur: (data: { id: number }) => new BuniteEvent("blur", data),
  move: (data: { id: number; x: number; y: number; maximized: boolean; minimized: boolean }) =>
    new BuniteEvent("move", data),
  resize: (data: {
    id: number;
    x: number;
    y: number;
    width: number;
    height: number;
    maximized: boolean;
    minimized: boolean;
  }) =>
    new BuniteEvent("resize", data)
};
