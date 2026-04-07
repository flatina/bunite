import { RPC_FRAME_VERSION, RPC_IV_LENGTH } from "../../shared/rpcWireConstants";

type BunitePreloadWindow = Window &
  typeof globalThis & {
    __bunite?: {
      receiveMessageFromBun?: (message: unknown) => void;
    };
    __buniteWebviewId?: number;
    __buniteRpcSocketPort?: number;
    __bunite_encrypt?: (data: Uint8Array) => Promise<Uint8Array>;
    __bunite_decrypt?: (data: Uint8Array) => Promise<Uint8Array>;
  };

function base64ToUint8Array(base64: string) {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function importAesKey(secretKeyBase64: string) {
  const keyData = base64ToUint8Array(secretKeyBase64);
  return crypto.subtle.importKey("raw", toArrayBuffer(keyData), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function installBunitePreloadGlobals(options: {
  webviewId: number;
  rpcSocketPort: number;
  secretKeyBase64: string;
}) {
  const buniteWindow = window as BunitePreloadWindow;
  const cryptoKey = await importAesKey(options.secretKeyBase64);

  const encrypt = async (data: Uint8Array) => {
    const iv = crypto.getRandomValues(new Uint8Array(RPC_IV_LENGTH));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, toArrayBuffer(data))
    );
    const frame = new Uint8Array(1 + iv.length + encrypted.length);
    frame[0] = RPC_FRAME_VERSION;
    frame.set(iv, 1);
    frame.set(encrypted, 1 + iv.length);
    return frame;
  };

  const decrypt = async (frame: Uint8Array) => {
    if (frame.length < 1 + RPC_IV_LENGTH + 16) {
      throw new Error("Invalid bunite RPC frame.");
    }
    if (frame[0] !== RPC_FRAME_VERSION) {
      throw new Error("Unsupported bunite RPC frame version.");
    }
    const iv = frame.slice(1, 1 + RPC_IV_LENGTH);
    const encrypted = frame.slice(1 + RPC_IV_LENGTH);

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      cryptoKey,
      toArrayBuffer(encrypted)
    );

    return new Uint8Array(decrypted);
  };

  buniteWindow.__bunite ??= {};
  buniteWindow.__buniteWebviewId = options.webviewId;
  buniteWindow.__buniteRpcSocketPort = options.rpcSocketPort;
  buniteWindow.__bunite_encrypt = encrypt;
  buniteWindow.__bunite_decrypt = decrypt;
}
