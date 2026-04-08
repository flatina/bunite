// Preload runtime — built once at package build time, injected into every appres:// page.
// The config variables (__buniteWebviewId, __buniteRpcSocketPort, __buniteSecretKeyBase64)
// are injected by inline.ts as a small preamble before this script.

declare const __buniteWebviewId: number;
declare const __buniteRpcSocketPort: number;
declare const __buniteSecretKeyBase64: string;

const RPC_FRAME_VERSION = 1;
const RPC_IV_LENGTH = 12;

// --- Crypto key (lazy) ---

const getCryptoKey = (() => {
  let keyPromise: Promise<CryptoKey>;
  return () => {
    if (!keyPromise) {
      const raw = Uint8Array.from(atob(__buniteSecretKeyBase64), c => c.charCodeAt(0));
      keyPromise = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    }
    return keyPromise;
  };
})();

async function buniteEncrypt(data: Uint8Array): Promise<Uint8Array> {
  const key = await getCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(RPC_IV_LENGTH));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data as unknown as ArrayBuffer));
  const frame = new Uint8Array(1 + iv.length + encrypted.length);
  frame[0] = RPC_FRAME_VERSION;
  frame.set(iv, 1);
  frame.set(encrypted, 1 + iv.length);
  return frame;
}

async function buniteDecrypt(frame: Uint8Array): Promise<Uint8Array> {
  if (frame.length < 1 + RPC_IV_LENGTH + 16) {
    throw new Error("Invalid bunite RPC frame.");
  }
  if (frame[0] !== RPC_FRAME_VERSION) {
    throw new Error("Unsupported bunite RPC frame version.");
  }
  const key = await getCryptoKey();
  const iv = frame.slice(1, 1 + RPC_IV_LENGTH);
  const encrypted = frame.slice(1 + RPC_IV_LENGTH);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted));
}

// --- Minimal msgpack encoder/decoder ---

