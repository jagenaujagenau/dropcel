import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio, type Oklch } from "./contrast";

/**
 * The palette's accessibility, checked rather than assumed.
 *
 * These values are parsed out of `index.css` instead of duplicated here, so
 * the test fails when someone edits a colour rather than quietly measuring a
 * stale copy. OKLCH lightness is perceptual and doesn't map linearly to WCAG's
 * relative luminance, so "it looks dark enough" is not a substitute for
 * computing it — two adjacent steps on the brand scale genuinely land either
 * side of the 4.5:1 line.
 */

const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

function declarationOf(token: string): string {
  const decl = new RegExp(`--${token}:\\s*([^;]+);`).exec(css);
  if (!decl) throw new Error(`token --${token} not found in index.css`);
  return decl[1]!.trim();
}

/** `oklch(<l> <c> <h>)` → Oklch. `l` may be a percentage or a 0–1 number,
 * matching how the file is authored. */
function parseOklch(value: string): Oklch | null {
  const m = /oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)/.exec(value);
  if (!m) return null;
  const raw = m[1]!;
  return {
    l: raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw),
    c: Number(m[2]),
    h: Number(m[3]),
  };
}

/** Splits `light-dark(a, b)` at the top-level comma — the arguments are
 * themselves function calls, so a naive `split(",")` would cut inside them. */
function lightDarkArgs(value: string): [string, string] | null {
  const open = value.indexOf("light-dark(");
  if (open === -1) return null;
  let depth = 0;
  let split = -1;
  const start = open + "light-dark(".length;
  for (let i = start; i < value.length; i++) {
    const ch = value[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) return [value.slice(start, split), value.slice(split + 1, i)];
      depth--;
    } else if (ch === "," && depth === 0) split = i;
  }
  return null;
}

/**
 * Resolves a token to a concrete colour, following `var()` indirection and
 * picking the right side of `light-dark()`.
 *
 * The indirection is the whole reason this is needed: several semantic tokens
 * are `var(--vbg-…)` aliases, and one side of a `light-dark()` can be an alias
 * while the other is a literal. An earlier version of this parser silently
 * fell back to the light value whenever the dark side was a `var()` — it
 * reported a failure that wasn't real, which is exactly as bad as missing one
 * that is.
 */
function oklchFor(token: string, which: "light" | "dark", seen = new Set<string>()): Oklch {
  if (seen.has(token)) throw new Error(`circular token reference at --${token}`);
  seen.add(token);

  const value = declarationOf(token);
  const sides = lightDarkArgs(value);
  const side = (sides ? sides[which === "light" ? 0 : 1] : value).trim();

  const direct = parseOklch(side);
  if (direct) return direct;

  const ref = /var\(\s*--([\w-]+)\s*\)/.exec(side);
  if (ref) return oklchFor(ref[1]!, which, seen);

  throw new Error(`could not resolve --${token} (${which}): ${side}`);
}

const BACKGROUND = { light: { l: 1, c: 0, h: 0 }, dark: { l: 0, c: 0, h: 0 } };
// background-200: the slightly-tinted card surface, and the harder of the two
// backgrounds to sit on in light mode.
const SURFACE = { light: { l: 0.984, c: 0, h: 0 }, dark: { l: 0.027, c: 0, h: 0 } };

/**
 * Every token used for text. All of it renders at 11–13px, so WCAG's
 * normal-text bar (4.5:1) applies — not the 3:1 large-text exemption.
 */
const TEXT_TOKENS = [
  "vbg-gray-1000", // → --color-foreground
  "vbg-gray-900", // → --color-muted
  "vbg-text-faint", // → --color-faint
  "vbg-color-success",
  "vbg-color-warning",
  "vbg-color-error", // → --color-danger, used for error copy
];

/**
 * Framework accents. These are the highest-risk colours in the palette: each
 * is a saturated hue used for a project card's title, and picking twelve of
 * them by eye across two themes is exactly the situation where one quietly
 * lands at 3.5:1. The card tints its own background with the same accent, so
 * the real contrast is marginally lower than measured here — checking against
 * the untinted surface is the strict direction, which is the one to be wrong
 * in.
 */
const FRAMEWORK_TOKENS = [
  "fw-nextjs",
  "fw-react",
  "fw-vue",
  "fw-nuxt",
  "fw-svelte",
  "fw-astro",
  "fw-remix",
  "fw-vite",
  "fw-hono",
  "fw-express",
  "fw-static",
  "fw-unknown",
];

describe("palette contrast (WCAG AA, normal text)", () => {
  for (const token of TEXT_TOKENS) {
    for (const mode of ["light", "dark"] as const) {
      it(`${token} is readable on both backgrounds in ${mode} mode`, () => {
        const fg = oklchFor(token, mode);
        expect(contrastRatio(fg, BACKGROUND[mode])).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(fg, SURFACE[mode])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe("framework accents (WCAG AA, normal text)", () => {
  for (const token of FRAMEWORK_TOKENS) {
    for (const mode of ["light", "dark"] as const) {
      it(`${token} is readable on both backgrounds in ${mode} mode`, () => {
        const fg = oklchFor(token, mode);
        expect(contrastRatio(fg, BACKGROUND[mode])).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(fg, SURFACE[mode])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

/**
 * Chip gradients. The framework logo is knocked out to pure white on top of
 * these, so both stops have to stay dark enough to carry it. WCAG's bar for a
 * graphical object is 3:1, not the 4.5:1 used for text above.
 *
 * Both ends are checked, not an average: a gradient is only as readable as its
 * lightest point, and that is exactly the end a hand-picked brand hue drifts
 * past without anyone noticing.
 */
describe("framework chip gradients (WCAG non-text, white mark)", () => {
  const WHITE = { l: 1, c: 0, h: 0 };
  for (const token of FRAMEWORK_TOKENS) {
    const name = token.replace(/^fw-/, "");
    for (const stop of ["a", "b"] as const) {
      it(`--fwc-${name}-${stop} carries a white logo`, () => {
        // Not theme-dependent, so either side of light-dark() resolves the same.
        const bg = oklchFor(`fwc-${name}-${stop}`, "light");
        expect(contrastRatio(WHITE, bg)).toBeGreaterThanOrEqual(3);
      });
    }
  }
});

describe("contrastRatio", () => {
  it("matches known reference values", () => {
    const white = { l: 1, c: 0, h: 0 };
    const black = { l: 0, c: 0, h: 0 };
    expect(contrastRatio(white, black)).toBeCloseTo(21, 1);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
  });

  it("is order-independent", () => {
    const a = { l: 0.5, c: 0.1, h: 30 };
    const b = { l: 0.9, c: 0, h: 0 };
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });
});
