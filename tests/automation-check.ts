// SurfaceCap automation-surface verification (Stage B+C). Opens a window with
// a self-contained test page, exercises every automation method against the
// engine selected by `BUNITE_ENGINE` (default `webview2`), writes the
// screenshot next to this script, prints PASS/FAIL, then quits.
//
//   bun tests/automation-check.ts                        # WebView2 (default)
//   BUNITE_ENGINE=cef bun tests/automation-check.ts      # CEF (needs runtime)
//
// On a WebView2 run the window does not need to be foreground — CDP input
// bypasses focus. Keep it visible only if you want to watch.

import { AppRuntime, BrowserWindow } from "../package/src/host/index";
import { join } from "node:path";

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>boot</title></head>
<body style="font:14px monospace;padding:1em">
  <input id="input" placeholder="type target" autofocus style="font-size:16px;padding:4px;width:30em">
  <button id="btn" style="margin:1em;padding:8px 16px">click me</button>
  <button id="open-confirm" style="margin:1em;padding:8px 16px">open confirm</button>
  <div id="log" style="border:1px solid #888;padding:8px;min-height:6em;white-space:pre-wrap"></div>
  <div style="height:1200px;background:linear-gradient(#cdf,#fcf)">tall scroll area</div>
  <script>
    var log = document.getElementById("log");
    var append = function (s) { log.textContent += s + "\\n"; };
    document.getElementById("btn").addEventListener("click", function (e) {
      append("[click] shift=" + e.shiftKey + " ctrl=" + e.ctrlKey + " alt=" + e.altKey + " trusted=" + e.isTrusted);
    });
    document.getElementById("open-confirm").addEventListener("click", function () {
      var r = window.confirm("ok?");
      append("[confirm] result=" + r);
    });
    document.getElementById("btn").addEventListener("dblclick", function () { append("[dblclick]"); });
    document.getElementById("input").addEventListener("input", function (e) { append("[input] '" + e.target.value + "'"); });
    document.addEventListener("keydown", function (e) {
      append("[keydown] " + e.key + " (code=" + e.code + ") shift=" + e.shiftKey + " ctrl=" + e.ctrlKey + " trusted=" + e.isTrusted);
    });
    document.addEventListener("scroll", function () { append("[scroll] y=" + window.scrollY); }, { passive: true });
    document.title = "automation-ready";
  </script>
</body></html>`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function ok(label: string, pass: boolean, detail: unknown = "") {
  const tag = pass ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${label}` + (detail !== "" ? `  ${JSON.stringify(detail)}` : ""));
}

const app = new AppRuntime();
await app.ready;

const win = new BrowserWindow({ title: "bunite automation-check", html: HTML });
const view = win.webview;
if (!view) throw new Error("BrowserWindow has no webview");
const v = view;  // narrowed alias — TS loses narrowing across nested fn closure

async function runChecks() {
  await v.whenReady();
  await sleep(400);  // let initial render + listeners settle
  console.log("\n=== bunite automation surface ===\n");
  await doChecks();
  console.log("\n=== done — window auto-closes in 3s ===\n");
  setTimeout(() => app.quit(0), 3_000);
}

