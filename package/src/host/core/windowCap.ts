import {
  BrowserWindowCap,
  type ImplOf,
  IpcError,
  type WindowCap,
  type WindowState,
} from "../../rpc/index";
import { Stream } from "../../rpc/stream";
import { BrowserWindow } from "./BrowserWindow";

function browserWindowImpl(win: BrowserWindow): ImplOf<typeof BrowserWindowCap> {
  return {
    focus: () => win.focus(),
    close: () => win.close(),
    setBounds: ({ x, y, w, h }) => win.setFrame(x, y, w, h),
    setTitle: ({ title }) => win.setTitle(title),
    id: () => win.id,
    label: () => win.label,
    minimize: () => win.minimize(),
    unminimize: () => win.unminimize(),
    maximize: () => win.maximize(),
    unmaximize: () => win.unmaximize(),
    toggleMaximize: () => win.toggleMaximize(),
    beginMoveDrag: () => win.beginMoveDrag(),
    getState: () => win.getState(),
    stateWatch: () =>
      Stream.from<WindowState>((emit, signal) => {
        let last = "";
        const push = () => {
          const s = win.getState();
          const key = `${s.maximized}|${s.minimized}|${s.focused}`;
          if (key === last) return;
          last = key;
          emit(s);
        };
        push(); // initial snapshot
        const offs = [
          win.on("focus", push),
          win.on("blur", push),
          win.on("move", push),
          win.on("resize", push),
        ];
        signal.addEventListener("abort", () => {
          for (const off of offs) off();
        });
      }),
  };
}

function resolve(args: { id?: number; label?: string }): BrowserWindow | undefined {
  if (args.id != null) return BrowserWindow.getById(args.id);
  if (args.label) return BrowserWindow.getAll().find((w) => w.label === args.label);
  return undefined;
}

/** WindowCap impl for the renderer of `viewId`. `current()` resolves the owning
 *  window host-side from the session's viewId — never from a page-supplied id. */
export function createWindowCapImpl(viewId: number): ImplOf<typeof WindowCap> {
  return {
    create: ({ url, title, bounds, label }, ctx) => {
      const win = new BrowserWindow({
        url,
        title,
        label,
        frame: {
          x: bounds?.x ?? 80,
          y: bounds?.y ?? 80,
          width: bounds?.w ?? 1280,
          height: bounds?.h ?? 900,
        },
      });
      return ctx.exportCap(BrowserWindowCap, browserWindowImpl(win));
    },
    list: (_void, ctx) =>
      BrowserWindow.getAll().map((w) => ctx.exportCap(BrowserWindowCap, browserWindowImpl(w))),
    current: (_void, ctx) => {
      const win = BrowserWindow.getByWebviewId(viewId);
      if (!win) throw new IpcError({ code: "not_found", message: "no window for this view" });
      return ctx.exportCap(BrowserWindowCap, browserWindowImpl(win));
    },
    focus: (args) => {
      resolve(args)?.focus();
    },
    close: (args) => {
      resolve(args)?.close();
    },
  };
}
