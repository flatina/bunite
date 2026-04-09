// <bunite-webview> custom element — registered in every appres:// page via preload.

declare const bunite: { invoke: (method: string, params?: unknown) => Promise<any> };

const POLL_INTERVAL = 100;

// --- OverlaySyncController ---

class OverlaySyncController {
  private element: HTMLElement;
  private onBoundsChange: (rect: { x: number; y: number; width: number; height: number }) => void;
  private observer: ResizeObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastRect = { x: 0, y: 0, width: 0, height: 0 };
  private stopped = false;

  constructor(
    element: HTMLElement,
    onBoundsChange: (rect: { x: number; y: number; width: number; height: number }) => void
  ) {
    this.element = element;
    this.onBoundsChange = onBoundsChange;
  }

  start() {
    this.observer = new ResizeObserver(() => this.sync());
    this.observer.observe(this.element);
    this.poll();
  }

  stop() {
    this.stopped = true;
    this.observer?.disconnect();
    this.observer = null;
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  forceSync() {
    this.sync(true);
  }

  private poll() {
    if (this.stopped) return;
    this.sync();
    this.timer = setTimeout(() => this.poll(), POLL_INTERVAL);
  }

  private sync(force = false) {
    const dpr = window.devicePixelRatio || 1;
    const r = this.element.getBoundingClientRect();
    const rect = {
      x: Math.round(r.x * dpr),
      y: Math.round(r.y * dpr),
      width: Math.round(r.width * dpr),
      height: Math.round(r.height * dpr)
    };

    if (rect.width === 0 && rect.height === 0) return;

    if (
      !force &&
      rect.x === this.lastRect.x &&
      rect.y === this.lastRect.y &&
      rect.width === this.lastRect.width &&
      rect.height === this.lastRect.height
    ) {
      return;
    }

    this.lastRect = rect;
    this.onBoundsChange(rect);
  }
}

// --- BuniteWebviewElement ---

type SurfaceInitResponse = { surfaceId: number };

class BuniteWebviewElement extends HTMLElement {
  static observedAttributes = ["src"];

  private _surfaceId: number | null = null;
  private _syncCtrl: OverlaySyncController | null = null;
  private _initPromise: Promise<SurfaceInitResponse> | null = null;
  private _aborted = false;
  private _pendingSrc: string | null = null;

  constructor() {
    super();
    // NOTE: Custom element spec forbids setting attributes in constructor.
    // Default display is set in connectedCallback instead.
  }

  connectedCallback() {
    if (!this.style.display) {
      this.style.display = "inline-block";
    }
    this._aborted = false;
    requestAnimationFrame(() => {
      if (!this.isConnected || this._aborted) return;
      const src = this.getAttribute("src") || this._pendingSrc || "";
      if (src) {
        this.initSurface();
      }
      // If src is empty, initSurface will be called from attributeChangedCallback
    });
  }

  disconnectedCallback() {
    this._aborted = true;
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
      bunite.invoke("__bunite:surface.updateSrc", {
        surfaceId: this._surfaceId,
        src: newValue || ""
      }).catch(() => {});
    } else if (this._initPromise) {
      // Init in progress — queue for after completion
      this._pendingSrc = newValue || "";
    } else if (this.isConnected && !this._aborted && newValue) {
      // No init started yet (was waiting for src) — start now
      this.initSurface();
    }
  }

  setHidden(hidden: boolean) {
    if (this._surfaceId == null) return;
    bunite.invoke("__bunite:surface.setHidden", {
      surfaceId: this._surfaceId,
      hidden
    }).catch(() => {});
  }

  setPassthrough(passthrough: boolean) {
    this.style.pointerEvents = passthrough ? "none" : "";
  }

  private initSurface() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.getBoundingClientRect();
    const src = this._pendingSrc || this.getAttribute("src") || "";
    this._pendingSrc = null;

    this._initPromise = bunite.invoke("__bunite:surface.init", {
      src,
      x: Math.round(r.x * dpr),
      y: Math.round(r.y * dpr),
      width: Math.round(r.width * dpr),
      height: Math.round(r.height * dpr)
    }) as Promise<SurfaceInitResponse>;

    this._initPromise
      .then((response) => {
        if (this._aborted) {
          bunite.invoke("__bunite:surface.remove", { surfaceId: response.surfaceId }).catch(() => {});
          return;
        }

        this._surfaceId = response.surfaceId;

        // Apply src that was set before init completed
        if (this._pendingSrc != null) {
          const pending = this._pendingSrc;
          this._pendingSrc = null;
          bunite.invoke("__bunite:surface.updateSrc", {
            surfaceId: this._surfaceId,
            src: pending
          }).catch(() => {});
        }

        this._syncCtrl = new OverlaySyncController(this, (rect) => {
          if (this._surfaceId == null) return;
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
      .catch(() => {});
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("bunite-webview", BuniteWebviewElement);

  // When the host page gains focus (click on non-surface area), the host BrowserView
  // HWND comes to front and covers surface child HWNDs. Re-raise surfaces on focus.
  document.addEventListener("pointerdown", () => {
    bunite.invoke("__bunite:surface.bringAllToFront").catch(() => {});
  }, true);
}
