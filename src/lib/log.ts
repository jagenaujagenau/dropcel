import { invoke } from "@tauri-apps/api/core";

/**
 * App logging: mirrors to the devtools console AND the persistent log file
 * (app-data/logs/dropcel.log, written by Rust). Fire-and-forget — logging
 * must never affect the flow it observes.
 */

type Level = "info" | "warn" | "error";

function emit(level: Level, scope: string, message: string) {
  // eslint-disable-next-line no-console
  console[level](`[${scope}] ${message}`);
  invoke("log_event", { level, scope, message }).catch(() => {});
}

export const log = {
  info: (scope: string, message: string) => emit("info", scope, message),
  warn: (scope: string, message: string) => emit("warn", scope, message),
  error: (scope: string, message: string) => emit("error", scope, message),
};

export const describeError = (e: unknown): string =>
  e instanceof Error
    ? e.message
    : typeof e === "object" && e !== null && "message" in e
      ? String((e as { message: unknown }).message)
      : String(e);

/** Uncaught errors and unhandled rejections land in the log file too. */
export function installGlobalErrorLogging() {
  window.addEventListener("error", (e) => {
    log.error("uncaught", `${e.message} (${e.filename}:${e.lineno})`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    log.error("unhandled-rejection", describeError(e.reason));
  });
}

export const getLogPath = () => invoke<string>("get_log_path");
