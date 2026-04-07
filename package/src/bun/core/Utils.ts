import { ensureNativeRuntime, getNativeLibrary, showNativeMessageBox } from "../proc/native";

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
    console.warn(
      "[bunite] Utils.showMessageBox() requires the native runtime. Returning a stub response."
    );
    return {
      response: options.cancelId ?? options.defaultId ?? 0
    };
  }

  return {
    response: showNativeMessageBox(options)
  };
}
