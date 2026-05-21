# Browser automation

`<bunite-webview>` is the in-window child surface element bunite provides for embedding navigable webviews inside your host UI. This document covers the automation surface it exposes — programmatic input, navigation observation, evaluation, and screenshots.

## Quick start

```html
<bunite-webview src="https://example.com" id="wv" style="width:800px;height:600px"></bunite-webview>

<script type="module">
  const wv = document.getElementById("wv");

  wv.addEventListener("surface-event", (e) => {
    if (e.detail.type === "title-change") document.title = e.detail.title;
  });

  await wv.sendClick({ x: 100, y: 200 });
  await wv.sendType("hello");
  await wv.sendPress("Enter");
  const shot = await wv.screenshot({ format: "png" });
</script>
```

`<bunite-webview>` is auto-registered by the preload runtime in the host process and exposes the methods below.

## Element API

| Method | Returns | Notes |
|---|---|---|
| `navigate(url)` | void | Sets `src` attribute. |
| `goBack()` | void | History back. |
| `reload()` | void | Reload current document. |
| `setHidden(b)` | void | Toggle visibility without removing. |
| `capabilities()` | `Promise<SurfaceCapabilities>` | Per-surface feature bitset. |
| `evaluate(script)` | `Promise<EvaluateResult>` | Run JS in the surface. Returns `{ ok, value }` or `{ ok: false, code, message }`. |
| `sendClick(args)` | `Promise<void>` | `{x, y, button?, clickCount?, modifiers?}`. |
| `sendType(text)` | `Promise<void>` | UTF-8 text — no IME composition. |
| `sendPress(key, mods?, action?)` | `Promise<void>` | DOM `KeyboardEvent.key`. `action`: `"down" \| "up" \| "both"` (default both). |
| `sendScroll(args)` | `Promise<void>` | `{dx, dy, x?, y?, modifiers?}` — CSS pixels. |
| `sendMouse(args)` | `Promise<void>` | `{action: "move" \| "down" \| "up", x, y, button?, modifiers?}`. Drag = down → move(s) → up. Hover = move. |
| `respondToDialog(requestId, accept, text?)` | `Promise<void>` | Resolve a pending `dialog` event from the `dialogs` stream. `text` only used for `prompt`. |
| `setDialogTimeout(ms)` | `Promise<void>` | Auto-dismiss after `ms` if no `respondToDialog` arrives. `null` disables (page hangs until you respond). Default 5000. |
| `waitForSelector(selector, timeoutMs?)` | `Promise<WaitResult>` | Poll `document.querySelector(selector)` until truthy or timeout (default 5000ms). `WaitResult` failure codes: `timeout` / `runtime_error` / `cross_origin`. |
| `waitForFunction(expr, opts?)` | `Promise<WaitResult>` | Poll a JS expression until truthy. `{timeoutMs?, pollIntervalMs?}` — default 5000 / 50. Same failure codes as `waitForSelector`. |
| `getConsoleBuffer(opts?)` | `Promise<ConsoleEntry[]>` | Snapshot of host-side console ring buffer (200 entries). `{clear: true}` empties after read. |
| `getNavigationState()` | `Promise<NavigationState>` | `{lastLoadEpoch, isLoading, currentUrl}`. Use `lastLoadEpoch` to race-close waits on `surface-event` arms. |
| `accessibilitySnapshot(opts?)` | `Promise<AccessibilitySnapshotResult>` | CDP `Accessibility.getFullAXTree` (Chromium-backed only). `{interestingOnly?}` defaults true (drops ignored nodes). |
| `getBoundingRect(selector, opts?)` | `Promise<BoundingRectResult>` | `document.querySelector(...).getBoundingClientRect()` + viewport intersect. `opts.frameId` queries inside that frame. |
| `listFrames()` | `Promise<ListFramesResult>` | Enumerate frames (CDP `Page.getFrameTree`). Chromium-backed only; mac/linux return `not_supported`. |
| `evaluate(script, opts?)` | `Promise<EvaluateResult>` | `opts.frameId` evaluates inside the target frame's isolated world — page main-world JS variables are not visible; DOM access works. |
| `setDownloadPolicy(policy, downloadDir?)` | `Promise<void>` | `policy`: `"auto"` allows + emits lifecycle, `"block"` (default) cancels + emits `blocked`, `"ask"` is reserved (treated as block until implemented). |
| `waitForDownload(opts?)` | `Promise<WaitForDownloadResult>` | Resolves on next download started after the call (`{timeoutMs?}` default 30000). |
| `dismissPopup(newSurfaceId)` | `Promise<void>` | Close a popup-minted surface received via `surface-event` `popup` arm. Adoption: render `<bunite-webview adopt-popup-id="N">` instead. |
| `screenshot(args?)` | `Promise<ScreenshotResult>` | `{format?: "png" \| "jpeg", quality?}`. |

