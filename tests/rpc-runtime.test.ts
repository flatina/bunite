import { describe, expect, test } from "bun:test";
import {
  BrowserWindowCap,
  ClipboardCap,
  createConnection,
  DialogsCap,
  type Frame,
  type RuntimeCap,
  ShellCap,
  type Transport,
  WindowCap,
} from "../package/src/rpc/index";
import type { ImplOf } from "../package/src/rpc/schema";

function loopback(): [Transport, Transport] {
  let a: ((f: Frame) => void) | undefined;
  let b: ((f: Frame) => void) | undefined;
  const enqueue = (getH: () => ((f: Frame) => void) | undefined, f: Frame) => {
    queueMicrotask(() => {
      const h = getH();
      if (h) h(f);
    });
  };
  return [
    {
      send: (f) => enqueue(() => b, f),
      setReceive: (h) => {
        a = h;
      },
      close: () => {},
    },
    {
      send: (f) => enqueue(() => a, f),
      setReceive: (h) => {
        b = h;
      },
      close: () => {},
    },
  ];
}

function makeRuntimeImpl(): ImplOf<typeof RuntimeCap> {
  let bwIdCounter = 0;
  const windows = new Map<
    number,
    { label: string; bounds: { x: number; y: number; w: number; h: number }; title: string }
  >();
  const makeBw = (bwId: number, ctx: any) =>
    ctx.exportCap(BrowserWindowCap, {
      focus: () => {},
      close: () => {
        windows.delete(bwId);
      },
      setBounds: (b: { x: number; y: number; w: number; h: number }) => {
        const w = windows.get(bwId);
        if (w) w.bounds = b;
      },
      setTitle: ({ title }: { title: string }) => {
        const w = windows.get(bwId);
        if (w) w.title = title;
      },
      id: () => bwId,
      label: () => windows.get(bwId)?.label ?? "",
    });
  return {
    window: (_, ctx) =>
      ctx.exportCap(WindowCap, {
        create: (opts, c2) => {
          const bwId = ++bwIdCounter;
          windows.set(bwId, {
            label: opts.label ?? `win${bwId}`,
            bounds: { x: 0, y: 0, w: 800, h: 600, ...opts.bounds },
            title: opts.title ?? "",
          });
          return makeBw(bwId, c2);
        },
        list: (_, c2) => Array.from(windows.keys()).map((bwId) => makeBw(bwId, c2)),
        focus: () => {},
        close: ({ id }) => {
          if (id != null) windows.delete(id);
        },
      }),
    dialogs: (_, ctx) =>
      ctx.exportCap(DialogsCap, {
        openFile: () => [],
        saveFile: (_, c2) => c2.exportCap({} as never, {} as never),
        showMessage: () => "primary",
      }),
    clipboard: (_, ctx) =>
      ctx.exportCap(ClipboardCap, {
        readText: () => "clip",
        writeText: () => {},
        readBytes: () => new Uint8Array(),
        writeBytes: () => {},
      }),
    shell: (_, ctx) =>
      ctx.exportCap(ShellCap, {
        openExternal: () => true,
        showItemInFolder: () => {},
      }),
    appName: () => "test-app",
    appVersion: () => "1.2.3",
    theme: () => "dark",
    themeWatch: () => {
      throw new Error("not used here");
    },
    surface: () => {
      throw new Error("not used here");
    },
  };
}

describe("runtime cap dispatch", () => {
  test("appName / appVersion / theme via runtime()", async () => {
    const [t1, t2] = loopback();
    createConnection({
      transport: t2,
      mode: "native",
      origin: "test://server",
      runtime: makeRuntimeImpl(),
    });
    const runtime = createConnection({
      transport: t1,
      mode: "native",
      origin: "test://client",
    }).runtime();
    expect(await runtime.appName()).toBe("test-app");
    expect(await runtime.appVersion()).toBe("1.2.3");
    expect(await runtime.theme()).toBe("dark");
  });

  test("window.create chains to BrowserWindow methods", async () => {
    const [t1, t2] = loopback();
    createConnection({
      transport: t2,
      mode: "native",
      origin: "test://server",
      runtime: makeRuntimeImpl(),
    });
    const runtime = createConnection({
      transport: t1,
      mode: "native",
      origin: "test://client",
    }).runtime();
    const win = await runtime.window();
    const bw = await win.create({ url: "appres://app.internal/", label: "main" });
    expect(await bw.id()).toBe(1);
    expect(await bw.label()).toBe("main");
    await bw.setTitle({ title: "Hello" });
    await bw.close();
  });

  test("clipboard sub-cap", async () => {
    const [t1, t2] = loopback();
    createConnection({
      transport: t2,
      mode: "native",
      origin: "test://server",
      runtime: makeRuntimeImpl(),
    });
    const runtime = createConnection({
      transport: t1,
      mode: "native",
      origin: "test://client",
    }).runtime();
    const clip = await runtime.clipboard();
    expect(await clip.readText()).toBe("clip");
  });

  test("missing runtime impl yields not_found", async () => {
    const [t1, t2] = loopback();
    createConnection({ transport: t2, mode: "native", origin: "test://server" });
    const runtime = createConnection({
      transport: t1,
      mode: "native",
      origin: "test://client",
    }).runtime();
    await expect(runtime.appName()).rejects.toMatchObject({ code: "not_found" });
  });
});
