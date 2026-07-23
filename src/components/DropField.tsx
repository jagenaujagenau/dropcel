import { useEffect, useRef } from "react";
import { buildStars } from "./TriangleField";

/**
 * The drop moment, full-viewport: ambient stars, the triangle constellation
 * at center, particles streaming INTO it, and a launch column rising off
 * the apex. Scene energy scales with how close the dragged file is to the
 * triangle — approach and everything intensifies. Canvas 2D, no deps.
 */

interface Attracted {
  x: number;
  y: number;
  life: number;
  maxLife: number;
  speed: number;
}

interface Streak {
  x: number;
  y: number;
  len: number;
  speed: number;
  drift: number;
}

export function DropField({
  glow,
  className,
}: {
  /** Drag position in client coordinates. */
  glow?: { x: number; y: number } | null;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<{ x: number; y: number } | null>(null);
  glowRef.current = glow ?? null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const triangleStars = buildStars();
    const attracted: Attracted[] = [];
    const streaks: Streak[] = [];
    const born = performance.now();
    let raf = 0;
    let last = born;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let fg = "#fff";
    let accent = "#07f";

    const readColors = () => {
      const cs = getComputedStyle(canvas);
      fg = cs.color || "#fff";
      accent = cs.accentColor && cs.accentColor !== "auto" ? cs.accentColor : fg;
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      readColors();
    };

    const rand = (a: number, b: number) => a + Math.random() * (b - a);

    const draw = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const t = now / 1000;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      // Triangle box: centered, biased slightly down for launch headroom.
      const side = Math.min(width, height) * 0.52;
      const cx = width / 2;
      const cy = height * 0.54;
      const ox = cx - side / 2;
      const oy = cy - side / 2;
      const apexY = oy + side * 0.16;

      // Energy: proximity of the dragged file to the triangle.
      const g = glowRef.current;
      let energy = 0.45;
      if (g) {
        const rect = canvas.getBoundingClientRect();
        const gx = g.x - rect.left;
        const gy = g.y - rect.top;
        const d2 = (gx - cx) ** 2 + (gy - cy) ** 2;
        const r = Math.min(width, height) * 0.45;
        energy = 0.45 + 0.55 * Math.exp(-d2 / (r * r));
      }

      ctx.fillStyle = fg;

      // Ambient stars: sparse, whole viewport, slow shimmer.
      for (let i = 0; i < 90; i++) {
        // Deterministic pseudo-random placement from index.
        const sx = ((i * 127.3) % 97) / 97;
        const sy = ((i * 311.7) % 89) / 89;
        const tw = reducedMotion ? 0.6 : 0.5 + 0.5 * Math.sin(t * (0.4 + (i % 7) * 0.13) + i);
        ctx.globalAlpha = 0.05 + 0.09 * tw;
        ctx.fillRect(sx * width, sy * height, 1, 1);
      }

      // Entry ring: one soft pulse when the overlay appears.
      if (!reducedMotion) {
        const age = (now - born) / 700;
        if (age < 1) {
          ctx.globalAlpha = 0.35 * (1 - age);
          ctx.strokeStyle = fg;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(cx, cy, side * (0.2 + 0.45 * age), 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // Inbound particles: spawn at the fringes, accelerate into the triangle.
      if (!reducedMotion) {
        const spawnRate = 26 * energy;
        if (Math.random() < spawnRate * dt) {
          const angle = rand(0, Math.PI * 2);
          const radius = rand(0.5, 0.75) * Math.min(width, height);
          attracted.push({
            x: cx + Math.cos(angle) * radius,
            y: cy + Math.sin(angle) * radius,
            life: 0,
            maxLife: rand(0.8, 1.5),
            speed: rand(120, 220),
          });
        }
        for (let i = attracted.length - 1; i >= 0; i--) {
          const p = attracted[i];
          p.life += dt;
          const dx = cx - p.x;
          const dy = cy - p.y;
          const dist = Math.hypot(dx, dy) || 1;
          const accel = 1 + p.life * 2.2; // pull harder as it falls in
          p.x += (dx / dist) * p.speed * accel * dt;
          p.y += (dy / dist) * p.speed * accel * dt;
          if (p.life >= p.maxLife || dist < side * 0.18) {
            attracted.splice(i, 1);
            continue;
          }
          const fade = Math.sin(Math.PI * (p.life / p.maxLife));
          ctx.globalAlpha = 0.35 * fade * energy;
          ctx.strokeStyle = fg;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - (dx / dist) * 9, p.y - (dy / dist) * 9);
          ctx.stroke();
        }
      }

      // The triangle constellation.
      ctx.fillStyle = fg;
      for (const s of triangleStars) {
        const x = ox + s.x * side;
        const y = oy + s.y * side;
        let alpha = s.base * (0.55 + 0.45 * energy);
        if (!reducedMotion) {
          const tw = 0.5 + 0.5 * Math.sin(t * s.f1 + s.p1) * Math.sin(t * s.f2 * 7 + s.p2);
          alpha *= 0.4 + 0.6 * tw;
        }
        if (g) {
          const rect = canvas.getBoundingClientRect();
          const dx = x - (g.x - rect.left);
          const dy = y - (g.y - rect.top);
          alpha = Math.min(1, alpha + Math.exp(-(dx * dx + dy * dy) / (side * side * 0.02)) * 0.85);
        }
        const px = s.size;
        ctx.globalAlpha = alpha;
        ctx.fillRect(x - px / 2, y - px / 2, px, px);
      }

      // Launch column: streaks rising off the apex (the app icon's beam).
      if (!reducedMotion) {
        const want = Math.round(4 + 9 * energy);
        while (streaks.length < want) {
          streaks.push({
            x: cx + rand(-side * 0.1, side * 0.1),
            y: apexY - rand(0, height * 0.25),
            len: rand(14, 46),
            speed: rand(90, 220),
            drift: rand(-4, 4),
          });
        }
        for (let i = streaks.length - 1; i >= 0; i--) {
          const s = streaks[i];
          s.y -= s.speed * (0.5 + energy) * dt;
          s.x += s.drift * dt;
          if (s.y + s.len < apexY - height * 0.42 || streaks.length > want) {
            streaks.splice(i, 1);
            continue;
          }
          const climb = (apexY - s.y) / (height * 0.42);
          const grad = ctx.createLinearGradient(s.x, s.y, s.x, s.y + s.len);
          grad.addColorStop(0, "transparent");
          grad.addColorStop(1, accent);
          ctx.globalAlpha = 0.5 * energy * (1 - Math.min(1, Math.max(0, climb)));
          ctx.strokeStyle = grad;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(s.x, s.y + s.len);
          ctx.stroke();
        }
      }

      ctx.globalAlpha = 1;
      if (!reducedMotion) raf = requestAnimationFrame(draw);
    };

    resize();
    raf = requestAnimationFrame(draw);
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ color: "var(--color-foreground)", accentColor: "var(--color-focus)" }}
    />
  );
}
