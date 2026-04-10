// <bunite-webview> custom element — registered in every appres:// page via preload.

declare const bunite: {
  invoke: (method: string, params?: unknown) => Promise<any>;
  on: (channel: string, handler: (data: any) => void) => (() => void);
  off: (channel: string, handler: (data: any) => void) => void;
};

// --- OverlaySyncController ---
// Tracks element bounds and notifies when they change.
// Uses ResizeObserver for size changes and rAF polling for position changes.
// Dirty-flag coalescing ensures at most one IPC per animation frame.

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

  constructor() {
    super();
    // NOTE: Custom element spec forbids setting attributes in constructor.
  }

  connectedCallback() {
    this._aborted = false;
    this._syncHidden = false;
    this._userHidden = false;
    this._unsubNavigate = bunite.on("__bunite:webview.didNavigate", (data: any) => {
      if (data?.surfaceId === this._surfaceId) {
        this.dispatchEvent(new CustomEvent("did-navigate", { detail: { url: data.url } }));
      }
    });
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
    this._layoutObserver?.disconnect();
    this._layoutObserver = null;
    this._syncCtrl?.stop();
    this._syncCtrl = null;

    if (this._surfaceId != null) {
      const id = this._surfaceId;
      this._surfaceId = null;
      bunite.invoke("__bunite:surface.remove", { surfaceId: id }).catch(() => {});
    } else if (this._initPromise) {
      this._initPromise
        .then((r) => {
          bunite.invoke("__bunite:surface.remove", { surfaceId: r.surfaceId }).catch(() => {});
        })
        .catch(() => {});
    }
    this._initPromise = null;
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null) {
    if (name !== "src") return;
    if (this._surfaceId != null) {
      bunite.invoke("__bunite:webview.navigate", {
        surfaceId: this._surfaceId,
        url: newValue || ""
      }).catch(() => {});
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
    if (this._surfaceId != null)
      bunite.invoke("__bunite:webview.goBack", { surfaceId: this._surfaceId }).catch(() => {});
  }

  reload() {
    if (this._surfaceId != null)
      bunite.invoke("__bunite:webview.reload", { surfaceId: this._surfaceId }).catch(() => {});
  }

  navigate(url: string) {
    this.setAttribute("src", url);
  }

  private _applySurfaceHidden() {
    if (this._surfaceId == null) return;
    bunite.invoke("__bunite:surface.setHidden", {
      surfaceId: this._surfaceId,
      hidden: this._userHidden || this._syncHidden
    }).catch(() => {});
  }

  private initSurface() {
    if (this._surfaceId != null || this._initPromise != null) return;

    const dpr = window.devicePixelRatio || 1;
    const r = this.getBoundingClientRect();
    const src = this._pendingSrc || this.getAttribute("src") || "";
    this._pendingSrc = null;

    const initPromise = bunite.invoke("__bunite:surface.init", {
      src,
      x: Math.round(r.x * dpr),
      y: Math.round(r.y * dpr),
      width: Math.round(r.width * dpr),
      height: Math.round(r.height * dpr),
      hidden: this._userHidden
    }) as Promise<SurfaceInitResponse>;
    this._initPromise = initPromise;

    initPromise
      .then((response) => {
        if (this._initPromise !== initPromise) return;
        if (this._aborted) {
          bunite.invoke("__bunite:surface.remove", { surfaceId: response.surfaceId }).catch(() => {});
          return;
        }

        this._surfaceId = response.surfaceId;

        // Apply hidden state that was set during init
        if (this._userHidden) {
          this._applySurfaceHidden();
        }

        // Apply src that was set before init completed
        if (this._pendingSrc != null) {
          const pending = this._pendingSrc;
          this._pendingSrc = null;
          bunite.invoke("__bunite:webview.navigate", {
            surfaceId: this._surfaceId,
            url: pending
          }).catch(() => {});
        }

        this._syncCtrl = new OverlaySyncController(this, (rect) => {
          if (this._surfaceId == null) return;

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

          bunite.invoke("__bunite:surface.resize", {
            surfaceId: this._surfaceId,
            x: rect.x,
            y: rect.y,
            w: rect.width,
            h: rect.height
          }).catch(() => {});
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

  // When the host page gains focus (click on non-surface area), the host BrowserView
  // HWND comes to front and covers surface child HWNDs. Re-raise surfaces on focus.
  const raiseAll = () => bunite.invoke("__bunite:surface.bringAllVisiblesToFront").catch(() => {});
  document.addEventListener("pointerdown", raiseAll, true);

  // During host-page drag (e.g. dockview tab drag), send surfaces behind host
  // via Z-order swap so OLE DragDrop reaches the host's IDropTarget.
  document.addEventListener("dragstart", () => {
    bunite.invoke("__bunite:surface.setAllPassthrough", { passthrough: true }).catch(() => {});
  }, true);
  document.addEventListener("dragend", () => {
    bunite.invoke("__bunite:surface.setAllPassthrough", { passthrough: false }).catch(() => {});
    raiseAll();
  }, true);
}
