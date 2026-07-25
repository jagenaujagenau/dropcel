/**
 * Maps a project's framework to its accent custom property.
 *
 * The colours themselves live in index.css as `--fw-*` (and are contrast-
 * checked there by src/lib/contrast.test.ts); this only resolves the name, so
 * a card can hand the accent to CSS and let `color-mix()` derive the tint,
 * the chip and the title from one value.
 */

/** Kept in lockstep with the `--fw-*` tokens in index.css. */
const ACCENTS = new Set([
  "nextjs",
  "react",
  "vue",
  "nuxt",
  "svelte",
  "astro",
  "remix",
  "vite",
  "hono",
  "express",
  "static",
  "unknown",
]);

/**
 * `framework` is typed as Framework at the call site, but it arrives from
 * SQLite and a row written by an older build can hold anything — an unknown
 * value must fall back rather than resolve to `var(--fw-)`, which is not a
 * parse error and would silently render the accent as nothing at all.
 */
export function frameworkAccent(framework: string): string {
  return `var(--fw-${key(framework)})`;
}

/**
 * The chip gradient behind the (white) framework logo, from the brand's own
 * hue. Separate from the accent because the accent flips with the theme for
 * text contrast, while a plate carrying a white mark must stay dark in both.
 */
export function frameworkChip(framework: string): string {
  const k = key(framework);
  return `linear-gradient(145deg, var(--fwc-${k}-a), var(--fwc-${k}-b))`;
}

function key(framework: string): string {
  return ACCENTS.has(framework) ? framework : "unknown";
}
