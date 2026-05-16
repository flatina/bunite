import { bootstrap } from "bunite-core/rpc/renderer";
import { apiCap } from "../schema";

function setStatus(text: string) {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

try {
  const api = await bootstrap(apiCap);
  const { pong } = await api.ping({ value: "smoke" });
  setStatus(`rpc ok: ${pong}`);

  // Attempt blocked navigation (should be rejected by rules)
  location.href = "appres://app.internal/smoke/nav-blocked.html";

  // Then navigate to allowed page
  setTimeout(() => {
    location.href = "appres://app.internal/smoke/nav-ok.html";
  }, 100);
} catch (e) {
  setStatus(`error: ${e}`);
}
