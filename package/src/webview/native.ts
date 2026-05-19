// <bunite-webview> custom element — registered in every appres:// page via preload.

import type { ClientOf } from "../rpc/index";
import type { SurfaceCap, EvaluateResult, SurfaceCapabilities } from "../rpc/framework";

declare const host: {
  runtime(): Promise<ClientOf<typeof import("../rpc/framework").RuntimeCap>>;
};

type SurfaceClient = ClientOf<typeof SurfaceCap>;
let _surfaceCap: Promise<SurfaceClient> | null = null;
function getSurfaceCap(): Promise<SurfaceClient> {
  if (!_surfaceCap) {
    _surfaceCap = host.runtime().then((r) => r.surface());
  }
  return _surfaceCap;
}

function callSurface<R>(fn: (s: SurfaceClient) => Promise<R> | R): Promise<R | void> {
  return getSurfaceCap().then(fn).catch((err) => {
    if ((globalThis as { __BUNITE_DEBUG__?: boolean }).__BUNITE_DEBUG__) {
      console.warn("[bunite] surface call failed", err);
    }
    return undefined;
  });
}

/** Like `callSurface` but never swallows — automation surface API needs to
 *  return structured envelopes so callers can react to surface absence. */
function callSurfaceTyped<R>(fn: (s: SurfaceClient) => Promise<R> | R): Promise<R> {
  return getSurfaceCap().then(fn);
}

// OverlaySyncController: ResizeObserver + rAF position polling; dirty-flag coalescing ≤1 IPC/frame.

type Rect = { x: number; y: number; width: number; height: number };

class OverlaySyncController {
  private element: HTMLElement;
  private onBoundsChange: (rect: Rect) => void;
  private observer: ResizeObserver | null = null;
  private rafId = 0;
  private lastRect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private dirty = false;
  private stopped = false;

  constructor(element: HTMLElement, onBoundsChange: (rect: Rect) => void) {
    this.element = element;
    this.onBoundsChange = onBoundsChange;
  }

  start() {
    this.observer = new ResizeObserver(() => this.markDirty());
    this.observer.observe(this.element);
    this.scheduleFrame();
  }

  stop() {
    this.stopped = true;
    this.observer?.disconnect();
    this.observer = null;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  private markDirty() {
    this.dirty = true;
  }

  private scheduleFrame() {
    if (this.stopped) return;
    this.rafId = requestAnimationFrame(() => {
      this.flush();
      this.scheduleFrame();
    });
  }

  private flush() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.element.getBoundingClientRect();
    const rect: Rect = {
      x: Math.round(r.x * dpr),
      y: Math.round(r.y * dpr),
      width: Math.round(r.width * dpr),
      height: Math.round(r.height * dpr)
    };

    // Always check for position changes (not caught by ResizeObserver)
    if (
      !this.dirty &&
      rect.x === this.lastRect.x &&
      rect.y === this.lastRect.y &&
      rect.width === this.lastRect.width &&
      rect.height === this.lastRect.height
    ) {
      return;
    }

    this.dirty = false;
    this.lastRect = rect;
    this.onBoundsChange(rect);
  }
}

// --- BuniteWebviewElement ---

type SurfaceInitResponse = { surfaceId: number };

class BuniteWebviewElement extends HTMLElement {
  static observedAttributes = ["src"];

  _surfaceId: number | null = null;
  private _syncCtrl: OverlaySyncController | null = null;
  private _initPromise: Promise<SurfaceInitResponse> | null = null;
  private _aborted = false;
  private _pendingSrc: string | null = null;
  private _syncHidden = false;
  private _userHidden = false;
  private _layoutObserver: ResizeObserver | null = null;
  private _unsubNavigate: (() => void) | null = null;
  private _activeStreams: Array<{ cancel?: () => void }> = [];

  constructor() {
    super();
    // NOTE: Custom element spec forbids setting attributes in constructor.
  }

  connectedCallback() {
    this._aborted = false;
    this._syncHidden = false;
    this._userHidden = false;
    const ctrl = new AbortController();
    this._unsubNavigate = () => ctrl.abort();
    void (async () => {
      try {
        const s = await getSurfaceCap();
        const stream = s.didNavigate();
        this._activeStreams.push(stream as { cancel?: () => void });
        for await (const ev of stream) {
          if (ctrl.signal.aborted) break;
          if (ev.surfaceId === this._surfaceId) {
            this.dispatchEvent(new CustomEvent("did-navigate", { detail: { url: ev.url } }));
          }
        }
      } catch (err) {
        if ((globalThis as { __BUNITE_DEBUG__?: boolean }).__BUNITE_DEBUG__) {
          console.warn("[bunite] didNavigate stream failed", err);
        }
      }
    })();
    void (async () => {
      try {
        const s = await getSurfaceCap();
        const stream = s.titleChanged();
        this._activeStreams.push(stream as { cancel?: () => void });
        for await (const ev of stream) {
          if (ctrl.signal.aborted) break;
          if (ev.surfaceId === this._surfaceId) {
            this.dispatchEvent(new CustomEvent("title-changed", { detail: { title: ev.title } }));
          }
        }
      } catch (err) {
        if ((globalThis as { __BUNITE_DEBUG__?: boolean }).__BUNITE_DEBUG__) {
          console.warn("[bunite] titleChanged stream failed", err);
        }
      }
    })();
    this._waitForLayout();
  }

  private _waitForLayout() {
    if (this._layoutObserver) return; // already waiting

    const tryInit = () => {
      if (!this.isConnected || this._aborted) return true; // stop waiting
      const r = this.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const src = this.getAttribute("src") || this._pendingSrc || "";
        if (src) this.initSurface();
        return true;
      }
      return false;
    };

