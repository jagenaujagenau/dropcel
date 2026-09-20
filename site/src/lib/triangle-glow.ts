import { buildGlyphAtlas } from "./matrix-glyphs";
import { FRAGMENT_SHADER, VERTEX_SHADER } from "./triangle-glow-shader";

/**
 * The app's TriangleGlow, minus React.
 *
 * Same shader, same atlas, same envelopes — this is a port of
 * src/components/TriangleGlow.tsx to a plain mount function, because the page
 * ships no framework runtime. What is left out is what the site has no use for:
 * the failure envelope (nothing can be refused here — `u_error` is pinned at 0)
 * and the app's logger.
 *
 * Returns null when WebGL2 is unavailable or the program fails to build. That is
 * the caller's cue to leave the drop overlay as it is: its backdrop and its copy
 * carry the moment on their own, which is exactly what the app does.
 */
export type Glow = {
  /** Rain ramps toward 1 while a drop is in flight, toward 0 at rest. */
  setRaining(on: boolean): void;
  /** Parks the render loop while the overlay is off screen. */
  setPaused(on: boolean): void;
  /** Light point, in client coordinates. Null lets it fade out. */
  setGlow(point: { x: number; y: number } | null): void;
  destroy(): void;
};

export function mountTriangleGlow(canvas: HTMLCanvasElement): Glow | null {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    // The effect is decoration; never spin up the discrete GPU for it.
    powerPreference: "low-power",
    premultipliedAlpha: true,
  });
  if (!gl || gl.isContextLost()) return null;

  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      // Surfaced rather than swallowed: a silent fallback would hide a shader
      // typo behind a plausible-looking absence.
      // oxlint-disable-next-line eslint/no-console
      console.error("triangle-glow: shader compile failed", gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };

  const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = vs && fs ? gl.createProgram() : null;
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  // Shaders are reference-counted by the program; drop our handles either way.
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    // oxlint-disable-next-line eslint/no-console
    console.error("triangle-glow: program link failed", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }

  const u = {
    resolution: gl.getUniformLocation(program, "u_resolution"),
    time: gl.getUniformLocation(program, "u_time"),
    tri: gl.getUniformLocation(program, "u_tri"),
    pointer: gl.getUniformLocation(program, "u_pointer"),
    dark: gl.getUniformLocation(program, "u_dark"),
    dpr: gl.getUniformLocation(program, "u_dpr"),
    motion: gl.getUniformLocation(program, "u_motion"),
    error: gl.getUniformLocation(program, "u_error"),
    rain: gl.getUniformLocation(program, "u_rain"),
    glyphs: gl.getUniformLocation(program, "u_glyphs"),
  };

  // Glyph atlas, drawn once with Canvas 2D and uploaded. LINEAR so glyph edges
  // stay smooth when a cell doesn't land on a whole texel.
  const atlas = buildGlyphAtlas();
  const glyphTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, glyphTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (atlas) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
  } else {
    // No 2D context: one black texel keeps the sampler valid and the rain
    // simply renders as nothing.
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]),
    );
  }

  // gl_VertexID needs a bound VAO, but no attributes and no buffers.
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.useProgram(program);
  gl.uniform1i(u.glyphs, 0); // sampler → texture unit 0
  gl.uniform1f(u.error, 0); // nothing here can be refused
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** Rain ramp time constant, seconds — full within a couple of frames of the
   * drag entering, without cutting. */
  const RAIN_TAU = 0.12;

  let raf = 0;
  let rainLevel = 0;
  let raining = false;
  let paused = false;
  let external: { x: number; y: number } | null = null;
  let lastFrame = performance.now();
  let dpr = 1;
  let dark = 1;
  const pointer = { x: -1e5, y: -1e5, strength: 0 };

  /**
   * The app derives this from the canvas's own computed `color`, because it has
   * a manual theme override to respect. This page does not — it follows the
   * system and nothing else — so the media query is both simpler and exact.
   *
   * It is also correct, which the colour probe was not here: every token in this
   * page is an `oklch()`, and `getComputedStyle().color` serialises those as
   * `oklch(0.946 0 0)`. Reading the first three numbers out of that and treating
   * them as 0–255 RGB gives a luma of ~0.0008 for a near-white foreground, so
   * the shader ran its light-background branch on a black page: green ink
   * instead of emissive rain, and no white-hot heads at all.
   */
  const readTheme = () => {
    dark = matchMedia("(prefers-color-scheme: dark)").matches ? 1 : 0;
  };

  const resize = () => {
    dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    readTheme();
  };

  const draw = (now: number) => {
    const w = canvas.width;
    const h = canvas.height;

    // Equilateral, apex up, fitted to the shorter axis with room for the glow
    // to fall off before it reaches the edge of the canvas.
    //
    // 0.38 where the app uses 0.29. The shader's glyph cells are a fixed size in
    // CSS pixels, so what makes the silhouette legible is how many COLUMNS the
    // triangle spans, not what fraction of the canvas it covers. The app's
    // overlay is the whole 1080px window and gets ~35 columns at 0.29; this
    // canvas is the emulated window's content area, less than half as wide, and
    // at 0.29 the shape was being carved out of about ten columns — too coarse
    // to read as a triangle. 0.38 puts it back at ~30.
    const radius = Math.min(w, h * 1.18) * 0.38;
    const halfSide = radius * Math.sqrt(3) * 0.5;

    if (external) {
      const rect = canvas.getBoundingClientRect();
      pointer.x = (external.x - rect.left) * dpr;
      pointer.y = (external.y - rect.top) * dpr;
      pointer.strength = 1;
    } else {
      pointer.strength = 0;
    }

    gl.uniform2f(u.resolution, w, h);
    gl.uniform1f(u.time, now / 1000);
    gl.uniform4f(u.tri, w / 2, h / 2, radius, halfSide);
    gl.uniform3f(u.pointer, pointer.x, pointer.y, pointer.strength);

    // Eased toward its target on a time constant rather than a per-frame
    // fraction — a fixed lerp would ramp at half speed on a 120Hz display and
    // at double on a stuttering one.
    const dt = Math.min((now - lastFrame) / 1000, 0.1);
    lastFrame = now;
    const target = raining ? 1 : 0;
    rainLevel += (target - rainLevel) * (1 - Math.exp(-dt / RAIN_TAU));
    if (Math.abs(target - rainLevel) < 0.002) rainLevel = target;

    gl.uniform1f(u.dark, dark);
    gl.uniform1f(u.dpr, dpr);
    gl.uniform1f(u.motion, reducedMotion ? 0 : 1);
    gl.uniform1f(u.rain, rainLevel);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Keep going while anything is still in flight. Reduced motion renders a
    // single frame and a paused canvas renders none — but in both cases the
    // ramp must still reach its target, or the triangle freezes mid-state.
    if ((!reducedMotion && !paused) || rainLevel > 0) {
      raf = requestAnimationFrame(draw);
    }
  };

  const start = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(draw);
  };

  resize();
  start();

  const ro = new ResizeObserver(() => {
    resize();
    if (reducedMotion) raf = requestAnimationFrame(draw);
  });
  ro.observe(canvas);

  const scheme = matchMedia("(prefers-color-scheme: dark)");
  const onScheme = () => {
    readTheme();
    if (reducedMotion || paused) raf = requestAnimationFrame(draw);
  };
  scheme.addEventListener("change", onScheme);

  const onVisibility = () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else start();
  };
  document.addEventListener("visibilitychange", onVisibility);

  // A lost context (GPU reset, driver update) would otherwise leave a frozen
  // last frame forever; an empty overlay is a better resting state.
  const onLost = (e: Event) => {
    e.preventDefault();
    cancelAnimationFrame(raf);
    canvas.hidden = true;
  };
  canvas.addEventListener("webglcontextlost", onLost);

  return {
    setRaining(on) {
      raining = on;
      start();
    },
    setPaused(on) {
      paused = on;
      if (!on) start();
    },
    setGlow(point) {
      external = point;
      if (reducedMotion || paused) raf = requestAnimationFrame(draw);
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      scheme.removeEventListener("change", onScheme);
      document.removeEventListener("visibilitychange", onVisibility);
      gl.deleteVertexArray(vao);
      gl.deleteTexture(glyphTex);
      gl.deleteProgram(program);
      // Deliberately NOT calling WEBGL_lose_context.loseContext(): getContext()
      // returns the SAME context object for a given canvas, so forcing loss on
      // teardown permanently kills that canvas. The browser reclaims it when
      // the canvas is collected.
    },
  };
}
