import { describe, test, expect } from "bun:test";

// Bun runs JS without a `window` global. Importing bunite-core/view in this
// environment must not throw, so host-side metadata extraction (e.g. flmux
// loading extension renderer bundles) works without a browser-shimmed runtime.

describe("bunite-core/view module load", () => {
  test("import succeeds in a non-browser environment", async () => {
    const mod = await import("../package/src/view/index.ts");
    expect(typeof mod.BuniteView).toBe("function");
    expect(typeof mod.defineWebviewRpc).toBe("function");
    expect(typeof mod.registerBuniteWebviewPolyfill).toBe("function");
    expect(typeof mod.createRpcTransportDemuxer).toBe("function");
    expect(typeof mod.createWebSocketTransport).toBe("function");
  });

  test("registerBuniteWebviewPolyfill is a no-op when customElements is undefined", async () => {
    const { registerBuniteWebviewPolyfill } = await import("../package/src/view/index.ts");
    expect(() => registerBuniteWebviewPolyfill()).not.toThrow();
  });
});
