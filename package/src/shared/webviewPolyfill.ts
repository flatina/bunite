/**
 * <bunite-webview> iframe polyfill — registered automatically via the
 * bunite-dev vite plugin when the native bunite runtime is not available.
 *
 * In desktop CEF the native element is already registered by the preload
 * runtime, so this module does nothing.
 */

if (
  typeof customElements !== "undefined" &&
  !customElements.get("bunite-webview")
) {
  class BuniteWebviewPolyfill extends HTMLElement {
    static observedAttributes = ["src"];

    private _iframe: HTMLIFrameElement | null = null;

    connectedCallback() {
      if (this._iframe) return;

      const iframe = document.createElement("iframe");
      iframe.style.cssText = "display:block;width:100%;height:100%;border:0;background:inherit;";
      const src = this.getAttribute("src");
      if (src) {
        iframe.src = src;
      }

      iframe.addEventListener("load", () => {
        let url = iframe.src;
        try {
          url = iframe.contentWindow?.location.href ?? url;
        } catch {}

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
      if (name === "src" && this._iframe) {
        this._iframe.src = newValue ?? "";
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

  customElements.define("bunite-webview", BuniteWebviewPolyfill);
}
