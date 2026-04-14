import { describe, test, expect } from "bun:test";
import { BrowserView } from "../../package/src/bun/core/BrowserView";
import { createWebRPCHandler, type WebRPCClient } from "../../package/src/shared/webRpcHandler";
import { defineBuniteRPC, type RPCSchema } from "../../package/src/shared/rpc";
import { encodeRPCPacket, decodeRPCPacket } from "../../package/src/shared/rpcWire";
import { pack, unpack } from "msgpackr";

type TestSchema = {
  bun: RPCSchema<{
    requests: {
      ping: { params: { value: string }; response: { pong: string } };
    };
  }>;
  webview: RPCSchema;
};

function createTestServer() {
  const config = {
    handlers: {
      requests: {
        ping: ({ value }: { value: string }) => ({ pong: value })
      }
    }
  } satisfies Parameters<typeof BrowserView.defineRPC<TestSchema>>[0];

  const webRpc = createWebRPCHandler<TestSchema>(config);
  return webRpc;
}

// Fake WebSocket that captures sent data
class FakeWebSocket {
  sent: Uint8Array[] = [];
  closed = false;

  send(data: Uint8Array | ArrayBuffer) {
    if (data instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(data));
    } else {
      this.sent.push(data);
    }
  }

  lastPacket() {
    const last = this.sent[this.sent.length - 1];
    return last ? decodeRPCPacket(last) : null;
  }

  allPackets() {
    return this.sent.map(d => decodeRPCPacket(d));
  }
}

describe("web RPC handler", () => {
  test("open → request/response", async () => {
    const handler = createTestServer();
    const ws = new FakeWebSocket();

    handler.open(ws);
    expect(handler.webClients.size).toBe(1);

    handler.message(ws, encodeRPCPacket({
      type: "request", id: 1, method: "ping", params: { value: "hello" }
    }));

    // handlePacket is async — wait for microtasks
    await new Promise(r => setTimeout(r, 10));

    const response = ws.lastPacket();
    expect(response).not.toBeNull();
    expect(response!.type).toBe("response");
    expect((response as any).success).toBe(true);
    expect((response as any).payload).toEqual({ pong: "hello" });
  });

  test("main → web push via broadcast", async () => {
    const handler = createTestServer();
    const ws = new FakeWebSocket();

    handler.open(ws);
    handler.broadcast("statusUpdate", { status: "ready" });

    const packet = ws.lastPacket();
    expect(packet).not.toBeNull();
    expect(packet!.type).toBe("message");
    expect((packet as any).id).toBe("statusUpdate");
    expect((packet as any).payload).toEqual({ status: "ready" });
  });

  test("close cleanup — client removed from webClients", () => {
    const handler = createTestServer();
    const ws = new FakeWebSocket();

    handler.open(ws);
    expect(handler.webClients.size).toBe(1);

    handler.close(ws);
    expect(handler.webClients.size).toBe(0);
  });

  test("broadcast after disconnect skips dead client", () => {
    const handler = createTestServer();
    const ws1 = new FakeWebSocket();
    const ws2 = new FakeWebSocket();

    handler.open(ws1);
    handler.open(ws2);
    expect(handler.webClients.size).toBe(2);

    handler.close(ws1);
    expect(handler.webClients.size).toBe(1);

    ws2.sent = []; // clear
    handler.broadcast("test", { data: 1 });

    // ws2 should receive, ws1 should not
    expect(ws2.sent.length).toBe(1);
    expect(ws1.sent.length).toBe(0); // was cleared before close, no new sends
  });

  test("malformed packet is ignored", () => {
    const handler = createTestServer();
    const ws = new FakeWebSocket();

    handler.open(ws);

    // Send garbage binary
    handler.message(ws, Buffer.from([0xff, 0xfe, 0x00]));
    expect(ws.sent.length).toBe(0); // no response for garbage

    // Send text (should be ignored)
    handler.message(ws, "not binary" as any);
    expect(ws.sent.length).toBe(0);
  });

  test("onWebClientConnected / onWebClientDisconnected callbacks", () => {
    const handler = createTestServer();
    const ws = new FakeWebSocket();

    const events: string[] = [];
    handler.onWebClientConnected = () => events.push("connected");
    handler.onWebClientDisconnected = () => events.push("disconnected");

    handler.open(ws);
    handler.close(ws);

    expect(events).toEqual(["connected", "disconnected"]);
  });

  test("disconnect callback fires after transport detach", () => {
    const handler = createTestServer();
    const ws = new FakeWebSocket();

    handler.open(ws);

    let sendWorkedInCallback = false;
    handler.onWebClientDisconnected = (client) => {
      // transport should be detached — send should throw or no-op
      try {
        client.rpc.send("test" as any, {});
        sendWorkedInCallback = true;
      } catch {
        sendWorkedInCallback = false;
      }
    };

    handler.close(ws);
    // After dispose(), transport.send is gone — rpc.send throws
    expect(sendWorkedInCallback).toBe(false);
  });

  test("multiple clients are independent", async () => {
    const handler = createTestServer();
    const ws1 = new FakeWebSocket();
    const ws2 = new FakeWebSocket();

    handler.open(ws1);
    handler.open(ws2);

    handler.message(ws1, encodeRPCPacket({
      type: "request", id: 1, method: "ping", params: { value: "from-1" }
    }));
    handler.message(ws2, encodeRPCPacket({
      type: "request", id: 1, method: "ping", params: { value: "from-2" }
    }));

    await new Promise(r => setTimeout(r, 10));

    const r1 = ws1.lastPacket() as any;
    const r2 = ws2.lastPacket() as any;

    expect(r1.payload).toEqual({ pong: "from-1" });
    expect(r2.payload).toEqual({ pong: "from-2" });
  });

  test("dispose rejects pending requests immediately", async () => {
    // Create a handler with a slow request
    const webRpc = createWebRPCHandler({
      handlers: {
        requests: {
          slow: async () => {
            await new Promise(r => setTimeout(r, 10000));
            return "done";
          }
        }
      }
    });

    const ws = new FakeWebSocket();
    webRpc.open(ws);

    // Get the client's RPC to issue a request from main→web
    // (simulate by calling dispose directly)
    const client = [...webRpc.webClients][0];
    const requestPromise = client.rpc.request("slow" as any);

    // Disconnect immediately
    webRpc.close(ws);

    // Should reject with "RPC disposed" instead of waiting for timeout
    await expect(requestPromise).rejects.toThrow("RPC disposed");
  });
});
