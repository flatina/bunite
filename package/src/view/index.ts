export { registerBuniteWebviewPolyfill } from "../shared/webviewPolyfill";

export * from "../shared/rpc/index";
export { Stream } from "../shared/rpc/server";

import { registerBuniteWebviewPolyfill as _register } from "../shared/webviewPolyfill";
_register();