`Modifier = "alt" | "ctrl" | "meta" | "shift"`.

## Surface events

A single stream replaces per-event subscriptions. `<bunite-webview>` dispatches one DOM event:

```ts
wv.addEventListener("surface-event", (e: CustomEvent<SurfaceEvent>) => { /* ... */ });

type SurfaceEvent =
  | { type: "navigate"; epoch: number; url: string }
  | { type: "load-start"; epoch: number; url: string }
  | { type: "load-finish"; epoch: number; url: string }
  | { type: "load-fail"; epoch: number; url: string; reason?: string }
  | { type: "title-change"; epoch: number; title: string }
  | { type: "popup"; epoch: number; url: string; disposition: "tab" | "window" | "popup"; openerSurfaceId: number; newSurfaceId: number };

type NavigationState = { lastLoadEpoch: number; isLoading: boolean; currentUrl: string };
```

`epoch` bumps on every `navigate` (incl. SPA `pushState`). Other arms carry the current epoch. Combine with `getNavigationState()` to wait for the *next* navigation without racing pre-existing arms — see "Race-free navigation wait".

Dialogs and console messages go through **separate streams** (`SurfaceCap.dialogs` and `SurfaceCap.consoleEvents`) — fire-and-forget surfaceEvents arms don't fit the request/response semantics of dialogs, and consoleEvents can be high-frequency.

```ts
type DialogEvent =
  | { kind: "alert" | "confirm" | "prompt" | "beforeunload"; requestId: number; message: string; defaultPrompt?: string }
  | { kind: "auto-dismissed"; originalKind: ...; message: string };

type ConsoleEntry = {
  level: "log" | "warn" | "error" | "info" | "debug";
  args: string[];   // JSON-stringified / String() fallback
  ts: number;       // page-side Date.now()
};
```

**Dialog flow**: backend pauses page execution → emits `DialogEvent` → consumer calls `respondToDialog(requestId, accept, text?)` → page resumes. If no response within `setDialogTimeout` (default 5s), an `auto-dismissed` arm fires and the page proceeds with the default (cancel / no input). `setDialogTimeout(null)` disables the safety net.

**Popup flow**: backend intercepts `window.open` / `target="_blank"` / `cmd-click` → eager-mints the new surface (preserves `window.opener`) → emits `popup` arm with `newSurfaceId`. Host has 5s to adopt — either render `<bunite-webview adopt-popup-id="123">` (element drives `acceptPopup` with its own bounds + this page as host) or call `runtime.surface().acceptPopup({newSurfaceId, hostViewId, bounds})` directly. `dismissPopup({newSurfaceId})` closes; auto-dismiss fires on timeout. mac/linux currently fall through to engine-default popup handling (no `popup` arm emitted) — capability bit reflects this.

**Download flow**: per-surface `setDownloadPolicy("auto", "<dir>")` arms the lifecycle pipe. Subsequent downloads dispatch `download-event` CustomEvents (`{kind: "started"|"progress"|"completed"|"failed"|"blocked", id, ...}`). `waitForDownload({timeoutMs?})` resolves on the next `started` → terminal pair. Default policy is `"block"` (engine cancels + emits `blocked` with `reason: "host-policy"`).

Invariants:

- A navigation emits **`load-finish` OR `load-fail`**, never both.
- SPA history mutations (`history.pushState`) emit only `navigate` — no `load-*`.
- For a given navigation, `navigate` always precedes `load-finish` (epoch is incremented on `navigate`, so terminal arms carry the *new* epoch — required for the race-free wait pattern). `load-start` may precede `navigate`.

## Press: modifier-held wrap

