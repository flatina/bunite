import type { BytesPipe } from "./transport";

const VERSION = 1;
const IV_LENGTH = 12;
const HEADER_LENGTH = 1 + IV_LENGTH;

function toBufferSource(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

async function importAesGcmKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toBufferSource(rawKey), "AES-GCM", false, ["encrypt", "decrypt"]);
}

// WebCrypto AES-256-GCM (browser / preload). For Bun-side use `host/encryptedPipe.ts` (node:crypto).
export async function createEncryptedPipe(base: BytesPipe, rawKey: Uint8Array): Promise<BytesPipe> {
  const key = await importAesGcmKey(rawKey);
  let downstream: ((bytes: Uint8Array) => void) | undefined;
  let sendChain: Promise<void> = Promise.resolve();
  let recvChain: Promise<void> = Promise.resolve();
  let closed = false;
  const closeOnce = () => { if (!closed) { closed = true; base.close(); } };

  base.setReceive((frame) => {
    if (closed) return;
    if (frame.length < HEADER_LENGTH || frame[0] !== VERSION) {
      closeOnce();
      return;
    }
    const iv = toBufferSource(frame.subarray(1, HEADER_LENGTH));
    const payload = toBufferSource(frame.subarray(HEADER_LENGTH));
    recvChain = recvChain.then(async () => {
      if (closed) return;
      try {
        const buf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, payload);
        downstream?.(new Uint8Array(buf));
      } catch {
        closeOnce();
      }
    });
  });

  return {
    send(bytes) {
      if (closed) return;
      const payload = toBufferSource(bytes);
      sendChain = sendChain.then(async () => {
        if (closed) return;
        try {
          const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
          const ivBuf = toBufferSource(iv);
          const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: ivBuf }, key, payload);
          const encArr = new Uint8Array(encrypted);
          const out = new Uint8Array(HEADER_LENGTH + encArr.byteLength);
          out[0] = VERSION;
          out.set(iv, 1);
          out.set(encArr, HEADER_LENGTH);
          base.send(out);
        } catch {
          closeOnce();
        }
      });
    },
    setReceive(handler) {
      downstream = handler;
    },
    close() {
      closeOnce();
    },
  };
}

