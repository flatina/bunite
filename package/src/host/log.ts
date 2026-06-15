export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const levels: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

function initialLevel(): LogLevel {
  const v = typeof process !== "undefined" ? process.env?.BUNITE_LOG_LEVEL : undefined;
  return v === "debug" || v === "info" || v === "warn" || v === "error" || v === "silent"
    ? v
    : "warn";
}

let currentLevel: LogLevel = initialLevel();

function shouldLog(level: LogLevel): boolean {
  return levels[level] >= levels[currentLevel];
}

export function logLevelToInt(level: LogLevel): number {
  return levels[level];
}

export const log = {
  setLevel(level: LogLevel) {
    currentLevel = level;
  },
  getLevel(): LogLevel {
    return currentLevel;
  },
  debug(...args: unknown[]) {
    if (shouldLog("debug")) console.debug("[bunite]", ...args);
  },
  info(...args: unknown[]) {
    if (shouldLog("info")) console.info("[bunite]", ...args);
  },
  warn(...args: unknown[]) {
    if (shouldLog("warn")) console.warn("[bunite]", ...args);
  },
  error(...args: unknown[]) {
    if (shouldLog("error")) console.error("[bunite]", ...args);
  },
};