function mpEncode(val: unknown): Uint8Array {
  const parts: number[] = [];

  function w(v: unknown): void {
    if (v === null || v === undefined) {
      parts.push(0xc0);
    } else if (v === true) {
      parts.push(0xc3);
    } else if (v === false) {
      parts.push(0xc2);
    } else if (typeof v === "number") {
      if (Number.isInteger(v) && v >= 0 && v < 128) {
        parts.push(v);
      } else if (Number.isInteger(v) && v >= -32 && v < 0) {
        parts.push(v & 0xff);
      } else if (Number.isInteger(v) && v >= 0 && v <= 0xffff) {
        parts.push(0xcd, (v >> 8) & 0xff, v & 0xff);
      } else if (Number.isInteger(v) && v >= 0 && v <= 0xffffffff) {
        parts.push(0xce, (v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
      } else {
        const b = new ArrayBuffer(9);
        const dv = new DataView(b);
        dv.setUint8(0, 0xcb);
        dv.setFloat64(1, v);
        for (let i = 0; i < 9; i++) parts.push(dv.getUint8(i));
      }
    } else if (typeof v === "string") {
      const bytes = new TextEncoder().encode(v);
      if (bytes.length < 32) parts.push(0xa0 | bytes.length);
      else if (bytes.length < 256) parts.push(0xd9, bytes.length);
      else if (bytes.length < 65536) parts.push(0xda, (bytes.length >> 8) & 0xff, bytes.length & 0xff);
      else parts.push(0xdb, (bytes.length >> 24) & 0xff, (bytes.length >> 16) & 0xff, (bytes.length >> 8) & 0xff, bytes.length & 0xff);
      for (let i = 0; i < bytes.length; i++) parts.push(bytes[i]);
    } else if (Array.isArray(v)) {
      if (v.length < 16) parts.push(0x90 | v.length);
      else if (v.length < 65536) parts.push(0xdc, (v.length >> 8) & 0xff, v.length & 0xff);
      else parts.push(0xdd, (v.length >> 24) & 0xff, (v.length >> 16) & 0xff, (v.length >> 8) & 0xff, v.length & 0xff);
      v.forEach(w);
    } else if (typeof v === "object") {
      const keys = Object.keys(v as Record<string, unknown>);
      if (keys.length < 16) parts.push(0x80 | keys.length);
      else if (keys.length < 65536) parts.push(0xde, (keys.length >> 8) & 0xff, keys.length & 0xff);
      else parts.push(0xdf, (keys.length >> 24) & 0xff, (keys.length >> 16) & 0xff, (keys.length >> 8) & 0xff, keys.length & 0xff);
      for (const k of keys) { w(k); w((v as Record<string, unknown>)[k]); }
    }
  }

  w(val);
  return new Uint8Array(parts);
}

function mpDecode(buf: Uint8Array): unknown {
  let pos = 0;

  function r(): unknown {
    const b = buf[pos++];
    if (b <= 0x7f) return b;
    if (b >= 0xe0) return b - 256;
    if (b === 0xc0) return null;
    if (b === 0xc2) return false;
    if (b === 0xc3) return true;
    if (b === 0xcc) return buf[pos++];
    if (b === 0xcd) { const v = (buf[pos] << 8) | buf[pos + 1]; pos += 2; return v; }
    if (b === 0xce) { const v = ((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0; pos += 4; return v; }
    if (b === 0xcb) { const dv = new DataView(buf.buffer, buf.byteOffset + pos, 8); pos += 8; return dv.getFloat64(0); }
    if (b === 0xd0) { const v = buf[pos++]; return v > 127 ? v - 256 : v; }
    if (b === 0xd1) { const v = (buf[pos] << 8) | buf[pos + 1]; pos += 2; return v > 32767 ? v - 65536 : v; }
    if (b === 0xd2) { const v = (buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]; pos += 4; return v; }
    // fixstr
    if ((b & 0xe0) === 0xa0) { const len = b & 0x1f; const s = new TextDecoder().decode(buf.subarray(pos, pos + len)); pos += len; return s; }
    if (b === 0xd9) { const len = buf[pos++]; const s = new TextDecoder().decode(buf.subarray(pos, pos + len)); pos += len; return s; }
    if (b === 0xda) { const len = (buf[pos] << 8) | buf[pos + 1]; pos += 2; const s = new TextDecoder().decode(buf.subarray(pos, pos + len)); pos += len; return s; }
    if (b === 0xdb) { const len = ((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0; pos += 4; const s = new TextDecoder().decode(buf.subarray(pos, pos + len)); pos += len; return s; }
    // fixarray
    if ((b & 0xf0) === 0x90) { const len = b & 0x0f; const arr: unknown[] = []; for (let i = 0; i < len; i++) arr.push(r()); return arr; }
    if (b === 0xdc) { const len = (buf[pos] << 8) | buf[pos + 1]; pos += 2; const arr: unknown[] = []; for (let i = 0; i < len; i++) arr.push(r()); return arr; }
    if (b === 0xdd) { const len = ((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0; pos += 4; const arr: unknown[] = []; for (let i = 0; i < len; i++) arr.push(r()); return arr; }
    // fixmap
    if ((b & 0xf0) === 0x80) { const len = b & 0x0f; const obj: Record<string, unknown> = {}; for (let i = 0; i < len; i++) { obj[r() as string] = r(); } return obj; }
    if (b === 0xde) { const len = (buf[pos] << 8) | buf[pos + 1]; pos += 2; const obj: Record<string, unknown> = {}; for (let i = 0; i < len; i++) { obj[r() as string] = r(); } return obj; }
    if (b === 0xdf) { const len = ((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0; pos += 4; const obj: Record<string, unknown> = {}; for (let i = 0; i < len; i++) { obj[r() as string] = r(); } return obj; }
    // bin8, bin16
    if (b === 0xc4) { const len = buf[pos++]; const bin = buf.slice(pos, pos + len); pos += len; return bin; }
    if (b === 0xc5) { const len = (buf[pos] << 8) | buf[pos + 1]; pos += 2; const bin = buf.slice(pos, pos + len); pos += len; return bin; }
    return undefined;
  }

  return r();
}

// --- Expose globals ---

const w = window as any;
w.__bunite ??= {};
w.__buniteWebviewId = __buniteWebviewId;
w.__buniteRpcSocketPort = __buniteRpcSocketPort;
w.__bunite_encrypt = buniteEncrypt;
w.__bunite_decrypt = buniteDecrypt;

// --- bunite.invoke: global IPC ---

w.bunite = w.__bunite;
w.bunite.invoke = (() => {
  let socket: WebSocket | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timeout: ReturnType<typeof setTimeout> }>();

  function ensureSocket(): WebSocket {
    // Reuse socket opened by BuniteView if available
    const existing = w.__bunite?._socket;
    if (existing && existing.readyState <= WebSocket.OPEN && existing !== socket) {
      socket = existing;
      attachListener(existing);
      return existing;
    }
    if (socket && socket.readyState <= WebSocket.OPEN) return socket;
    socket = new WebSocket(
      `ws://localhost:${__buniteRpcSocketPort}/socket?webviewId=${__buniteWebviewId}`
    );
    socket.binaryType = "arraybuffer";
    w.__bunite._socket = socket;
    attachListener(socket);
    return socket;
  }

  function attachListener(ws: WebSocket) {
    ws.addEventListener("message", async (event) => {
      try {
        const decrypted = await buniteDecrypt(new Uint8Array(event.data as ArrayBuffer));
        const packet = mpDecode(decrypted) as any;
        if (packet?.type === "response" && packet.scope === "global") {
          const p = pending.get(packet.id);
          if (p) {
            pending.delete(packet.id);
            clearTimeout(p.timeout);
            packet.success ? p.resolve(packet.payload) : p.reject(new Error(packet.error || "Unknown error"));
          }
        }
      } catch { /* ignore malformed frames */ }
    });
  }

  return (method: string, params?: unknown) =>
    new Promise((resolve, reject) => {
      const ws = ensureSocket();
      const id = nextId++;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`bunite.invoke timed out: ${method}`));
      }, 15000);
      pending.set(id, { resolve, reject, timeout });

      const packet = { type: "request", id, method, params: params ?? null, scope: "global" };
      const doSend = async () => {
        const encrypted = await buniteEncrypt(mpEncode(packet));
        ws.send(encrypted.buffer as ArrayBuffer);
      };

      if (ws.readyState === WebSocket.OPEN) {
        doSend();
      } else {
        ws.addEventListener("open", () => doSend(), { once: true });
      }
    });
})();
