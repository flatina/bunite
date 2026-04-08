import type { BrowserWindow } from "bunite-core";

export const windowState = {
  maximizeOk: false,
  unmaximizeOk: false,
  minimizeOk: false,
  unminimizeOk: false,
};

function wait(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

async function waitFor(label: string, check: () => boolean, timeoutMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return true;
    await wait(25);
  }
  if (!check()) console.warn(`[smoke] waitFor timed out: ${label}`);
  return check();
}

export async function runWindowTests(win: BrowserWindow) {
  await wait(200);

  win.maximize();
  windowState.maximizeOk = await waitFor("maximize", () => win.isMaximized());

  win.unmaximize();
  windowState.unmaximizeOk = await waitFor("unmaximize", () => !win.isMaximized());

  win.minimize();
  windowState.minimizeOk = await waitFor("minimize", () => win.isMinimized());

  win.unminimize();
  windowState.unminimizeOk = await waitFor("unminimize", () => !win.isMinimized());
}

export function checkWindow() {
  return { ...windowState };
}
