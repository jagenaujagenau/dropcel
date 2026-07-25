import { useEffect, useRef, useState } from "react";
import { log } from "../lib/log";
import { buildGlyphAtlas } from "./matrix-glyphs";
import { FRAGMENT_SHADER, VERTEX_SHADER } from "./triangle-glow-shader";

/**
 * Matrix rain with the Vercel triangle cut out of it — see
 * `triangle-glow-shader.ts` for how the shape is revealed.
 *
 * Used in exactly one place, the drop overlay, and only while a file is
 * actually landing. Renders nothing at all when WebGL2 is unavailable or the
 * program fails to build; the overlay's backdrop and copy carry the
 * interaction on their own. Theme is read from the element's own computed
 * colour so it tracks the app's theme rather than only the OS setting.
 */
export function TriangleGlow({
  className,
  glow,
  errorAt,
  raining = false,
  paused = false,
}: {
  className?: string;
  /** External glow point in client coordinates — native drags suppress
   * pointer events, so the drop overlay feeds the position in directly. */
  glow?: { x: number; y: number } | null;
  /** `Date.now()` of the most recent failure. Each new value replays the
   * failure state; null (or a stale value) leaves the triangle at rest. */
  errorAt?: number | null;
  /** Matrix rain, raised while a drop is in flight. Ramps in and out rather
   * than cutting, so releasing the drag doesn't snap the field to black. */
  raining?: boolean;
  /** Stops the render loop while the canvas is mounted but not visible. The
   * component is kept mounted across drags on purpose — see DropZone — so it
   * needs a way to not render when nothing is looking at it. */
  paused?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<{ x: number; y: number } | null>(null);
  glowRef.current = glow ?? null;
  const errorAtRef = useRef<number | null>(null);
  errorAtRef.current = errorAt ?? null;
  const rainingRef = useRef(false);
  rainingRef.current = raining;
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  /** Restarts the render loop; set by the effect below. */
  const kickRef = useRef<(() => void) | null>(null);
  const [unsupported, setUnsupported] = useState(false);

  // Both states have to repaint even when the loop is parked — which it is
  // under prefers-reduced-motion, and after the tab has been hidden.
  useEffect(() => {
    if (errorAt != null || raining || !paused) kickRef.current?.();
  }, [errorAt, raining, paused]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      // The effect is decoration; never spin up the discrete GPU for it.
      powerPreference: "low-power",
      premultipliedAlpha: true,
    });
    if (!gl) {
      // Logged, not silent. This branch and a clean run were previously
      // indistinguishable in the log, so "no rain in the app" gave no way to
      // tell a missing context from a working one nobody had triggered.
      log.error("triangle-glow", "WebGL2 unavailable — falling back to the star field");
      setUnsupported(true);
      return;
    }
    if (gl.isContextLost()) {
      log.error("triangle-glow", "WebGL2 context is already lost at init");
      setUnsupported(true);
      return;
    }
    {
      // One line per mount, naming the renderer. The effect is the first thing
      // in the app that depends on the GPU at all, so when it misbehaves this
      // is the only record of what it was actually running on.
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = dbg
        ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
        : String(gl.getParameter(gl.RENDERER));
      log.info("triangle-glow", `WebGL2 ready (${renderer})`);
    }

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) {
        // Chiefly a lost context — createShader returns null there. This used
        // to return silently, which made a dead context look identical to a
        // healthy one that simply hadn't been asked to draw yet.
        log.error(
          "triangle-glow",
          `createShader returned null (contextLost=${gl.isContextLost()})`,
        );
        return null;
      }
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        // Surfaced rather than swallowed: a silent fallback to the star field
        // would hide a shader typo behind a plausible-looking visual.
        log.error("triangle-glow", `shader compile failed: ${gl.getShaderInfoLog(shader)}`);
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = vs && fs ? gl.createProgram() : null;
    if (!vs || !fs || !program) {
      setUnsupported(true);
      return;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    // Shaders are reference-counted by the program; drop our handles either way.
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      log.error("triangle-glow", `program link failed: ${gl.getProgramInfoLog(program)}`);
      gl.deleteProgram(program);
      setUnsupported(true);
      return;
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

    // Glyph atlas, drawn once with Canvas 2D and uploaded. LINEAR so glyph
    // edges stay smooth when a cell doesn't land on a whole texel.
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
      // No 2D context: upload one black texel so the sampler is still valid
      // and the rain simply renders as nothing.
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
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    /** Rain ramp time constant, seconds. ~0.12s reaches full within a couple
     * of frames of the drag entering, without cutting. */
    const RAIN_TAU = 0.12;
    let rainLevel = 0;
    let lastFrame = performance.now();

    // Failure envelope: snap on, hold, then fall away. Snapping in and easing
    // out is what makes it read as something that HAPPENED rather than as a
    // state that faded in.
    const ERROR_ATTACK_MS = 90;
    const ERROR_HOLD_MS = 1000;
    const ERROR_RELEASE_MS = 700;
    const ERROR_TOTAL_MS = ERROR_ATTACK_MS + ERROR_HOLD_MS + ERROR_RELEASE_MS;
    const errorEnvelope = () => {
      const at = errorAtRef.current;
      if (at == null) return 0;
      const age = Date.now() - at;
      if (age < 0 || age > ERROR_TOTAL_MS) return 0;
      if (age < ERROR_ATTACK_MS) return age / ERROR_ATTACK_MS;
      const released = age - ERROR_ATTACK_MS - ERROR_HOLD_MS;
      if (released <= 0) return 1;
      return 1 - released / ERROR_RELEASE_MS;
    };

    let dpr = 1;
    let dark = 1;
    const pointer = { x: -1e5, y: -1e5, strength: 0 };

    /** Theme from the element's own computed color: a light foreground means a
     * dark surface behind it. Works with the app's theme, not just the OS. */
    const readTheme = () => {
      const color = getComputedStyle(canvas).color;
      const m = /(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/.exec(color);
      if (!m) return;
      const luma =
        (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
      dark = luma > 0.5 ? 1 : 0;
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
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

      // Equilateral, apex up, fitted to the shorter axis with room for the
      // glow to fall off before it reaches the edge of the canvas.
      const radius = Math.min(w, h * 1.18) * 0.29;
      const halfSide = radius * Math.sqrt(3) * 0.5;

      const external = glowRef.current;
      if (external) {
        const rect = canvas.getBoundingClientRect();
        pointer.x = (external.x - rect.left) * dpr;
        pointer.y = (external.y - rect.top) * dpr;
        pointer.strength = 1;
      }

      gl.uniform2f(u.resolution, w, h);
      gl.uniform1f(u.time, now / 1000);
      gl.uniform4f(u.tri, w / 2, h / 2, radius, halfSide);
      gl.uniform3f(u.pointer, pointer.x, pointer.y, pointer.strength);
      const errorLevel = errorEnvelope();

      // Rain ramp, eased toward its target on a time constant rather than a
      // per-frame fraction — a fixed lerp would ramp at half speed on a 120Hz
      // display and at double on a stuttering one.
      const dt = Math.min((now - lastFrame) / 1000, 0.1);
      lastFrame = now;
      const target = rainingRef.current ? 1 : 0;
      rainLevel += (target - rainLevel) * (1 - Math.exp(-dt / RAIN_TAU));
      if (Math.abs(target - rainLevel) < 0.002) rainLevel = target;

      gl.uniform1f(u.dark, dark);
      gl.uniform1f(u.dpr, dpr);
      gl.uniform1f(u.motion, reducedMotion ? 0 : 1);
      gl.uniform1f(u.error, errorLevel);
      gl.uniform1f(u.rain, rainLevel);

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Keep going while anything is still in flight. Reduced motion renders a
      // single frame, and a paused canvas renders none — but in both cases the
      // envelopes must still run to their target, or the triangle freezes
      // mid-state.
      const settling = errorLevel > 0 || rainLevel > 0;
      if ((!reducedMotion && !pausedRef.current) || settling) {
        raf = requestAnimationFrame(draw);
      }
    };

    const start = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    };

    kickRef.current = start;
    resize();
    start();

    const ro = new ResizeObserver(() => {
      resize();
      if (reducedMotion) raf = requestAnimationFrame(draw);
    });
    ro.observe(canvas);

    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = (e.clientX - rect.left) * dpr;
      pointer.y = (e.clientY - rect.top) * dpr;
      pointer.strength = 1;
      if (reducedMotion) raf = requestAnimationFrame(draw);
    };
    const onLeave = () => {
      pointer.strength = 0;
      if (reducedMotion) raf = requestAnimationFrame(draw);
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);

    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => {
      // Computed style updates async with the scheme flip; re-read next tick.
      setTimeout(() => {
        readTheme();
        if (reducedMotion) raf = requestAnimationFrame(draw);
      }, 0);
    };
    scheme.addEventListener("change", onScheme);

    const onVisibility = () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else start();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // A lost context (GPU reset, driver update) would otherwise leave a frozen
    // last frame forever; the star field is a better resting state.
    const onLost = (e: Event) => {
      e.preventDefault();
      cancelAnimationFrame(raf);
      setUnsupported(true);
    };
    canvas.addEventListener("webglcontextlost", onLost);

    return () => {
      kickRef.current = null;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("webglcontextlost", onLost);
      scheme.removeEventListener("change", onScheme);
      document.removeEventListener("visibilitychange", onVisibility);
      gl.deleteVertexArray(vao);
      gl.deleteTexture(glyphTex);
      gl.deleteProgram(program);
      // Deliberately NOT calling WEBGL_lose_context.loseContext() here.
      // getContext() returns the SAME context object for a given canvas, so
      // forcing loss on teardown permanently kills that canvas's context —
      // and React StrictMode runs mount→cleanup→mount in dev, so the second
      // mount got back the context the first had just destroyed. Every GL
      // call then returns null and the component fell through to the star
      // field. The browser reclaims the context when the canvas is collected.
    };
  }, []);

  // Without WebGL2 there is no effect: the drop overlay still has its backdrop
  // and its "Drop to deploy" copy, so the interaction is unharmed. Substituting
  // a different visual here would mean shipping a second, unrelated animation
  // for a path that logs an error anyway.
  if (unsupported) return null;

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ color: "var(--color-foreground)" }}
      aria-hidden="true"
    />
  );
}
