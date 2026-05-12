import { describe, test, expect } from "bun:test";

// Importing bunite-core/view from Bun (no `window`) must not throw — host-side metadata extraction depends on it.

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
