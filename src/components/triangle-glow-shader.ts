/**
 * Matrix rain that reveals a triangle.
 *
 * Nothing is ever drawn for the triangle — no fill, no outline, no glow. It
 * exists only as a signed distance field doing two things:
 *
 *   - it OCCLUDES the rain, so no glyph is drawn inside it and the shape is
 *     negative space, a void the rain cannot enter;
 *   - it brightens what approaches it, so glyphs warm as they near the surface
 *     and blow out to white on contact.
 *
 * Every attempt to help the silhouette along was removed for reading as the
 * triangle being drawn on top of the rain rather than found by it: a
 * brightness floor inside (a static block of lit glyphs), an interior bloom
 * (hazed it into a blob), and a halo on the edge, both wide-soft and
 * thin-tight (an outline by any other name).
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

  // The triangle OCCLUDES the rain. No glyph is ever drawn inside it, so the
  // shape is negative space — a clean void the rain cannot enter — rather than
  // a region of differently-lit glyphs.
  float inside = 1.0 - smoothstep(-1.0 * u_dpr, 1.0 * u_dpr, triDist);
  float outside = 1.0 - inside;

  // Proximity, measured only outside (max with 0). Two falloffs, because one
  // cannot do both jobs: a single wide one brightens a large soft region and
  // never produces an edge, a single tight one switches on at the boundary
  // with no build-up. Wide = the approach, tight = the arrival.
  float rim = exp(-max(triDist, 0.0) / max(radius * 0.22, 1e-4));
  float contact = exp(-max(triDist, 0.0) / max(radius * 0.06, 1e-4));

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

  // Multiplied by outside, so the interior contributes nothing at all — not
  // dimmer glyphs, none. The ambient term is deliberately high: when the shape
  // is negative space the surrounding rain is the only thing defining it, and
  // at a dim 0.32 the void had nothing to be a void IN and simply vanished.
  float gain = (1.30 + rim * 5.50 + contact * 6.00 + pointer * 0.45) * outside * density;

  vec3 hot = vec3(0.55, 1.00, 0.62);
  vec3 faint = vec3(0.28, 0.40, 0.31);
  vec3 rain = mask * trail * gain * amount * mix(faint, hot, clamp(rim + contact, 0.0, 1.0));

  // Glyphs at the surface blow out to white — the moment of contact, and what
  // makes the edge legible as each one arrives at it. Keyed on contact and
  // not rim, so the whiteout is a thin band at the boundary instead of a
  // broad pale wash over everything near it.
  rain += vec3(1.0) * mask * smoothstep(1.2, 4.0, trail) * contact * outside * amount * density * 1.3;

  // Failure recolours the same rain rather than adding a second language.
  if (u_error > 0.001) {
    float lum = max(max(rain.r, rain.g), rain.b);
    rain = mix(rain, vec3(1.0, 0.16, 0.14) * lum, u_error * 0.9);
  }

  float ink = clamp(max(max(rain.r, rain.g), rain.b), 0.0, 1.0);

  vec3 color;
  if (u_dark > 0.5) {
    color = rain;
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
