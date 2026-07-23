import { useEffect, useRef } from "react";

/**
 * A star-field Vercel triangle, in the spirit of vercel-labs' galaxy shader
 * but sized for a webview: Canvas 2D, no dependencies. Bright twinkling
 * stars trace the triangle's edges, dimmer ones fill it, faint ambient
 * stars drift around it. The cursor brightens nearby stars. Colors follow
 * the container's computed color, so it adapts to light/dark themes, and
 * prefers-reduced-motion renders it static.
 */

export interface Star {
  /** Position normalized to canvas size. */
  x: number;
  y: number;
  size: number;
  base: number;
  f1: number;
  f2: number;
  p1: number;
  p2: number;
}

export function buildStars(): Star[] {
  const stars: Star[] = [];
  const rand = (a: number, b: number) => a + Math.random() * (b - a);
  // Triangle in normalized coords, apex up, centered.
  const ax = 0.5, ay = 0.16;
  const bx = 0.18, by = 0.82;
  const cx = 0.82, cy = 0.82;

  const inTriangle = (x: number, y: number) => {
    const s = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
    const t = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    const u = (cx - bx) * (y - by) - (cy - by) * (x - bx);
    return (s >= 0 && t >= 0 && u >= 0) || (s <= 0 && t <= 0 && u <= 0);
  };

  const gauss = () => {
    let sum = 0;
    for (let i = 0; i < 4; i++) sum += Math.random();
    return sum / 2 - 1; // ~N(0, 0.5)
  };

  const star = (x: number, y: number, base: number, size: number): Star => ({
    x,
    y,
    size,
    base,
    f1: rand(0.6, 1.6),
    f2: rand(0.13, 0.4),
    p1: rand(0, Math.PI * 2),
    p2: rand(0, Math.PI * 2),
  });

  // Edge stars: bright, hugging the three sides.
  const edges: [number, number, number, number][] = [
    [ax, ay, bx, by],
    [bx, by, cx, cy],
    [cx, cy, ax, ay],
  ];
  for (const [x1, y1, x2, y2] of edges) {
    for (let i = 0; i < 240; i++) {
      const t = Math.random();
      const jitter = gauss() * 0.008;
      const nx = -(y2 - y1);
      const ny = x2 - x1;
      const len = Math.hypot(nx, ny) || 1;
      stars.push(
        star(
          x1 + (x2 - x1) * t + (nx / len) * jitter,
          y1 + (y2 - y1) * t + (ny / len) * jitter,
          rand(0.55, 1),
          rand(0.6, 1.5),
        ),
      );
    }
  }
  // Interior fill: dimmer.
  let placed = 0;
  while (placed < 340) {
    const x = rand(0.18, 0.82);
    const y = rand(0.16, 0.82);
    if (inTriangle(x, y)) {
      stars.push(star(x, y, rand(0.1, 0.34), rand(0.5, 1.1)));
      placed++;
    }
  }
  // Ambient sky.
  for (let i = 0; i < 260; i++) {
    stars.push(star(Math.random(), Math.random(), rand(0.04, 0.16), rand(0.4, 1)));
  }
  return stars;
}

export function TriangleField({
  className,
  glow,
}: {
  className?: string;
  /** External glow point in client coordinates — used while a native drag
   * is in progress (drags suppress pointer events). */
  glow?: { x: number; y: number } | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<{ x: number; y: number } | null>(null);
  glowRef.current = glow ?? null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const stars = buildStars();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    const pointer = { x: -1e3, y: -1e3 };
    // The theme colors are oklch(); rather than parsing, hand the computed
    // color straight to the canvas and vary opacity via globalAlpha.
    let color = "#fff";

    const readColor = () => {
      color = getComputedStyle(canvas).color || "#fff";
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      readColor();
    };

    const draw = (now: number) => {
      const t = now / 1000;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      // Fit the triangle square-ish and centered.
      const side = Math.min(width, height);
      const ox = (width - side) / 2;
      const oy = (height - side) / 2;
      ctx.fillStyle = color;

      // External glow (drag position) overrides the mouse pointer.
      const external = glowRef.current;
      let gx = pointer.x;
      let gy = pointer.y;
      if (external) {
        const rect = canvas.getBoundingClientRect();
        gx = external.x - rect.left;
        gy = external.y - rect.top;
      }

      for (const s of stars) {
        const x = ox + s.x * side;
        const y = oy + s.y * side;
        let alpha = s.base;
        if (!reducedMotion) {
          const tw = 0.5 + 0.5 * Math.sin(t * s.f1 + s.p1) * Math.sin(t * s.f2 * 7 + s.p2);
          alpha *= 0.35 + 0.65 * tw;
        }
        // Cursor glow (the shader's fluid-brighten, radically simplified).
        const dx = x - gx;
        const dy = y - gy;
        const boost = Math.exp(-(dx * dx + dy * dy) / (side * side * 0.02));
        alpha = Math.min(1, alpha + boost * 0.85);

        const px = s.size * (1 + boost * 0.6);
        ctx.globalAlpha = alpha;
        ctx.fillRect(x - px / 2, y - px / 2, px, px);
      }
      ctx.globalAlpha = 1;
      if (!reducedMotion) raf = requestAnimationFrame(draw);
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

    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
    };
    const onLeave = () => {
      pointer.x = -1e3;
      pointer.y = -1e3;
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);

    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => {
      // Computed style updates async with the scheme flip; re-read next tick.
      setTimeout(() => {
        readColor();
        if (reducedMotion) raf = requestAnimationFrame(draw);
      }, 0);
    };
    scheme.addEventListener("change", onScheme);

    const onVisibility = () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else start();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      scheme.removeEventListener("change", onScheme);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <canvas ref={canvasRef} className={className} style={{ color: "var(--color-foreground)" }} />;
}
