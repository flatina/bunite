// Iframe fallback for web (no-op if native already registered). HTMLElement deref'd lazily so module is import-safe in Node/Bun.

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

    private applySandbox(iframe: HTMLIFrameElement) {
      if (this.hasAttribute("unsandboxed")) {
        iframe.removeAttribute("sandbox");
        return;
      }
      const override = this.getAttribute("sandbox");
      iframe.setAttribute("sandbox", override ?? DEFAULT_SANDBOX);
    }

    private dispatchBlocked(url: string) {
      this.dispatchEvent(new CustomEvent("did-fail-load", { detail: { url, reason: "blocked-scheme" } }));
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
        this.dispatchEvent(new CustomEvent("did-navigate", { detail: { url } }));
      });

      this._iframe = iframe;
      this.appendChild(iframe);
    }

    disconnectedCallback() {
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
  }

  cachedClass = BuniteWebviewPolyfill;
  return cachedClass;
}

/**
 * Register the `<bunite-webview>` iframe polyfill. No-op in non-browser
 * environments and when the native CEF preload has already registered the element.
 * Auto-called when importing `bunite-core/view`; call directly only if you
 * import a sub-path that does not pull in the view entry.
 *
 * Defaults (web fallback only — native paths bypass these):
 * - `sandbox="allow-scripts allow-forms allow-popups"` (popup-escape stays opt-in).
 * - `referrerpolicy="no-referrer"`.
 * - `javascript:` / `data:` / `vbscript:` / `file:` / `about:` schemes blocked
 *   (with WHATWG URL-style normalization to defeat embedded-control bypass);
 *   navigation attempt dispatches `did-fail-load` with `detail.reason === "blocked-scheme"`.
 *
 * Opt-out attributes on `<bunite-webview>` (observed — mutations re-apply):
 * - `sandbox="..."` — override the default sandbox token string verbatim.
 * - `unsandboxed` — remove the sandbox attribute entirely (trusted-content escape hatch).
 */
export function registerBuniteWebviewPolyfill() {
  if (typeof customElements === "undefined") return;
  if (customElements.get("bunite-webview")) return;
  customElements.define("bunite-webview", definePolyfillClass());
}
