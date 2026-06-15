export const OS = process.platform;
export const ARCH = process.arch;

export const PLATFORM_TAG = OS === "win32" ? "win" : OS === "darwin" ? "mac" : OS;

export const NATIVE_LIB_EXT = OS === "win32" ? ".dll" : OS === "darwin" ? ".dylib" : ".so";
