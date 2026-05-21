// Iframe fallback for web (no-op if native already registered). HTMLElement deref'd lazily so module is import-safe in Node/Bun.

import type { SurfaceEvent, SurfaceEventBase } from "../rpc/framework";

// Default sandbox omits allow-same-origin / allow-top-navigation / allow-modals /
// allow-popups-to-escape-sandbox — popup escape stays opt-in so a sandboxed page
// can't launch unsandboxed auxiliary contexts by default.
const DEFAULT_SANDBOX = "allow-scripts allow-forms allow-popups";
const BLOCKED_SCHEME_RE = /^(javascript|data|vbscript|file|about):/i;

// WHATWG URL parsing strips embedded ASCII tab/LF/CR and leading C0/space
// before scheme detection. Mirror that so embedded controls (e.g. `java\nscript:`)
// can't bypass the scheme guard.
function normalizeForSchemeCheck(src: string): string {
  return src.replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+/, "");
}

export function isBlockedSrc(src: string | null | undefined): boolean {
  if (typeof src !== "string") return false;
  return BLOCKED_SCHEME_RE.test(normalizeForSchemeCheck(src));
}

let cachedClass: CustomElementConstructor | null = null;

function definePolyfillClass(): CustomElementConstructor {
  if (cachedClass) return cachedClass;

  class BuniteWebviewPolyfill extends HTMLElement {
    static observedAttributes = ["src", "sandbox", "unsandboxed"];

    private _iframe: HTMLIFrameElement | null = null;
    private _titleObserver: MutationObserver | null = null;
    private _lastTitle: string = "";
    private _epoch: number = 0;
    private _isLoading: boolean = false;
    private _currentUrl: string = "";

    private isReachable(): boolean {
      if (!this._iframe) return false;
      try {
        return this._iframe.contentDocument != null;
      } catch { return false; }
    }

    private modifierBag(mods?: string[]): {
      shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean;
    } {
      return {
        shiftKey: !!mods?.includes("shift"),
        ctrlKey:  !!mods?.includes("ctrl"),
        altKey:   !!mods?.includes("alt"),
        metaKey:  !!mods?.includes("meta"),
      };
    }

    private emit(event: SurfaceEventBase) {
      if (event.type === "navigate") {
        this._epoch++;
        this._currentUrl = event.url;
      } else if (event.type === "load-start") {
        this._isLoading = true;
      } else if (event.type === "load-finish" || event.type === "load-fail") {
        this._isLoading = false;
      }
      const stamped: SurfaceEvent = { ...event, epoch: this._epoch };
      this.dispatchEvent(new CustomEvent<SurfaceEvent>("surface-event", { detail: stamped }));
    }

    private setupTitleObserver() {
      this._titleObserver?.disconnect();
      this._titleObserver = null;
      if (!this.isReachable()) return;
      const doc = this._iframe!.contentDocument!;
      this._lastTitle = doc.title;
      const fire = () => {
        const t = doc.title;
        if (t && t !== this._lastTitle) {
          this._lastTitle = t;
          this.emit({ type: "title-change", title: t });
        }
      };
      const observer = new MutationObserver(fire);
      const headEl = doc.head ?? doc.documentElement;
      if (headEl) observer.observe(headEl, { childList: true, subtree: true, characterData: true });
      this._titleObserver = observer;
    }

    private applySandbox(iframe: HTMLIFrameElement) {
      if (this.hasAttribute("unsandboxed")) {
        iframe.removeAttribute("sandbox");
        return;
      }
      const override = this.getAttribute("sandbox");
      iframe.setAttribute("sandbox", override ?? DEFAULT_SANDBOX);
    }

    private dispatchBlocked(url: string) {
      this.emit({ type: "load-fail", url, reason: "blocked-scheme" });
    }

    connectedCallback() {
      if (this._iframe) return;

      const iframe = document.createElement("iframe");
      iframe.style.cssText = "display:block;width:100%;height:100%;border:0;background:inherit;";
      iframe.referrerPolicy = "no-referrer";
      this.applySandbox(iframe);

      const src = this.getAttribute("src");
      if (src) {
        if (isBlockedSrc(src)) {
          this.dispatchBlocked(src);
        } else {
          iframe.src = src;
          this._currentUrl = src;
          this.emit({ type: "load-start", url: src });
        }
      }

      iframe.addEventListener("load", () => {
        let url = iframe.src;
        try {
          url = iframe.contentWindow?.location.href ?? url;
        } catch {}
        // Suppress the spurious about:blank load that fires after a blocked
        // navigation (or before any explicit navigate).
        if (isBlockedSrc(url)) return;
        // navigate first so load-finish carries the bumped epoch.
        this.emit({ type: "navigate", url });
        this.emit({ type: "load-finish", url });
        this.setupTitleObserver();
      });

      this._iframe = iframe;
      this.appendChild(iframe);
    }

    disconnectedCallback() {
      this._titleObserver?.disconnect();
      this._titleObserver = null;
      this._iframe?.remove();
      this._iframe = null;
    }

    attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null) {
      if (!this._iframe) return;
      if (name === "src") {
        if (newValue && isBlockedSrc(newValue)) {
          this.dispatchBlocked(newValue);
          return;
        }
        this._iframe.src = newValue ?? "";
        if (newValue) this.emit({ type: "load-start", url: newValue });
      } else if (name === "sandbox" || name === "unsandboxed") {
        // Sandbox token changes take effect on the next navigation per HTML spec.
        this.applySandbox(this._iframe);
      }
    }

    navigate(url: string) {
      this.setAttribute("src", url);
    }

    goBack() {
      try {
        this._iframe?.contentWindow?.history.back();
      } catch {}
    }

    reload() {
      try {
        this._iframe?.contentWindow?.location.reload();
      } catch {
        if (this._iframe) {
          this._iframe.src = this._iframe.src;
        }
      }
    }

    setHidden(hidden: boolean) {
      if (this._iframe) {
        this._iframe.style.display = hidden ? "none" : "block";
      }
    }

    // Automation surface — works when the iframe is same-origin reachable
    // (i.e. `<bunite-webview unsandboxed>` + same-origin src). Default sandbox
    // strips `allow-same-origin`, so reachability is opt-in. `isTrusted` on
    // synthesised DOM events is always false → `nativeInputTrusted` stays false.
    async evaluate(script: string) {
      if (!this.isReachable()) {
        return { ok: false as const, code: "cross_origin" as const, message: "iframe content not same-origin" };
      }
      try {
        const win = this._iframe!.contentWindow as Window & { eval(s: string): unknown };
        return { ok: true as const, value: win.eval(script) };
      } catch (e: unknown) {
        const err = e as { name?: string; message?: string };
        if (err?.name === "SecurityError") {
          return { ok: false as const, code: "cross_origin" as const, message: err.message ?? "SecurityError" };
        }
        return { ok: false as const, code: "runtime_error" as const, message: err?.message ?? String(e) };
      }
    }

    async capabilities() {
      const reachable = this.isReachable();
      return {
        evaluate: reachable, crossOriginEval: false, surfaceEvents: true,
        nativeInputTrusted: false,
        click: reachable, type: reachable, press: reachable, scroll: reachable,
        mouse: reachable, dialogs: false, console: false,
        screenshot: false,
      };
    }

    async sendClick(args: {
      x: number; y: number; button?: string; clickCount?: number; modifiers?: string[];
    }) {
      if (!this.isReachable()) return;
      const doc = this._iframe!.contentDocument!;
      const target = doc.elementFromPoint(args.x, args.y) ?? doc.body;
      if (!target) return;
      const init: MouseEventInit = {
        bubbles: true, cancelable: true, view: this._iframe!.contentWindow,
        clientX: args.x, clientY: args.y,
        button: args.button === "right" ? 2 : args.button === "middle" ? 1 : 0,
        detail: args.clickCount ?? 1,
        ...this.modifierBag(args.modifiers),
      };
      target.dispatchEvent(new MouseEvent("mousedown", init));
      target.dispatchEvent(new MouseEvent("mouseup", init));
      target.dispatchEvent(new MouseEvent("click", init));
    }

    async resolveAndClick(_selector: string, _opts?: unknown) {
      return { ok: false as const, code: "not_supported" as const, message: "polyfill iframe: atomic resolveAndClick not supported" };
    }

    async sendType(text: string) {
      if (!this.isReachable()) return;
      const doc = this._iframe!.contentDocument!;
      const target = doc.activeElement as (HTMLInputElement | HTMLTextAreaElement | null);
      if (!target || !("setRangeText" in target)) return;
      // setRangeText preserves selection + caret; the `data` field on an
      // InputEvent + bubbling lets React-style controllers detect the change.
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;
      target.setRangeText(text, start, end, "end");
      target.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    }

    async sendPress(key: string, modifiers?: string[], action?: "down" | "up" | "both") {
      if (!this.isReachable()) return;
      const doc = this._iframe!.contentDocument!;
      const target = (doc.activeElement ?? doc.body) as Element | null;
      if (!target) return;
      const init: KeyboardEventInit = {
        bubbles: true, cancelable: true, key, ...this.modifierBag(modifiers),
      };
      const a = action ?? "both";
      if (a !== "up") target.dispatchEvent(new KeyboardEvent("keydown", init));
      if (a === "both") target.dispatchEvent(new KeyboardEvent("keypress", init));
      if (a !== "down") target.dispatchEvent(new KeyboardEvent("keyup", init));
    }

    async sendScroll(args: { dx: number; dy: number; x?: number; y?: number; modifiers?: string[] }) {
      if (!this.isReachable()) return;
      this._iframe!.contentWindow!.scrollBy(args.dx, args.dy);
    }

    async sendMouse(args: {
      action: "move" | "down" | "up";
      x: number; y: number;
      button?: string;
      modifiers?: string[];
    }) {
      if (!this.isReachable()) return;
      const doc = this._iframe!.contentDocument!;
      const target = doc.elementFromPoint(args.x, args.y) ?? doc.body;
      if (!target) return;
      const type = args.action === "move" ? "mousemove" : args.action === "down" ? "mousedown" : "mouseup";
      const init: MouseEventInit = {
        bubbles: true, cancelable: true, view: this._iframe!.contentWindow,
        clientX: args.x, clientY: args.y,
        button: args.button === "right" ? 2 : args.button === "middle" ? 1 : 0,
        ...this.modifierBag(args.modifiers),
      };
      target.dispatchEvent(new MouseEvent(type, init));
    }

    async respondToDialog(_requestId: number, _accept: boolean, _text?: string) {
      // iframe sandbox forbids cross-frame dialog interception; nothing to do.
    }

    async setDialogTimeout(_ms: number | null) { /* no-op */ }

    async waitForSelector(selector: string, timeoutMs = 5000) {
      if (!this.isReachable()) {
        return { ok: false as const, code: "runtime_error" as const, message: "iframe content not same-origin" };
      }
      const doc = this._iframe!.contentDocument!;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (doc.querySelector(selector)) return { ok: true as const };
        await new Promise((r) => setTimeout(r, 50));
      }
      return { ok: false as const, code: "timeout" as const, message: `selector ${JSON.stringify(selector)} not found within ${timeoutMs}ms` };
    }

    async waitForFunction(expression: string, opts?: { timeoutMs?: number; pollIntervalMs?: number }) {
      if (!this.isReachable()) {
        return { ok: false as const, code: "runtime_error" as const, message: "iframe content not same-origin" };
      }
      const win = this._iframe!.contentWindow as Window & { eval(s: string): unknown };
      const deadline = Date.now() + (opts?.timeoutMs ?? 5000);
      const interval = opts?.pollIntervalMs ?? 50;
      while (Date.now() < deadline) {
        try {
          if (win.eval(expression)) return { ok: true as const };
        } catch (e) {
          return { ok: false as const, code: "runtime_error" as const, message: (e as Error).message };
        }
        await new Promise((r) => setTimeout(r, interval));
      }
      return { ok: false as const, code: "timeout" as const, message: `function did not satisfy within ${opts?.timeoutMs ?? 5000}ms` };
    }

    async getConsoleBuffer(_opts?: { clear?: boolean }) {
      // iframe polyfill doesn't inject a preload — no console capture available.
      return [] as { level: string; args: string[]; ts: number }[];
    }

    async getNavigationState() {
      return { lastLoadEpoch: this._epoch, isLoading: this._isLoading, currentUrl: this._currentUrl };
    }

    async screenshot(_args?: { format?: "png" | "jpeg"; quality?: number }) {
      return { ok: false as const, code: "not_supported" as const, message: "iframe polyfill does not support screenshot" };
    }
  }

  cachedClass = BuniteWebviewPolyfill;
  return cachedClass;
}

/**
 * `<bunite-webview>` iframe polyfill — `import "bunite-core/polyfill"` to register.
 * No-op in non-browser environments and when the native CEF preload has already
 * registered the element.
 *
 * Defaults (web fallback only — native paths bypass these):
 * - `sandbox="allow-scripts allow-forms allow-popups"` (popup-escape stays opt-in).
 * - `referrerpolicy="no-referrer"`.
 * - `javascript:` / `data:` / `vbscript:` / `file:` / `about:` schemes blocked
 *   (with WHATWG URL-style normalization to defeat embedded-control bypass);
 *   navigation attempt dispatches `surface-event` with `detail.type === "load-fail"`
 *   and `detail.reason === "blocked-scheme"`.
 *
 * Opt-out attributes on `<bunite-webview>` (observed — mutations re-apply):
 * - `sandbox="..."` — override the default sandbox token string verbatim.
 * - `unsandboxed` — remove the sandbox attribute entirely (trusted-content escape hatch).
 */
if (typeof customElements !== "undefined" && !customElements.get("bunite-webview")) {
  customElements.define("bunite-webview", definePolyfillClass());
}
