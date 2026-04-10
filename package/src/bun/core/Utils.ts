import { log } from "../../shared/log";
import { ensureNativeRuntime, showNativeMessageBox } from "../proc/native";
import { BrowserView } from "./BrowserView";
import { BrowserWindow, getLastFocusedWindowId } from "./BrowserWindow";

export type MessageBoxOptions = {
  windowId?: number;
  type?: "none" | "info" | "warning" | "error" | "question";
  title?: string;
  message?: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
  browser?: boolean;
};

export type MessageBoxResponse = {
  response: number;
};

// ---------------------------------------------------------------------------
// Pending request tracking
// ---------------------------------------------------------------------------

let nextRequestId = 1;

type PendingMessageBox = {
  viewId: number;
  fallbackResponse: number;
  resolve: (response: number) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

const pendingMessageBoxes = new Map<number, PendingMessageBox>();

export function handleMessageBoxResponse(requestId: number, response: number): boolean {
  const pending = pendingMessageBoxes.get(requestId);
  if (!pending) {
    return false;
  }
  clearTimeout(pending.timeoutId);
  pendingMessageBoxes.delete(requestId);
  pending.resolve(typeof response === "number" && response >= 0 ? response : pending.fallbackResponse);
  return true;
}

export function cancelPendingMessageBoxesForView(viewId: number): void {
  for (const [requestId, pending] of pendingMessageBoxes) {
    if (pending.viewId === viewId) {
      clearTimeout(pending.timeoutId);
      pendingMessageBoxes.delete(requestId);
      pending.resolve(pending.fallbackResponse);
    }
  }
}

// ---------------------------------------------------------------------------
// Preferred view selection
// ---------------------------------------------------------------------------

function getPreferredMessageBoxView(): BrowserView | null {
  const allViews = BrowserView.getAll();
  if (allViews.length === 0) {
    return null;
  }

  const focusedWindowId = getLastFocusedWindowId();
  if (focusedWindowId != null) {
    const view = allViews.find(v => v.windowId === focusedWindowId);
    if (view) return view;
  }

  const allWindows = BrowserWindow.getAll();
  for (const win of allWindows) {
    const view = allViews.find(v => v.windowId === win.id);
    if (view) return view;
  }

  return allViews[0] ?? null;
}

// ---------------------------------------------------------------------------
// Dialog script builder
// ---------------------------------------------------------------------------

function escapeJs(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function buildBrowserMessageBoxScript(
  requestId: number,
  options: Required<Pick<MessageBoxOptions, "type">> & MessageBoxOptions
): string {
  const buttons = options.buttons && options.buttons.length > 0 ? options.buttons : ["OK"];
  const defaultId = Math.max(0, Math.min(options.defaultId ?? 0, buttons.length - 1));
  const cancelId = options.cancelId != null && options.cancelId >= 0
    ? Math.max(0, Math.min(options.cancelId, buttons.length - 1))
    : options.cancelId ?? -1;

  const buttonsJson = JSON.stringify(buttons);

  return `(() => {
  const spec = {
    requestId: ${requestId},
    type: "${escapeJs(options.type ?? "info")}",
    title: "${escapeJs(options.title ?? "")}",
    message: "${escapeJs(options.message ?? "")}",
    detail: "${escapeJs(options.detail ?? "")}",
    buttons: ${buttonsJson},
    defaultId: ${defaultId},
    cancelId: ${cancelId}
  };
  const rootId = \`__bunite_message_box_\${spec.requestId}\`;
  if (document.getElementById(rootId)) {
    return;
  }

  const submit = (response) => {
    void (typeof bunite !== "undefined" && bunite.invoke
      ? bunite.invoke("__bunite:messageBoxResponse", { requestId: spec.requestId, response }).catch(() => {})
      : Promise.resolve());
  };

  const mount = () => {
    const host = document.body ?? document.documentElement;
    if (!host) {
      return;
    }

    const overlay = document.createElement("div");
    overlay.id = rootId;
    overlay.dataset.buniteMessageBox = "true";
    overlay.dataset.buniteMessageBoxRequestId = String(spec.requestId);
    overlay.tabIndex = -1;
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "padding:24px",
      "background:rgba(15,23,42,0.42)",
      "backdrop-filter:blur(6px)",
      "z-index:2147483647",
      "font-family:Segoe UI, Arial, sans-serif"
    ].join(";");

    const panel = document.createElement("div");
    panel.style.cssText = [
      "width:min(480px, calc(100vw - 48px))",
      "border-radius:16px",
      "border:1px solid rgba(15,23,42,0.10)",
      "background:#ffffff",
      "box-shadow:0 24px 80px rgba(15,23,42,0.28)",
      "padding:20px 20px 18px",
      "color:#0f172a"
    ].join(";");

    const accent = document.createElement("div");
    const accentColor =
      spec.type === "error" ? "#dc2626" :
      spec.type === "warning" ? "#d97706" :
      spec.type === "question" ? "#2563eb" :
      "#0f766e";
    accent.style.cssText = \`width:48px;height:4px;border-radius:999px;background:\${accentColor};margin-bottom:14px;\`;
    panel.appendChild(accent);

    if (spec.title) {
      const heading = document.createElement("h1");
      heading.textContent = spec.title;
      heading.style.cssText = "margin:0 0 8px;font-size:20px;line-height:1.25;font-weight:700;";
      panel.appendChild(heading);
    }

    if (spec.message) {
      const body = document.createElement("p");
      body.textContent = spec.message;
      body.style.cssText = "margin:0;font-size:14px;line-height:1.55;white-space:pre-wrap;";
      panel.appendChild(body);
    }

    if (spec.detail) {
      const detail = document.createElement("p");
      detail.textContent = spec.detail;
      detail.style.cssText = "margin:10px 0 0;font-size:12px;line-height:1.55;color:#475569;white-space:pre-wrap;";
      panel.appendChild(detail);
    }

    const buttonRow = document.createElement("div");
    buttonRow.style.cssText = "display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:18px;";
    spec.buttons.forEach((label, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.dataset.buniteMessageBoxButtonIndex = String(index);
      button.style.cssText =
        index === spec.defaultId
          ? "appearance:none;border:0;border-radius:999px;background:#111827;color:#ffffff;padding:10px 16px;font:600 13px Segoe UI, Arial, sans-serif;cursor:pointer;"
          : "appearance:none;border:1px solid rgba(15,23,42,0.14);border-radius:999px;background:#f8fafc;color:#0f172a;padding:10px 16px;font:600 13px Segoe UI, Arial, sans-serif;cursor:pointer;";
      button.addEventListener("click", () => {
        overlay.remove();
        submit(index);
      });
      buttonRow.appendChild(button);
    });
    panel.appendChild(buttonRow);
    overlay.appendChild(panel);
    host.appendChild(overlay);

    overlay.addEventListener("click", (event) => {
      if (event.target !== overlay) {
        return;
      }
      overlay.remove();
      submit(spec.cancelId >= 0 ? spec.cancelId : spec.defaultId);
    });

    overlay.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      overlay.remove();
      submit(spec.cancelId >= 0 ? spec.cancelId : spec.defaultId);
    });

    requestAnimationFrame(() => {
      overlay.focus();
      const defaultButton = overlay.querySelector(\`[data-bunite-message-box-button-index="\${spec.defaultId}"]\`);
      if (defaultButton instanceof HTMLButtonElement) {
        defaultButton.focus();
      }
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function showMessageBox(
  options: MessageBoxOptions = {}
): Promise<MessageBoxResponse> {
  ensureNativeRuntime();

  const windowId = options.windowId ?? 0;

  if (options.browser) {
    const view = getPreferredMessageBoxView();
    if (view) {
      const requestId = nextRequestId++;
      const fallbackResponse = options.cancelId ?? options.defaultId ?? 0;
      const script = buildBrowserMessageBoxScript(requestId, {
        type: options.type ?? "info",
        ...options
      });

      view.bringToFront();

      const response = await new Promise<number>((resolve) => {
        const timeoutId = setTimeout(() => {
          pendingMessageBoxes.delete(requestId);
          resolve(fallbackResponse);
        }, 15_000);

        pendingMessageBoxes.set(requestId, {
          viewId: view.id,
          fallbackResponse,
          resolve,
          timeoutId
        });

        view.executeJavaScript(script);
      });

      return { response };
    }
  }

  return { response: showNativeMessageBox(windowId, options) };
}

export function showMessageBoxSync(
  options: MessageBoxOptions = {}
): MessageBoxResponse {
  ensureNativeRuntime();
  return { response: showNativeMessageBox(options.windowId ?? 0, options) };
}
