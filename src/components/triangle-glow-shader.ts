/**
 * Matrix rain contained by a triangle.
 *
 * Nothing is ever drawn for the triangle itself — no fill, no outline, no
 * glow. It exists only as a signed distance field doing two things:
 *
 *   - it CONTAINS the bright rain. Inside the shape the field runs at several
 *     times the exterior gain, so the triangle is the brightest thing on the
 *     screen and reads as a lit vessel the rain is falling through;
 *   - the same rain continues outside at a dim ambient level, which is what
 *     the interior is bright AGAINST. Without it the lit shape floats with
 *     nothing to be brighter than.
 *
 * The edge is found, not drawn: glyphs blow out to white as they pass the
 * inner surface, so the silhouette is legible as each one arrives at it rather
 * than being outlined. A halo on the boundary, wide-soft or thin-tight, was
 * tried and removed — it is an outline by any other name.
 *
 * The rain is adapted from IRCSS/MatrixVFX (MIT) —
 * https://github.com/IRCSS/MatrixVFX, Assets/Shaders/Resources/
 * ScreenSpaceMatrixEffect.shader. Two things are taken from it:
 *
 *   - per-column seeding, offset = sin(col * 15.0) and
 *     speed = cos(col * 3.0) * .15 + .35, which decorrelates the columns from
 *     one cheap trig pair instead of a hash;
 *   - the trail, colour / (y * 20.0) with y = fract(yUp + t * speed + offset).
 *     The 1/y pole is the whole look: it blows out to a white-hot head at the
 *     wrap and decays into a long dim tail. An exponential trail gives an
 *     evenly-lit worm with no head at all.
 *
 * Not taken: the original samples a shipped 16x16 font texture and a
 * white-noise texture animated by a compute shader. Here the atlas is drawn at
 * runtime (matrix-glyphs.ts) and the per-cell glyph choice is a hash on
 * (cell, quantised time) — no second texture, no compute pass.
 *
 * Under prefers-reduced-motion the clock freezes to a constant: the rain still
 * renders, so the shape still reads, but nothing flashes — which for a
 * full-field strobing effect is the difference between a signal and a hazard.
 */
export const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

uniform vec2  u_resolution;  // drawing-buffer size, px
uniform float u_time;        // seconds
uniform vec4  u_tri;         // centerX, centerY, circumradius, halfSide (px)
uniform vec3  u_pointer;     // xy px (drawing-buffer space), z = strength 0..1
uniform float u_dark;        // 1 = dark theme, 0 = light
uniform float u_dpr;
uniform float u_motion;      // 0 when prefers-reduced-motion
uniform float u_error;       // 0..1 failure envelope (red shift + tearing)
uniform float u_rain;        // 0 = calm idle rain, 1 = full drop-state rain
uniform sampler2D u_glyphs;  // runtime-drawn katakana atlas, red channel

out vec4 fragColor;

// Must match matrix-glyphs.ts.
const float ATLAS_GRID = 8.0;
const float ATLAS_CELLS = 64.0;

// Dave Hoskins' hash.
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float hash11(float n) {
  return fract(sin(n * 127.1) * 43758.5453123);
}

float cross2(vec2 a, vec2 b) {
  return a.x * b.y - a.y * b.x;
}