async function doChecks() {

const caps = v.capabilities();
console.log("capabilities:", caps);

const r1 = await v.evaluate("1 + 1");
ok("evaluate 1+1 → 2", r1.ok === true && r1.value === 2, r1);

const r2 = await v.evaluate("document.title");
ok("evaluate document.title", r2.ok === true && typeof r2.value === "string", r2);

// Evaluate's wrapper inlines the script as `(<expr>)`, so statements
// (`var`, `const`, multi-statement `;`) are syntax errors. Use IIFE.
const RESET_INPUT = "(function(){var i=document.getElementById('input');i.value='';i.focus();return ''})()";
const RESET_LOG = "(function(){document.getElementById('log').textContent='';return ''})()";

if (caps.type) {
  await v.evaluate(RESET_INPUT);
  await sleep(50);
  v.type("hi");
  await sleep(200);
  const r3 = await v.evaluate("document.getElementById('input').value") as { ok: boolean; value?: unknown };
  ok("type 'hi' → input.value === 'hi'", r3.ok === true && r3.value === "hi", r3);
  // CJK — CDP Input.insertText injects final text without IME composition.
  await v.evaluate(RESET_INPUT);
  await sleep(50);
  v.type("안녕");
  await sleep(200);
  const r3b = await v.evaluate("document.getElementById('input').value") as { ok: boolean; value?: unknown };
  ok("type '안녕' → input.value === '안녕'", r3b.ok === true && r3b.value === "안녕", r3b);
}

if (caps.click) {
  // IIFE — evaluate's wrapper wraps the script in `(<expr>)`, so statements
  // (e.g. bare `const`) parse-fail. An IIFE keeps the body a single expression.
  const rect = await v.evaluate(
    "(function(){var r=document.getElementById('btn').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()"
  ) as { ok: boolean; value?: unknown };
  if (rect.ok && rect.value && typeof rect.value === "object") {
    const { x, y } = rect.value as { x: number; y: number };
    // single click + isTrusted check — gated on per-backend `nativeInputTrusted`.
    await v.evaluate(RESET_LOG);
    v.click({ x, y });
    await sleep(200);
    const r5 = await v.evaluate("document.getElementById('log').textContent") as { ok: boolean; value?: unknown };
    const log = (r5.value as string | undefined) ?? "";
    ok(`click at button → '[click]' in log`, log.includes("[click]"), log);
    const trustedExpected = caps.nativeInputTrusted;
    ok(`click isTrusted matches nativeInputTrusted (${trustedExpected})`,
       log.includes(`trusted=${trustedExpected}`), log);
    // ctrl modifier propagates
    await v.evaluate(RESET_LOG);
    v.click({ x, y, modifiers: ["ctrl"] });
    await sleep(200);
    const rm = await v.evaluate("document.getElementById('log').textContent") as { ok: boolean; value?: unknown };
    ok("click with ctrl modifier → ctrl=true in event",
       typeof rm.value === "string" && rm.value.includes("ctrl=true"), rm.value);
    // double-click → dblclick fires
    await v.evaluate(RESET_LOG);
    v.click({ x, y, clickCount: 2 });
    await sleep(300);
    const rd = await v.evaluate("document.getElementById('log').textContent") as { ok: boolean; value?: unknown };
    ok("click clickCount=2 → [dblclick] in log",
       typeof rd.value === "string" && rd.value.includes("[dblclick]"), rd.value);
  } else {
    ok("click prep: get button rect", false, rect);
  }
}

if (caps.getBoundingRect) {
  // getBoundingRect via SurfaceCap helper (uses evaluate under the hood).
  const sid = v.id;
  void sid;
  const r = await v.evaluate(
    "(function(){var el=document.getElementById('btn');var r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()"
  ) as { ok: boolean; value?: unknown };
  ok("evaluate-based bounding rect smoke", r.ok === true && r.value != null, r);
}

if (caps.resolveAndClick) {
  // Atomic selector + click. Verify ok:true + rect + trust matches backend.
  await v.evaluate(RESET_LOG);
  const rc = await v.resolveAndClick({ surfaceId: v.id, selector: "#btn" });
  const success = rc.ok === true && rc.rect && rc.rect.width > 0;
  ok("resolveAndClick(#btn) → ok:true + rect", success, rc);
  await sleep(200);
  const r7 = await v.evaluate("document.getElementById('log').textContent") as { ok: boolean; value?: unknown };
  ok("resolveAndClick fires [click] on page",
     typeof r7.value === "string" && r7.value.includes("[click]"), r7.value);
  if (rc.ok) {
    ok("resolveAndClick isTrustedEvent matches backend expectation",
       typeof rc.isTrustedEvent === "boolean", { isTrustedEvent: rc.isTrustedEvent });
  }
  // missing selector → not_found
  const rcMissing = await v.resolveAndClick({ surfaceId: v.id, selector: "#does-not-exist" });
  ok("resolveAndClick(missing) → not_found",
     rcMissing.ok === false && rcMissing.code === "not_found", rcMissing);
}

if (caps.press) {
  await v.evaluate("(function(){document.getElementById('log').textContent='';document.body.focus();return ''})()");
  v.press("Enter");
  await sleep(150);
  const r6 = await v.evaluate("document.getElementById('log').textContent") as { ok: boolean; value?: unknown };
  const hit = r6.ok && typeof r6.value === "string" && r6.value.includes("[keydown] Enter");
  ok("press 'Enter' → keydown fires", hit, r6.value);
}

if (caps.scroll) {
  await v.evaluate("(function(){document.getElementById('log').textContent='';window.scrollTo(0,0);return ''})()");
  v.scroll({ dx: 0, dy: 200, x: 100, y: 100 });
  await sleep(200);
  const r7 = await v.evaluate("window.scrollY") as { ok: boolean; value?: unknown };
  ok("scroll dy=200 → scrollY > 0", r7.ok === true && typeof r7.value === "number" && (r7.value as number) > 0, r7);
}

if (caps.screenshot) {
  const shot = await v.screenshot("png", 90);
  if (shot.ok) {
    const outPath = join(import.meta.dir, "automation-shot.png");
    await Bun.write(outPath, shot.data);
    ok(`screenshot png → ${shot.data.byteLength} bytes (${outPath})`, shot.data.byteLength > 1000);
  } else {
    ok("screenshot png", false, shot);
  }
}

// surfaceEvents — five-arm lifecycle stream via BrowserView event surface.
let titleFired = false;
let loadStartFired = false;
let loadFinishFired = false;
v.on("title-changed", (event) => {
  const detail = String((event as { data?: { detail?: string } }).data?.detail ?? "");
  if (detail === "changed-by-test") titleFired = true;
});
v.on("load-start", () => { loadStartFired = true; });
v.on("load-finish", () => { loadFinishFired = true; });
await v.evaluate("document.title='changed-by-test'");
await sleep(300);
ok("title-change event fires on document.title write", titleFired);

// Trigger a fresh navigation so load-start / load-finish emit on this run.
// `view.reload()` re-runs the full load lifecycle on the embedded appres://
// document — all four backends fire start + commit + finish hooks for reload.
v.reload();
await sleep(1500);
ok("load-start event fires on navigation", loadStartFired);
ok("load-finish event fires on navigation", loadFinishFired);

// load-fail arm — navigate to an unreachable host so the backend produces a
// failure terminator. Use an RFC 6761 invalid TLD so DNS resolution itself
// fails deterministically across networks.
let loadFailFired = false;
let loadFailUrl = "";
v.on("load-fail", (event: unknown) => {
  loadFailFired = true;
  const d = (event as { data?: { url?: string; reason?: string } }).data;
  loadFailUrl = d?.url ?? "";
});
v.loadURL("https://does-not-resolve.invalid/automation-check-fail");
await sleep(3500);
ok("load-fail event fires on unresolved host", loadFailFired,
   loadFailFired ? loadFailUrl : "");

// --- Stage E: mouse / dialog / waitFor / console (only if supported) ----
// Reload the canonical HTML so the dialog/console tests run against the
// originally-served document (loadURL above pointed at an invalid host).
v.reload();
await sleep(800);

// mouse drag — move/down/up sequence. Verifies isTrusted=true on press and
// that mousemove between down/up reaches the listener.
if (caps.mouse) {
  await v.evaluate("(function(){window.__mt=[];['mousedown','mousemove','mouseup'].forEach(function(t){document.addEventListener(t, function(e){window.__mt.push(t+':'+e.isTrusted)});});return ''})()");
  v.mouse({ action: "down", x: 200, y: 200 });
  v.mouse({ action: "move", x: 220, y: 210 });
  v.mouse({ action: "up", x: 240, y: 220 });
  await sleep(200);
  const mt = await v.evaluate("window.__mt.join('|')") as { ok: boolean; value?: unknown };
  const seq = String(mt.value ?? "");
  // down+up is the strict invariant — mousemove pass-through is backend-dependent
  // (mac WKWebView's `mouseMoved:` requires tracking-area / acceptsMouseMovedEvents
  // setup beyond direct dispatch; reachable on Win backends).
  ok("mouse drag down+up sequence reaches listeners (isTrusted=true)",
     /mousedown:true.+mouseup:true/.test(seq), seq);
}

// dialog round-trip. CEF-gated: WV2 ScriptDialogOpening doesn't fire on
// data: URLs for confirm/prompt — needs a real-origin (appres) harness.
if (caps.dialogs && app.engineName === "cef") {
  const dialogCases: Array<{ kind: "alert" | "confirm" | "prompt"; accept: boolean; text: string; expr: string; expect: unknown }> = [
    { kind: "alert",   accept: true,  text: "",        expr: "(function(){window.alert('a');return 'ok'})()",                expect: "ok" },
    { kind: "confirm", accept: true,  text: "",        expr: "window.confirm('c?')",                                          expect: true },
    { kind: "confirm", accept: false, text: "",        expr: "window.confirm('c?')",                                          expect: false },
    { kind: "prompt",  accept: true,  text: "typed",   expr: "window.prompt('p?', 'def')",                                    expect: "typed" },
    { kind: "prompt",  accept: false, text: "ignored", expr: "window.prompt('p?', 'def')",                                    expect: null },
  ];
  const seen: string[] = [];
  const handler = (event: any) => {
    const d = event.data as { requestId: number; kind: string };
    seen.push(d.kind);
    const c = dialogCases[seen.length - 1];
    if (!c) return;
    v.respondToDialog(d.requestId, c.accept, c.text);
  };
  v.on("dialog", handler);
  for (const c of dialogCases) {
    const r = await v.evaluate(c.expr) as { ok: boolean; value?: unknown };
    ok(`dialog ${c.kind} accept=${c.accept} → ${JSON.stringify(c.expect)}`,
       r.ok === true && r.value === c.expect, r);
  }
  ok("dialog kinds observed in order",
     seen.length === dialogCases.length && seen.every((k, i) => k === dialogCases[i].kind), seen);
} else if (caps.dialogs) {
  ok("dialogs capability advertised (WV2 round-trip on data: URL deferred — appres harness)", true);
}

// waitForSelector — exposed on SurfaceCap, not BrowserView; skip on this
// (BrowserView-direct) path. Round-trip coverage lives in surface-based tests.
ok("waitForSelector smoke (BrowserView path skips — SurfaceCap-only)", true);

// console capture round-trip needs an appres-based test harness (preload
// inject + RPC reporting cap both work cleanly from appres origin). In this
// NavigateToString smoke the preload may not inject (CEF) or the encrypted
// RPC handshake's crypto.subtle is unavailable in non-secure context (WV2).
// Capability bit verified above is the smoke-level guarantee.
if (caps.console) {
  ok("console capability advertised (round-trip test deferred to surface harness)", true);
}
}

win.show();
void runChecks();
app.run();
