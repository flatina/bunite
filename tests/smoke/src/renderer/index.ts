import { BuniteView } from "bunite-core/view";

type SmokeSchema = {
  bun: {
    requests: {
      ping: { params: { value: string }; response: { pong: string } };
    };
    messages: {};
  };
  webview: { requests: {}; messages: {} };
};

const rpc = BuniteView.defineRPC<SmokeSchema>({ handlers: { requests: {} } });

function setStatus(text: string) {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

try {
  const { pong } = await rpc.request("ping", { value: "smoke" });
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