    requestAnimationFrame(() => {
      if (tryInit()) return;
      // Element has no layout yet — wait via ResizeObserver
      this._layoutObserver = new ResizeObserver(() => {
        if (tryInit()) {
          this._layoutObserver?.disconnect();
          this._layoutObserver = null;
        }
      });
      this._layoutObserver.observe(this);
    });
  }

  disconnectedCallback() {
    this._aborted = true;
    this._unsubNavigate?.();
    this._unsubNavigate = null;
    // Cancel pending stream iterators so the `for await` actually unblocks —
    // AbortController alone only takes effect at the next received chunk.
    for (const stream of this._activeStreams) {
      try { stream.cancel?.(); } catch {}
    }
    this._activeStreams = [];
    this._layoutObserver?.disconnect();
    this._layoutObserver = null;
    this._syncCtrl?.stop();
    this._syncCtrl = null;

    if (this._surfaceId != null) {
      const id = this._surfaceId;
      this._surfaceId = null;
      void callSurface((s) => s.remove({ surfaceId: id }));
    } else if (this._initPromise) {
      this._initPromise
        .then((r) => { void callSurface((s) => s.remove({ surfaceId: r.surfaceId })); })
        .catch(() => {});
    }
    this._initPromise = null;
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null) {
    if (name !== "src") return;
    if (this._surfaceId != null) {
      const sid = this._surfaceId;
      void callSurface((s) => s.navigate({ surfaceId: sid, url: newValue || "" }));
    } else if (this._initPromise) {
      // Init in progress — queue for after completion
      this._pendingSrc = newValue || "";
    } else if (this.isConnected && !this._aborted && newValue) {
      // No init started yet (was waiting for src) — start now
      this._waitForLayout();
    }
  }

  setHidden(hidden: boolean) {
    this._userHidden = hidden;
    this._applySurfaceHidden();
  }

  goBack() {
    const sid = this._surfaceId;
    if (sid != null) void callSurface((s) => s.goBack({ surfaceId: sid }));
  }

  reload() {
    const sid = this._surfaceId;
    if (sid != null) void callSurface((s) => s.reload({ surfaceId: sid }));
  }

  navigate(url: string) {
    this.setAttribute("src", url);
  }

  async evaluate(script: string): Promise<EvaluateResult> {
    const sid = this._surfaceId;
    if (sid == null) return { ok: false, code: "not_supported", message: "surface not ready" };
    return callSurfaceTyped((s) => s.evaluate({ surfaceId: sid, script }));
  }

  async capabilities(): Promise<SurfaceCapabilities> {
    const sid = this._surfaceId;
    if (sid == null) {
      return {
        evaluate: false, crossOriginEval: false, titleChanged: false,
        nativeInputTrusted: false, click: false, type: false, press: false,
        scroll: false, screenshot: false,
      };
    }
    return callSurfaceTyped((s) => s.capabilities({ surfaceId: sid }));
  }

  private _applySurfaceHidden() {
    const sid = this._surfaceId;
    if (sid == null) return;
    const hidden = this._userHidden || this._syncHidden;
    void callSurface((s) => s.setHidden({ surfaceId: sid, hidden }));
  }

  private initSurface() {
    if (this._surfaceId != null || this._initPromise != null) return;

    const dpr = window.devicePixelRatio || 1;
    const r = this.getBoundingClientRect();
    const src = this._pendingSrc || this.getAttribute("src") || "";
    this._pendingSrc = null;

    const initPromise = getSurfaceCap().then((s) => s.init({
      src,
      x: Math.round(r.x * dpr),
      y: Math.round(r.y * dpr),
      width: Math.round(r.width * dpr),
      height: Math.round(r.height * dpr),
      hidden: this._userHidden,
    })) as Promise<SurfaceInitResponse>;
    this._initPromise = initPromise;

    initPromise
      .then((response) => {
        if (this._initPromise !== initPromise) return;
        if (this._aborted) {
          void callSurface((s) => s.remove({ surfaceId: response.surfaceId }));
          return;
        }

        this._surfaceId = response.surfaceId;

        if (this._userHidden) {
          this._applySurfaceHidden();
        }

        if (this._pendingSrc != null) {
          const pending = this._pendingSrc;
          this._pendingSrc = null;
          const sid = this._surfaceId;
          if (sid != null) {
            void callSurface((s) => s.navigate({ surfaceId: sid, url: pending }));
          }
        }

        this._syncCtrl = new OverlaySyncController(this, (rect) => {
          const sid = this._surfaceId;
          if (sid == null) return;

          const isZero = rect.width === 0 && rect.height === 0;
          if (isZero) {
            if (!this._syncHidden) {
              this._syncHidden = true;
              this._applySurfaceHidden();
            }
            return;
          }
          if (this._syncHidden) {
            this._syncHidden = false;
            this._applySurfaceHidden();
          }

          void callSurface((s) => s.resize({
            surfaceId: sid, x: rect.x, y: rect.y, w: rect.width, h: rect.height,
          }));
        });
        this._syncCtrl.start();
      })
      .catch(() => {})
      .finally(() => {
        if (this._initPromise === initPromise) {
          this._initPromise = null;
        }
      });
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("bunite-webview", BuniteWebviewElement);

  const raiseAll = () => { void callSurface((s) => s.bringAllVisiblesToFront()); };
  document.addEventListener("pointerdown", raiseAll, true);

  document.addEventListener("dragstart", () => {
    void callSurface((s) => s.setAllPassthrough({ passthrough: true }));
  }, true);
  document.addEventListener("dragend", () => {
    void callSurface((s) => s.setAllPassthrough({ passthrough: false }));
    raiseAll();
  }, true);
}
