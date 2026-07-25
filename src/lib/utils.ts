import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** `now` is injectable so callers driving a shared clock (`useNow`) render a
 * consistent frame, and so tests don't depend on wall time. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const s = (now - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * How long an in-flight deployment has been running, counting up from its
 * start. Sub-second is floored to `0s` rather than shown in milliseconds:
 * this string is re-rendered every second, and a ticking `847ms` would be a
 * lie about the resolution we actually have.
 */
export function formatElapsed(startedAtIso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(startedAtIso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * `/Users/ada/Vercel` → `~/Vercel`, for showing a path in a space where the
 * home prefix is noise — it is the same for every path the user will ever see
 * here, so it carries no information and costs the part that does.
 *
 * Pattern-matched rather than asking the OS for the home directory: this is
 * display-only, it must not be async, and a path that does not match is simply
 * shown whole. Covers macOS (`/Users/x`), Linux (`/home/x`) and Windows
 * (`C:\Users\x`).
 */
export function tildeAbbreviate(path: string): string {
  if (!path) return "";
  return path.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/, "~");
}
