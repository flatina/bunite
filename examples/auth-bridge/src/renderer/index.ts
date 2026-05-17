import { bootstrap, getConnection } from "bunite-core/rpc/renderer";
import { IpcError, type ClientOf } from "bunite-core/rpc";
import { BridgeCap, type SessionCap } from "../schema";

const $ = <T extends Element = HTMLElement>(s: string): T => document.querySelector<T>(s)!;
const webForm = $<HTMLFormElement>("#web-form");
const webToken = $<HTMLInputElement>("#web-token");
const nativeBtn = $<HTMLButtonElement>("#native-btn");
const resumeBtn = $<HTMLButtonElement>("#resume-btn");
const signoutBtn = $<HTMLButtonElement>("#signout");
const bumpBtn = $<HTMLButtonElement>("#bump");
const panel = $("#panel");
const whoami = $<HTMLElement>("#whoami");
const source = $<HTMLElement>("#source");
const countEl = $<HTMLElement>("#count");
const errEl = $<HTMLElement>("#err");

const RESUME_KEY = "auth-bridge.resumeToken";

let session: ClientOf<typeof SessionCap> | null = null;
let bridge: ClientOf<typeof BridgeCap>;

try {
  bridge = await bootstrap(BridgeCap);
} catch (e) {
  showErr(`bootstrap failed: ${formatError(e)}`);
  throw e;
}

// Auto-resume if we have a stored token.
const stored = localStorage.getItem(RESUME_KEY);
if (stored) {
  await tryMint(() => bridge.resumeSession({ resumeToken: stored }))
    .catch(() => { localStorage.removeItem(RESUME_KEY); });
}

webForm.addEventListener("submit", (e) => {
  e.preventDefault();
  void tryMint(() => bridge.createWebSession({ token: webToken.value.trim() }));
});
nativeBtn.addEventListener("click", () => { void tryMint(() => bridge.createDesktopSession()); });
resumeBtn.addEventListener("click", () => {
  const t = localStorage.getItem(RESUME_KEY);
  if (!t) { showErr("no stored resume token — sign in once first"); return; }
  void tryMint(() => bridge.resumeSession({ resumeToken: t }));
});
signoutBtn.addEventListener("click", async () => {
  if (session) (await getConnection()).releaseRef(session);
  session = null;
  localStorage.removeItem(RESUME_KEY);
  panel.hidden = true;
});
bumpBtn.addEventListener("click", async () => {
  if (!session) return;
  try { countEl.textContent = String(await session.bump()); }
  catch (e) { showErr(formatError(e)); }
});

async function tryMint(create: () => Promise<ClientOf<typeof SessionCap>>): Promise<void> {
  showErr("");
  try {
    const fresh = await create();
    const [me, count, resumeToken] = await Promise.all([
      fresh.whoami(),
      fresh.count(),
      fresh.getResumeToken(),
    ]);
    if (session) (await getConnection()).releaseRef(session);
    session = fresh;
    localStorage.setItem(RESUME_KEY, resumeToken);
    whoami.textContent = me.userId;
    source.textContent = me.source;
    countEl.textContent = String(count);
    panel.hidden = false;
  } catch (e) {
    panel.hidden = true;
    showErr(formatError(e));
    throw e;
  }
}

function formatError(e: unknown): string {
  if (e instanceof IpcError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

function showErr(msg: string): void {
  errEl.textContent = msg;
}