`sendClick({modifiers: ["ctrl"]})` produces an event with `ctrlKey=true` on most backends — but **not on macOS**, where AppKit converts Ctrl+leftClick into a secondary (right) click and stalls the UI thread. We strip the Control bit from mouse modifierFlags on mac as a result.

For real Ctrl-click semantics across backends, hold the modifier via keyboard events around the click:

```js
await wv.sendPress("Control", undefined, "down");
await wv.sendClick({ x, y });
await wv.sendPress("Control", undefined, "up");
```

The same pattern works for any modifier (Shift / Alt / Meta) when you need the page to see the modifier state independent of the click's own modifier bits.

## Capabilities

`capabilities()` returns honest per-surface flags. Treat missing fields as `false` (the type is append-only). A method may be present on the RPC surface but return `{ ok: false, code: "not_supported" }` when the backend can't fulfil it — gate calls on the capability bit when behavior must be deterministic.

| Capability | Win WV2 | Win CEF | mac WKWebView | Linux WebKitGTK |
|---|---|---|---|---|
| `evaluate` | ✔ | ✔ | ✔ | ✔ |
| `crossOriginEval` | ✘ | ✘ | ✘ | ✘ |
| `surfaceEvents` | ✔ | ✔ | ✔ | ✔ |
| `nativeInputTrusted` | ✔ | ✔ | ✔ | n/a |
| `click` / `type` / `press` / `mouse` | ✔ | ✔ | ✔ | ✘ |
| `scroll` | ✔ | ✔ † | ✔ | ✘ |
| `dialogs` (alert/confirm/prompt) | ✔ | ✔ | ✔ | ✔ |
| `dialogs.beforeunload` | ✔ | ✔ | ✘ ‡ | ✔ |
| `console` (page log capture) | ✔ | ✔ | ✔ | ✔ |
| `screenshot` | ✔ | ✔ † | ✔ | ✔ |
| `formats` | png, jpeg | png, jpeg | png, jpeg | png, jpeg |
| `accessibilitySnapshot` | ✔ | ✔ | ✘ | ✘ |
| `getBoundingRect` | ✔ | ✔ | ✔ | ✔ |
| `frames` (`listFrames`, `evaluate({frameId})`) | ✔ | ✔ | ✘ | ✘ |
| `downloads` (`setDownloadPolicy`, `downloadEvents`, `waitForDownload`) | ✔ | ✔ | ✘ | ✘ |
| `popups` (`popup` arm + `acceptPopup` / `dismissPopup`) | ✔ | ✔ | ✘ | ✘ |

† On CEF, `scroll` and `screenshot` route through Chrome DevTools Protocol (`Input.dispatchMouseEvent` / `Page.captureScreenshot`) — native `SendMouseWheelEvent` doesn't reach the page in windowed mode, and `PrintWindow` misses hardware-composited surfaces.

‡ WebKit (mac WKWebView, linux WebKitGTK) routes `beforeunload` confirmation through the navigation-policy delegate, not the script-dialog channel — bunite surfaces it as a `will-navigate` event instead. mac doesn't emit a `dialogs` arm with `kind: "beforeunload"`; consumers gating navigation on user confirm should listen for `will-navigate` and use the existing nav-rule allow list.

`console` is captured by the preload via a `console.{log,warn,error,info,debug}` proxy, batched at 16ms intervals, and pushed through the encrypted RPC channel. Effective only for surfaces in the preload-injection allowlist (default `appres://app.internal/*` + `preloadOrigins`); cross-origin pages and `NavigateToString` documents (non-secure context — `crypto.subtle` unavailable for the encrypted channel) leave both the stream and the host-side buffer empty.

