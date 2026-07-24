export type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "dropcel:theme";

/**
 * Forces `color-scheme` on the root element so index.css's `light-dark()`
 * tokens resolve to one branch regardless of the OS preference. "system"
 * removes the override — the base `color-scheme: light dark` on `:root`
 * (in index.css) then follows the OS/webview preference, same as before
 * this setting existed.
 */
export function applyTheme(theme: Theme): void {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

/** Best-effort — a user with storage disabled just sees the OS theme until
 * the real setting loads from the database. */
export function cacheTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage unavailable — not fatal */
  }
}

function readCachedTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* storage unavailable */
  }
  return "system";
}

/** Called once, synchronously, before first paint (see main.tsx) — applies
 * the last-known theme instantly so there's no flash before the database
 * setting loads. */
export function applyCachedThemeSync(): void {
  applyTheme(readCachedTheme());
}
