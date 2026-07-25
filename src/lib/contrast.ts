/**
 * OKLCH → sRGB → WCAG contrast.
 *
 * Exists so the palette's accessibility is a *checked* property rather than an
 * assumption. The app's colours are authored in OKLCH (Vercel's brand scale),
 * and OKLCH lightness is perceptual — it does not map linearly to the relative
 * luminance WCAG is defined in terms of. Two tokens one step apart on the
 * scale can land either side of the 4.5:1 line, so the only way to know is to
 * compute it. See `index.css.test.ts`.
 */

export interface Oklch {
  /** 0–1. */
  l: number;
  c: number;
  /** Degrees. */
  h: number;
}

/** Oklab → linear sRGB (Björn Ottosson's matrices), then gamma-encoded. */
export function oklchToSrgb({ l: L, c: C, h: hDeg }: Oklch): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  // Ottosson names these l'/m'/s' — the cube roots of the LMS cone
  // responses. Spelled out to keep the dangling-underscore lint rule intact.
  const lRoot = L + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = L - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = L - 0.0894841775 * a - 1.291485548 * b;
  const lc = lRoot ** 3;
  const mc = mRoot ** 3;
  const sc = sRoot ** 3;

  const r = 4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc;
  const g = -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc;
  const bl = -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc;

  const encode = (v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
  };
  return [encode(r), encode(g), encode(bl)];
}

/** WCAG 2.x relative luminance of a gamma-encoded sRGB triple. */
export function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, 1–21. Order-independent. */
export function contrastRatio(a: Oklch, b: Oklch): number {
  const [hi, lo] = [
    relativeLuminance(oklchToSrgb(a)),
    relativeLuminance(oklchToSrgb(b)),
  ].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
