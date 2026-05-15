import type { BytesPipe } from "./transport";

const VERSION = 1;
const IV_LENGTH = 12;
const HEADER_LENGTH = 1 + IV_LENGTH;

export function createEncryptedPipe(base: BytesPipe, key: CryptoKey): BytesPipe {
  let downstream: ((bytes: Uint8Array) => void) | undefined;
  let sendChain: Promise<void> = Promise.resolve();
  let recvChain: Promise<void> = Promise.resolve();

  base.setReceive((frame) => {
    if (frame.length < HEADER_LENGTH || frame[0] !== VERSION) {
      base.close();
      return;
    }
    const iv = frame.subarray(1, HEADER_LENGTH);
    const payload = frame.subarray(HEADER_LENGTH);
    recvChain = recvChain.then(async () => {
      try {
        const buf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as any }, key, payload as any);
        downstream?.(new Uint8Array(buf));
      } catch {
        base.close();
      }
    });
  });

  return {
    send(bytes) {
      sendChain = sendChain.then(async () => {
        try {
          const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
          const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as any }, key, bytes as any);
          const encArr = new Uint8Array(encrypted as ArrayBuffer);
          const out = new Uint8Array(HEADER_LENGTH + encArr.byteLength);
          out[0] = VERSION;
          out.set(iv, 1);
          out.set(encArr, HEADER_LENGTH);
          base.send(out);
        } catch {
          base.close();
        }
      });
    },
    setReceive(handler) {
      downstream = handler;
    },
    close() {
      base.close();
    },
  };
}

export async function importAesGcmKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", rawKey as any, "AES-GCM", false, ["encrypt", "decrypt"]);
}
