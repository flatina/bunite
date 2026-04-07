window.addEventListener("DOMContentLoaded", () => {
  const marker = document.createElement("p");
  marker.id = "bunite-preload-marker";
  marker.textContent = `Preload ready for webview ${String(window.__buniteWebviewId ?? "unknown")}.`;
  document.body.appendChild(marker);
});