A page-side ring buffer keyed by `Symbol.for("bunite.console.buffer")` survives the RPC handshake — for non-secure-context surfaces (where the encrypted channel can't open) consumers can `evaluate("JSON.stringify(window[Symbol.for('bunite.console.buffer')])")` to drain the last 200 entries retrospectively. The host-side `getConsoleBuffer` is the primary path; the page-side fallback only matters when RPC is genuinely unreachable.

### `nativeInputTrusted` meaning

`nativeInputTrusted: true` means **click / type / press / mouse** produce events with `isTrusted === true` on the page. It does **not** cover `scroll` or `screenshot`, which on some backends (CEF) go through CDP and synthesize events with `isTrusted === false`. Pages that gate behavior on `wheelEvent.isTrusted` should be aware.

Linux is `n/a` because click/type/press/mouse themselves are not implemented (no honest path through GTK4+Wayland) — the methods exist on the RPC surface but `capabilities().click === false` and calls are silent no-ops.

## Backend selection

Default is WebView2 on Windows (Edge runtime, system-provided). CEF is an opt-in:

```ts
new AppRuntime({ engine: "cef" })  // + `bun add bunite-cef-win-x64`
```

Use CEF when you need:

- `setMasks` — drop-indicator-style region cutouts on host overlay (WebView2's D3D Intermediate Window bypasses GDI `SetWindowRgn`).
- Chromium command-line flag control (`engineConfig`).

macOS and Linux always use the system WebKit (WKWebView / WebKitGTK 6.0) — no engine selection.

## iframe polyfill (web)

`import "bunite-core/polyfill"` registers a `<bunite-webview>` web-fallback that proxies via iframe. Useful for web-mode previews of the same UI you ship in the desktop runtime.

Limitations vs. native:

- `evaluate` / `sendClick` / `sendType` / `sendPress` / `sendScroll` work only when the iframe is same-origin-reachable (default sandbox strips `allow-same-origin`; opt in with `<bunite-webview unsandboxed>`).
- All synthesized events have `isTrusted === false`.
- `screenshot` returns `{ ok: false, code: "not_supported" }`.
- `surfaceEvents` fires from iframe `load` + MutationObserver on `<title>`; honest `load-fail` only on blocked schemes (default sandbox blocks `javascript:` / `data:` / `vbscript:` / `file:` / `about:`).

## Common patterns

**Race-free navigation wait** — capture the current epoch *before* triggering, then await an arm with a strictly greater epoch:

```js
const { lastLoadEpoch } = await wv.getNavigationState();
const finished = new Promise(resolve => {
  const handler = (e) => {
    if (e.detail.type === "load-finish" && e.detail.epoch > lastLoadEpoch) {
      wv.removeEventListener("surface-event", handler);
      resolve(e.detail.url);
    }
  };
  wv.addEventListener("surface-event", handler);
});
await wv.sendClick({ x, y });   // or wv.navigate(...), or any nav-triggering action
const url = await finished;
```

Without the epoch gate, the listener may fire on a previous page's `load-finish` between trigger dispatch and attachment. For SPA navigations, gate on `navigate` instead — no `load-*` arms follow.

**Locate an element by selector, then click it:**

```js
const r = await wv.evaluate(`(function(){var b=document.querySelector("button.submit");if(!b)return null;var r=b.getBoundingClientRect();return {x:r.x+r.width/2, y:r.y+r.height/2}})()`);
if (r.ok && r.value) await wv.sendClick(r.value);
```

**Observe the page's network requests after load (no dedicated cap):**

bunite doesn't expose a CDP `Network.*` stream — the common cases are covered by the page's own `PerformanceResourceTiming` entries, which are populated by every backend. Poll after `load-finish`:

```js
wv.addEventListener("surface-event", async (e) => {
  if (e.detail.type !== "load-finish") return;
  const r = await wv.evaluate(`
    performance.getEntriesByType("resource").map(e => ({
      url: e.name,
      type: e.initiatorType,
      status: e.responseStatus,   // 200/404/etc (some backends report 0 for opaque)
      transferred: e.transferSize,
      durationMs: e.duration,
    }))
  `);
  if (r.ok) console.log("requests:", r.value);
});
```

What this gives you: URL, initiator type, HTTP status (where exposed), transfer size, duration. What it doesn't give: real-time mid-flight events, request/response headers, request bodies. For those, drive the page through a controlled fixture (proxy / scheme handler) rather than relying on the runtime to introspect arbitrary network traffic.

**Capture a screenshot only when the surface supports the format you want:**

```js
const caps = await wv.capabilities();
if (caps.screenshot && caps.formats?.includes("jpeg")) {
  const r = await wv.screenshot({ format: "jpeg", quality: 80 });
  // ...
}
```

## See also

- `examples/browser-automation/` — runnable demo exercising every method + capability chip display.
- `tests/automation-check.ts` — end-to-end verification harness (19 assertions per backend).
