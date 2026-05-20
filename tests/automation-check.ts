// Manual verification of the SurfaceCap automation surface (Stage B+C).
// Run: `bun tests/automation-check.ts` from the repo root with native built.
//
// Opens a window with a self-contained test page, exercises every automation
// method, prints PASS/FAIL per step, writes a screenshot to disk, then quits.
// Keep the window in the foreground during the run — CDP input dispatch on
// WebView2 doesn't *require* focus, but visually verifying the events helps.

import { AppRuntime, BrowserWindow } from "../package/src/host/index";

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>boot</title></head>
<body style="font:14px monospace;padding:1em">
  <input id="input" placeholder="type target" autofocus style="font-size:16px;padding:4px;width:30em">
  <button id="btn" style="margin:1em;padding:8px 16px">click me</button>
  <div id="log" style="border:1px solid #888;padding:8px;min-height:6em;white-space:pre-wrap"></div>
  <div style="height:1200px;background:linear-gradient(#cdf,#fcf)">tall scroll area</div>
  <script>
    var log = document.getElementById("log");
    var append = function (s) { log.textContent += s + "\\n"; };
    document.getElementById("btn").addEventListener("click", function () { append("[click] at " + Date.now()); });
    document.getElementById("input").addEventListener("input", function (e) { append("[input] '" + e.target.value + "'"); });
    document.addEventListener("keydown", function (e) { append("[keydown] " + e.key + " (code=" + e.code + ")"); });
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

if (caps.type) {
  await v.evaluate("document.getElementById('input').focus()");
  await sleep(50);
  v.type("hi");
  await sleep(200);
  const r3 = await v.evaluate("document.getElementById('input').value") as { ok: boolean; value?: unknown };
  ok("type 'hi' → input.value === 'hi'", r3.ok === true && r3.value === "hi", r3);
}

if (caps.click) {
  // IIFE — evaluate's wrapper wraps the script in `(<expr>)`, so statements
  // (e.g. bare `const`) parse-fail. An IIFE keeps the body a single expression.
  const rect = await v.evaluate(
    "(function(){var r=document.getElementById('btn').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()"
  ) as { ok: boolean; value?: unknown };
  if (rect.ok && rect.value && typeof rect.value === "object") {
    const { x, y } = rect.value as { x: number; y: number };
    await v.evaluate("document.getElementById('log').textContent=''");
    v.click({ x, y });
    await sleep(200);
    const r5 = await v.evaluate("document.getElementById('log').textContent") as { ok: boolean; value?: unknown };
    const hit = r5.ok && typeof r5.value === "string" && r5.value.includes("[click]");
    ok(`click at button (${x.toFixed(0)},${y.toFixed(0)}) → '[click]' in log`, hit, r5.value);
  } else {
    ok("click prep: get button rect", false, rect);
  }
}

if (caps.press) {
  await v.evaluate("document.getElementById('log').textContent=''; document.body.focus()");
  v.press("Enter");
  await sleep(150);
  const r6 = await v.evaluate("document.getElementById('log').textContent") as { ok: boolean; value?: unknown };
  const hit = r6.ok && typeof r6.value === "string" && r6.value.includes("[keydown] Enter");
  ok("press 'Enter' → keydown fires", hit, r6.value);
}

if (caps.scroll) {
  await v.evaluate("document.getElementById('log').textContent=''; window.scrollTo(0,0)");
  v.scroll({ dx: 0, dy: 200, x: 100, y: 100 });
  await sleep(200);
  const r7 = await v.evaluate("window.scrollY") as { ok: boolean; value?: unknown };
  ok("scroll dy=200 → scrollY > 0", r7.ok === true && typeof r7.value === "number" && (r7.value as number) > 0, r7);
}

if (caps.screenshot) {
  const shot = await v.screenshot("png", 90);
  if (shot.ok) {
    await Bun.write("automation-shot.png", shot.data);
    ok(`screenshot png → ${shot.data.byteLength} bytes (automation-shot.png)`, shot.data.byteLength > 1000);
  } else {
    ok("screenshot png", false, shot);
  }
}

// titleChanged stream — set title and observe via event.
let titleFired = false;
v.on("title-changed", (event) => {
  const detail = String((event as { data?: { detail?: string } }).data?.detail ?? "");
  if (detail === "changed-by-test") titleFired = true;
});
await v.evaluate("document.title='changed-by-test'");
await sleep(300);
ok("titleChanged event fires on document.title write", titleFired);
}

win.show();
void runChecks();
app.run();
