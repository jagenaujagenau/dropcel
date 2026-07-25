/**
 * The glyph atlas for the Matrix rain, drawn at runtime with Canvas 2D.
 *
 * The technique this feeds (see `triangle-glow-shader.ts`) samples a grid of
 * glyphs from a texture. The reference implementation ships that texture as an
 * asset; generating it instead means no binary in the repo, no extra fetch on
 * a webview that may be offline, and glyphs that render with the platform's
 * own font at whatever DPR the display actually has.
 *
 * 8x8 = 64 cells and exactly 64 glyphs, so the shader's cell index maps to a
 * glyph one-to-one with no wasted texels and no modulo bias toward the glyphs
 * that happen to land early in the list.
 */

export const ATLAS_GRID = 8;
const CELL = 64;
export const ATLAS_SIZE = ATLAS_GRID * CELL; // 512

/**
 * Halfwidth katakana (U+FF66–U+FF9D) — the film's own alphabet, and halfwidth
 * forms sit on a narrow advance that suits a rain column. Padded to 64 with
 * digits, which is also what the original effect mixes in.
 */
const KATAKANA = Array.from({ length: 56 }, (_, i) => String.fromCharCode(0xff66 + i));
const DIGITS = "01234567".split("");
export const GLYPHS = [...KATAKANA, ...DIGITS];

/**
 * Renders the atlas: white glyphs on black, read from the red channel.
 * Returns null if a 2D context is unavailable, which is the caller's cue to
 * skip the rain rather than upload an empty texture.
 */
let cached: HTMLCanvasElement | null | undefined;

export function buildGlyphAtlas(): HTMLCanvasElement | null {
  // Drawn once per document. The atlas is 64 text fills into a 512x512 canvas
  // — cheap once, but it was being rebuilt every time the drop overlay
  // mounted, i.e. on every single drag-enter, on the main thread, at the exact
  // moment the user is dragging and the frame budget matters most.
  if (cached !== undefined) return cached;
  cached = render();
  return cached;
}

function render(): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // A CJK-capable stack first: the app's own Geist Mono has no katakana, so
  // asking for it alone would silently render 64 tofu boxes.
  ctx.font =
    `${Math.round(CELL * 0.74)}px "Hiragino Kaku Gothic ProN", "Yu Gothic", ` +
    `"Noto Sans JP", "MS Gothic", "Geist Mono", monospace`;

  for (let i = 0; i < ATLAS_GRID * ATLAS_GRID; i++) {
    const glyph = GLYPHS[i % GLYPHS.length]!;
    const cx = (i % ATLAS_GRID) * CELL + CELL / 2;
    const cy = Math.floor(i / ATLAS_GRID) * CELL + CELL / 2;
    ctx.fillText(glyph, cx, cy);
  }
  return canvas;
}
