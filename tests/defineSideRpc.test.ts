import { describe, test, expect } from "bun:test";
import { createRpc, defineBunRpc, defineWebviewRpc, type RpcPacket, type RpcSchema, type RpcTransport } from "../package/src/shared/rpc";

function createLoopbackPair(): { left: RpcTransport; right: RpcTransport } {
  let leftHandler: ((p: RpcPacket) => void) | undefined;
  let rightHandler: ((p: RpcPacket) => void) | undefined;
  // Swallow async handlePacket rejections — server throws would fail the test runner instead of timing out.
  return {
    left: {
      send: (packet) => {
        Promise.resolve().then(() => rightHandler?.(packet)).catch(() => {});
      },
      registerHandler: (h) => { leftHandler = h; },
      unregisterHandler: () => { leftHandler = undefined; }
    },
    right: {
      send: (packet) => {
        Promise.resolve().then(() => leftHandler?.(packet)).catch(() => {});
      },
      registerHandler: (h) => { rightHandler = h; },
      unregisterHandler: () => { rightHandler = undefined; }
    }
  };
}

type DemoSchema = {
  bun: RpcSchema<{
    requests: {
      echo: { params: { msg: string }; response: string };
      add: { params: { a: number; b: number }; response: number };
    };
  }>;
  webview: RpcSchema;
};

describe("defineBunRpc / defineWebviewRpc — request handler forms", () => {
  test("object-form handler dispatches per-method", async () => {
    const { left, right } = createLoopbackPair();

    const server = defineBunRpc<DemoSchema>({
      handlers: {
        requests: {
          echo: ({ msg }) => msg.toUpperCase(),
          add: ({ a, b }) => a + b,
        }
      }
    });
    server.setTransport(right);

    const client = createRpc();
    client.setTransport(left);

    expect(await client.request("echo", { msg: "hi" })).toBe("HI");
    expect(await client.request("add", { a: 2, b: 3 })).toBe(5);
  });

  test("function-form handler receives method name and dispatches", async () => {
    const { left, right } = createLoopbackPair();

    const dispatch = ((method: string, params: any) => {
      if (method === "echo") return (params as { msg: string }).msg.toUpperCase();
      if (method === "add") return (params as { a: number; b: number }).a + (params as { a: number; b: number }).b;
      throw new Error(`unknown method ${method}`);
    }) as never;

    const server = defineBunRpc<DemoSchema>({
      handlers: { requests: dispatch }
    });
    server.setTransport(right);

    const client = createRpc();
    client.setTransport(left);

    expect(await client.request("echo", { msg: "hi" })).toBe("HI");
    expect(await client.request("add", { a: 10, b: 20 })).toBe(30);
  });

  test("object-form `_` fallback still works for unknown methods", async () => {
    const { left, right } = createLoopbackPair();

    const seen: Array<{ method: string; params: unknown }> = [];
    const server = defineBunRpc<DemoSchema>({
      handlers: {
        requests: {
          echo: ({ msg }) => msg.toUpperCase(),
          _: ((method: keyof DemoSchema["bun"]["requests"], params: unknown) => {
            seen.push({ method: String(method), params });
            return "fallback";
          }) as never,
        }
      }
    });
    server.setTransport(right);

    const client = createRpc();
    client.setTransport(left);

    expect(await client.request("echo", { msg: "hi" })).toBe("HI");
    expect(await client.request("add", { a: 1, b: 2 })).toBe("fallback");
    expect(seen).toEqual([{ method: "add", params: { a: 1, b: 2 } }]);
  });

  test("requests handler omitted — client request rejects (no silent success)", async () => {
    const { left, right } = createLoopbackPair();

    // No handlers.requests — server has nothing to dispatch incoming requests to.
    const server = defineBunRpc<DemoSchema>({ maxRequestTime: 100, handlers: {} });
    server.setTransport(right);

    const client = createRpc({ maxRequestTime: 100 });
    client.setTransport(left);

    await expect(client.request("echo", { msg: "x" })).rejects.toThrow();
  });

  test("defineWebviewRpc — function-form handler also works", async () => {
    const { left, right } = createLoopbackPair();

    type ServerSchema = {
      bun: RpcSchema;
      webview: RpcSchema<{
        requests: { greet: { params: { name: string }; response: string } };
      }>;
    };

    const dispatch = ((method: string, params: any) => {
      if (method === "greet") return `hello ${(params as { name: string }).name}`;
      throw new Error(`unknown method ${method}`);
    }) as never;

    const server = defineWebviewRpc<ServerSchema>({
      handlers: { requests: dispatch }
    });
    server.setTransport(right);

    const client = createRpc();
    client.setTransport(left);

    expect(await client.request("greet", { name: "world" })).toBe("hello world");
  });

});
