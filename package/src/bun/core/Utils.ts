import { log } from "../../shared/log";
import { buniteEventEmitter } from "../events/eventEmitter";
import {
  cancelBrowserMessageBoxRequest,
  ensureNativeRuntime,
  getNativeLibrary,
  requestBrowserMessageBox,
  showNativeMessageBox
} from "../proc/native";

export type MessageBoxOptions = {
  type?: "none" | "info" | "warning" | "error" | "question";
  title?: string;
  message?: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
};

export type MessageBoxResponse = {
  response: number;
};

export async function showMessageBox(
  options: MessageBoxOptions = {}
): Promise<MessageBoxResponse> {
  ensureNativeRuntime();

  if (!getNativeLibrary()) {
    log.warn(
      "Utils.showMessageBox() requires the native runtime. Returning a stub response."
    );
    return {
      response: options.cancelId ?? options.defaultId ?? 0
    };
  }

  const requestId = requestBrowserMessageBox(options);
  if (requestId > 0) {
const response = await new Promise<number>((resolve) => {
      const fallbackResponse = options.cancelId ?? options.defaultId ?? 0;
      const handleResponse = (event: unknown) => {
        const data = (event as { data?: { requestId?: number; response?: number } }).data;
        if (!data || data.requestId !== requestId) {
          return;
        }

        clearTimeout(timeoutId);
        buniteEventEmitter.off("message-box-response", handleResponse);
        resolve(
          typeof data.response === "number" && data.response >= 0
            ? data.response
            : fallbackResponse
        );
      };

      const timeoutId = setTimeout(() => {
        buniteEventEmitter.off("message-box-response", handleResponse);
        cancelBrowserMessageBoxRequest(requestId);
        resolve(fallbackResponse);
      }, 15_000);

      buniteEventEmitter.on("message-box-response", handleResponse);
    });

    return { response };
  }

  return {
    response: showNativeMessageBox(options)
  };
}
