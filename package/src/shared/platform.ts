export const OS = process.platform;
export const ARCH = process.arch;

export const PLATFORM_TAG =
  OS === "win32" ? "win" : OS === "darwin" ? "darwin" : OS;

export const BIN_EXT = OS === "win32" ? ".exe" : "";
export const NATIVE_LIB_EXT =
  OS === "win32" ? ".dll" : OS === "darwin" ? ".dylib" : ".so";