float segmentDistance(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

/** Signed distance to the triangle: negative inside. Winding-independent, so
 * the vertex order can't silently invert the reveal. */
float triangleSdf(vec2 p, vec2 a, vec2 b, vec2 c) {
  float d = min(segmentDistance(p, a, b), min(segmentDistance(p, b, c), segmentDistance(p, c, a)));
  float w1 = cross2(b - a, p - a);
  float w2 = cross2(c - b, p - b);
  float w3 = cross2(a - c, p - c);
  bool inside = (w1 >= 0.0 && w2 >= 0.0 && w3 >= 0.0) || (w1 <= 0.0 && w2 <= 0.0 && w3 <= 0.0);
  return inside ? -d : d;
}

void main() {
  vec2 p = gl_FragCoord.xy;
  // Top-left origin, so the geometry math reads the same as the CSS layout.
  p.y = u_resolution.y - p.y;

  float radius = u_tri.z;
  vec2 top   = vec2(u_tri.x, u_tri.y - radius);
  vec2 left  = vec2(u_tri.x - u_tri.w, u_tri.y + radius * 0.5);
  vec2 right = vec2(u_tri.x + u_tri.w, u_tri.y + radius * 0.5);

  float mt = mix(4.2, u_time, u_motion);

  // Horizontal tear bands on failure, applied before the SDF so the rain and
  // the revealed shape tear together as one broken image.
  if (u_error > 0.001) {
    float band = floor(p.y / max(radius * 0.10, 1.0));
    float tear = hash11(band * 3.7 + floor(mt * 13.0) * 1.9) - 0.5;
    // Only a minority of bands displace; a uniform jitter just looks like noise.
    p.x += (abs(tear) > 0.34 ? tear : 0.0) * radius * 0.22 * u_error;
  }

  float triDist = triangleSdf(p, top, left, right);

  // The triangle CONTAINS the bright rain. Antialiased over a pixel so the
  // walls stay clean at any size.
  float inside = 1.0 - smoothstep(-1.0 * u_dpr, 1.0 * u_dpr, triDist);
  float outside = 1.0 - inside;

  // Two falloffs off the boundary, one per side, because one cannot do both
  // jobs: a single wide one lights a large soft region and never produces an
  // edge, a single tight one switches on at the boundary with no build-up.
  //
  //   wall    — inward from the surface. Lifts the interior hottest right at
  //             the walls, which is what makes the shape a vessel rather than
  //             a lit rectangle happening to be triangular.
  //   contact — a thin band on both sides, the moment of arrival at the edge.
  float wall = exp(-max(-triDist, 0.0) / max(radius * 0.30, 1e-4)) * inside;
  float contact = exp(-abs(triDist) / max(radius * 0.05, 1e-4));
  // The exterior's own gradient toward the shape: the ambient rain leans
  // slightly warmer as it nears the vessel, so the two fields are one field.
  float approach = exp(-max(triDist, 0.0) / max(radius * 0.20, 1e-4)) * outside;

  // ---- rain ----
  // Cells are a fixed CSS size, so glyphs stay legible at any triangle size.
  float cellH = 17.0 * u_dpr;
  vec2 cell = vec2(cellH * 0.72, cellH);
  vec2 id = floor(p / cell);

  float col = id.x;
  float offset = sin(col * 15.0);
  float speed = cos(col * 3.0) * 0.15 + 0.35;

  // Not every column runs. Thinning by column rather than by shortening every
  // tail keeps the streams that do fall looking like full streams — dropping
  // the tail length instead thins all of them at once and the rain stops
  // reading as rain. The weight is fixed per column, so streams hold their
  // positions instead of flickering on and off.
  float density = smoothstep(0.30, 0.62, hash11(col * 7.31));

  // Bottom-up Y so heads travel downward, matching the reference's
  // bottom-origin fragCoord (this shader works top-left).
  float yUp = 1.0 - p.y / max(u_resolution.y, 1.0);
  float y = fract(yUp + mt * speed + offset);
  // The 1/y pole is clamped: unclamped it reaches the thousands and, once
  // premultiplied by alpha, blooms into an opaque white block.
  //
  // The divisor sets how much of each column is lit — the reference's 20.0
  // leaves only the few cells behind each head burning, which is right for a
  // sparse screensaver but leaves too little rain to carve a silhouette out
  // of. This keeps tails long enough to read as a curtain while the per-column
  // thinning above does the actual density reduction.
  float trail = min(1.0 / (y * 10.0), 6.0);

  // The cell's glyph is re-rolled on a quantised clock, so each cell holds a
  // character for a beat instead of dissolving every frame.
  float flick = floor(mt * 7.0);
  float pick = floor(hash21(id + flick * 13.7) * ATLAS_CELLS);
  vec2 atlasCell = vec2(mod(pick, ATLAS_GRID), floor(pick / ATLAS_GRID));
  // Inset within the cell so neighbouring glyphs never bleed into each other.
  vec2 within = fract(p / cell) * 0.86 + 0.07;
  float mask = texture(u_glyphs, (atlasCell + within) / ATLAS_GRID).r;

  float pointerDist = length(p - u_pointer.xy);
  float pointer = exp(-pointerDist / max(radius * 0.5, 1e-4)) * u_pointer.z;

  // Calm at rest, full while a drop is in flight.
  float amount = mix(0.55, 1.0, u_rain);

  // The interior runs at roughly eight times the exterior, which is what makes
  // the triangle the brightest thing on the screen. The exterior term is not
  // zero on purpose: the ambient rain is what the interior is bright AGAINST,
  // and dropping it entirely leaves a lit shape floating on nothing.
  float interior = inside * (4.20 + wall * 2.60 + pointer * 0.50);
  float exterior = outside * (0.55 + approach * 0.55 + pointer * 0.20);
  float gain = (interior + exterior) * density;

  vec3 hot = vec3(0.55, 1.00, 0.62);
  vec3 faint = vec3(0.28, 0.40, 0.31);
  // Hot inside, faint outside, with the exterior warming as it approaches —
  // the colour carries the same containment the gain does.
  float warmth = clamp(inside + approach * 0.45 + contact * 0.6, 0.0, 1.0);
  vec3 rain = mask * trail * gain * amount * mix(faint, hot, warmth);

  // Heads inside the vessel blow out to white. This is the top end of the
  // whole image — nothing outside ever reaches it — and it is also what makes
  // the walls legible, as each head crossing the surface flares against them.
  rain += vec3(1.0) * mask * smoothstep(1.2, 4.0, trail)
        * (inside * 0.85 + contact * 0.9) * amount * density * 1.3;

  // Failure recolours the same rain rather than adding a second language.
  if (u_error > 0.001) {
    float lum = max(max(rain.r, rain.g), rain.b);
    rain = mix(rain, vec3(1.0, 0.16, 0.14) * lum, u_error * 0.9);
  }

  float ink = clamp(max(max(rain.r, rain.g), rain.b), 0.0, 1.0);

  vec3 color;
  if (u_dark > 0.5) {
    // Tone-mapped, not clipped. At interior gain most cells land well past 1
    // and a hard clip turns the whole triangle into a flat white block —
    // maximum output, no depth, no glyphs. Reinhard keeps the tails green and
    // reserves white for the heads, so the shape stays the brightest thing on
    // the screen AND stays legible as rain.
    color = rain / (1.0 + rain * 0.45);
  } else {
    // On a light background the rain has to be ink, not light: emissive green
    // over white is invisible. Same signal, opposite polarity.
    color = mix(vec3(0.62, 0.80, 0.66), vec3(0.02, 0.30, 0.10), clamp(ink, 0.0, 1.0));
    if (u_error > 0.001) {
      color = mix(color, vec3(0.55, 0.05, 0.05), u_error * 0.9);
    }
  }

  float alpha = clamp(ink * 1.5, 0.0, 1.0);
  // Premultiplied: the canvas composites over the app's own background.
  fragColor = vec4(color * alpha, alpha);
}
`;

/** Fullscreen coverage from gl_VertexID alone — no vertex buffer, no attributes. */
export const VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;
void main() {
  vec2 p = vec2(
    gl_VertexID == 2 ? 3.0 : -1.0,
    gl_VertexID == 0 ? -3.0 : 1.0
  );
  gl_Position = vec4(p, 0.0, 1.0);
}
`;
