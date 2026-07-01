import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { CloseInfo } from "../rpc/peer";
import type { BytesPipe } from "../rpc/transport";

const VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 1 + IV_LENGTH;

// node:crypto AES-256-GCM. wire layout matches WebCrypto's: version | iv(12) | ciphertext | authTag(16).
export async function createEncryptedPipe(base: BytesPipe, rawKey: Uint8Array): Promise<BytesPipe> {
  let downstream: ((bytes: Uint8Array) => void) | undefined;
  let closed = false;
  let onCloseHandler: ((info?: CloseInfo) => void) | undefined;
  // Report close (so the Connection tears down) for both a base disconnect and a
  // local crypto/frame failure, then close the base transport.
  const closeOnce = (info?: CloseInfo) => {
    if (closed) return;
    closed = true;
    onCloseHandler?.(info);
    base.close();
  };
  base.onClose?.((info) => closeOnce(info));

  base.setReceive((frame) => {
    if (closed) return;
    if (frame.length < HEADER_LENGTH + TAG_LENGTH || frame[0] !== VERSION) {
      closeOnce();
      return;
    }
    try {
      const iv = frame.subarray(1, HEADER_LENGTH);
      const body = frame.subarray(HEADER_LENGTH);
      const ciphertext = body.subarray(0, body.length - TAG_LENGTH);
      const authTag = body.subarray(body.length - TAG_LENGTH);
      const decipher = createDecipheriv("aes-256-gcm", rawKey, iv);
      decipher.setAuthTag(authTag);
      const head = decipher.update(ciphertext);
      const tail = decipher.final();
      const plaintext = tail.length === 0 ? head : Buffer.concat([head, tail]);
      // Normalize Buffer → plain Uint8Array so downstream prototype checks (msgpackr fast paths,
      // structured clone, etc.) see the same type as the WebCrypto path.
      downstream?.(new Uint8Array(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength));
    } catch {
      closeOnce();
    }
  });

  return {
    send(bytes) {
      if (closed) return;
      try {
        const iv = randomBytes(IV_LENGTH);
        const cipher = createCipheriv("aes-256-gcm", rawKey, iv);
        const head = cipher.update(bytes);
        const tail = cipher.final();
        const authTag = cipher.getAuthTag();
        const out = new Uint8Array(HEADER_LENGTH + head.length + tail.length + authTag.length);
        out[0] = VERSION;
        out.set(iv, 1);
        out.set(head, HEADER_LENGTH);
        if (tail.length > 0) out.set(tail, HEADER_LENGTH + head.length);
        out.set(authTag, HEADER_LENGTH + head.length + tail.length);
        base.send(out);
      } catch {
        closeOnce();
      }
    },
    setReceive(handler) {
      downstream = handler;
    },
    onClose(h) {
      onCloseHandler = h;
    },
    close() {
      closeOnce();
    },
  };
}
