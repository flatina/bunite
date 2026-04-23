import { describe, test, expect } from "bun:test";
import { createRPC, type RPCPacket, type RPCSchema } from "../package/src/shared/rpc";
import { createTransportDemuxer } from "../package/src/shared/rpcDemux";
import { createWebSocketTransport } from "../package/src/shared/webSocketTransport";

class FakeSocket {
  peer?: FakeSocket;
  received: Uint8Array[] = [];
  onBytes?: (bytes: Uint8Array) => void;

  send(data: Uint8Array | ArrayBuffer) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    this.received.push(bytes);
    this.peer?.onBytes?.(bytes);
  }
}

function pair() {
  const a = new FakeSocket();
  const b = new FakeSocket();
  a.peer = b;
  b.peer = a;
  return { a, b };
}

type PingSchema = RPCSchema<{
  requests: { ping: { params: { value: string }; response: { pong: string } } };
  messages: { notify: { msg: string } };
}>;

describe("createWebSocketTransport", () => {
  test("round-trip — encoded bytes flow through and decode back to packet", () => {
    const ws = new FakeSocket();
    const pipe = createWebSocketTransport(ws);

    const received: RPCPacket[] = [];
    pipe.transport.registerHandler!((p) => received.push(p));

    pipe.transport.send!({ type: "message", id: "notify", payload: { msg: "hi" } });
    expect(ws.received).toHaveLength(1);

    pipe.receive(ws.received[0]!);
    expect(received).toEqual([{ type: "message", id: "notify", payload: { msg: "hi" } }]);
  });

  test("end-to-end with createRPC — request/response over two paired pipes", async () => {
    const { a, b } = pair();
    const pipeA = createWebSocketTransport(a);
    const pipeB = createWebSocketTransport(b);
    a.onBytes = (bytes) => pipeA.receive(bytes);
    b.onBytes = (bytes) => pipeB.receive(bytes);

    createRPC<PingSchema>({
      transport: pipeB.transport,
      requestHandler: { ping: ({ value }) => ({ pong: value.toUpperCase() }) }
    });
    const client = createRPC<PingSchema>({ transport: pipeA.transport });

    expect(await client.request("ping", { value: "hi" })).toEqual({ pong: "HI" });
  });

  test("composes with createTransportDemuxer — multi-channel over one ws pair", async () => {
    const { a, b } = pair();
    const pipeA = createWebSocketTransport(a);
    const pipeB = createWebSocketTransport(b);
    a.onBytes = (bytes) => pipeA.receive(bytes);
    b.onBytes = (bytes) => pipeB.receive(bytes);

    const demuxA = createTransportDemuxer(pipeA.transport);
    const demuxB = createTransportDemuxer(pipeB.transport);

    const chatServer = createRPC<PingSchema>({ requestHandler: { ping: ({ value }) => ({ pong: `chat:${value}` }) } });
    const statusServer = createRPC<PingSchema>({ requestHandler: { ping: ({ value }) => ({ pong: `status:${value}` }) } });
    demuxB.channel("chat").bindTo(chatServer);
    demuxB.channel("status").bindTo(statusServer);

    const chat = createRPC<PingSchema>();
    const status = createRPC<PingSchema>();
    await Promise.all([
      demuxA.channel("chat").bindTo(chat),
      demuxA.channel("status").bindTo(status),
    ]);

    const [r1, r2] = await Promise.all([
      chat.request("ping", { value: "x" }),
      status.request("ping", { value: "y" })
    ]);
    expect(r1).toEqual({ pong: "chat:x" });
    expect(r2).toEqual({ pong: "status:y" });
  });
});
