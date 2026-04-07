import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { RPC_AUTH_TAG_LENGTH, RPC_FRAME_VERSION, RPC_IV_LENGTH } from "../../shared/rpcWireConstants";

function escapeRootForComparison(path: string) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function resolveViewsFile(viewsRoot: string, url: string) {
  const relativePath = url.replace(/^views:\/\//, "").replace(/^[\\/]+/, "");
  const normalizedRoot = resolve(viewsRoot);
  const candidate = resolve(normalizedRoot, relativePath.split("/").join(sep));
  const comparableRoot = escapeRootForComparison(normalizedRoot);
  const comparableCandidate = escapeRootForComparison(candidate);

  if (
    comparableCandidate !== comparableRoot &&
    !comparableCandidate.startsWith(`${comparableRoot}${sep}`)
  ) {
    throw new Error(`preload path escapes viewsRoot: ${url}`);
  }

  return candidate;
}

function readCustomPreload(preload: string | null, viewsRoot: string | null) {
  if (!preload) {
    return "";
  }

  try {
    const resolvedPath = preload.startsWith("views://")
      ? viewsRoot
        ? resolveViewsFile(viewsRoot, preload)
        : null
      : isAbsolute(preload)
        ? preload
        : resolve(preload);

    if (!resolvedPath) {
      console.warn(`[bunite] Cannot resolve preload without viewsRoot: ${preload}`);
      return "";
    }
    if (!existsSync(resolvedPath)) {
      console.warn(`[bunite] Preload file was not found: ${resolvedPath}`);
      return "";
    }

    return readFileSync(resolvedPath, "utf8");
  } catch (error) {
    console.warn("[bunite] Failed to resolve preload script.", error);
    return "";
  }
}

export function buildViewPreloadScript(options: {
  preload: string | null;
  viewsRoot: string | null;
  webviewId: number;
  rpcSocketPort: number;
  secretKey: Uint8Array;
}) {
  const secretKeyBase64 = Buffer.from(options.secretKey).toString("base64");
  const bootstrap = `
(() => {
  const buniteWindow = window;
  const base64ToUint8Array = (base64) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const getCryptoKey = (() => {
    let keyPromise;
    return () => {
      if (!keyPromise) {
        keyPromise = crypto.subtle.importKey(
          "raw",
          base64ToUint8Array(${JSON.stringify(secretKeyBase64)}),
          "AES-GCM",
          false,
          ["encrypt", "decrypt"]
        );
      }
      return keyPromise;
    };
  })();

  buniteWindow.__bunite ??= {};
  buniteWindow.__buniteWebviewId = ${options.webviewId};
  buniteWindow.__buniteRpcSocketPort = ${options.rpcSocketPort};
  buniteWindow.__bunite_encrypt = async (data) => {
    const cryptoKey = await getCryptoKey();
    const iv = crypto.getRandomValues(new Uint8Array(${RPC_IV_LENGTH}));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, data)
    );
    const frame = new Uint8Array(1 + iv.length + encrypted.length);
    frame[0] = ${RPC_FRAME_VERSION};
    frame.set(iv, 1);
    frame.set(encrypted, 1 + iv.length);
    return frame;
  };
  buniteWindow.__bunite_decrypt = async (frame) => {
    if (frame.length < 1 + ${RPC_IV_LENGTH} + ${RPC_AUTH_TAG_LENGTH}) {
      throw new Error("Invalid bunite RPC frame.");
    }
    if (frame[0] !== ${RPC_FRAME_VERSION}) {
      throw new Error("Unsupported bunite RPC frame version.");
    }
    const cryptoKey = await getCryptoKey();
    const iv = frame.slice(1, 1 + ${RPC_IV_LENGTH});
    const encrypted = frame.slice(1 + ${RPC_IV_LENGTH});
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      cryptoKey,
      encrypted
    );
    return new Uint8Array(decrypted);
  };
})();
`.trim();

  const customPreload = readCustomPreload(options.preload, options.viewsRoot).trim();
  return [bootstrap, customPreload].filter(Boolean).join("\n\n");
}
