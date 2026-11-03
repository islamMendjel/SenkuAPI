"use client";

// Hermes — Run 29: THE SPARKLE FIELD.
//
// The welcome screen's signature layer: a full-bleed canvas of golden
// eureka-dust behind the content. Ambient sparks drift upward and
// twinkle; the pointer stirs them (a gentle repulsion + brightening
// within ~130px); every press anywhere in the welcome area bursts a
// small shower of sparks from that exact point. It is Hermes's
// "idea-spark" made ambient — the page literally reacts to you.
//
// Engineering notes:
//   • Soft-glow sprites are pre-rendered ONCE to two tiny offscreen
//     canvases (amber + white) — drawImage is an order of magnitude
//     cheaper than per-frame shadowBlur, so the field stays 60fps on
//     modest hardware even with ~70 particles.
//   • Density scales with area (capped 18–85), so phones get a sparse
//     elegant dust and desktops get a rich field.
//   • DPR-aware backing store (capped at 2×) — crisp on retina,
//     cheap elsewhere.
//   • prefers-reduced-motion: renders NOTHING (the plain background
//     stays; no static fake either — motion is the whole point).
//   • Purely decorative: the canvas is aria-hidden and
//     pointer-events-none; listeners live on window so sparks react
//     even when the pointer is over cards or text above the canvas.
//   • The loop dies with the component (cancelAnimationFrame + full
//     listener/observer teardown) — the field only exists on the
//     welcome screen and never leaks into a running conversation.

import { useEffect, useRef } from "react";

interface Spark {
  /** Sway anchor x — the horizontal home the spark oscillates around.
   *  Pointer stirs nudge the ANCHOR, so a disturbed spark keeps
   *  drifting in its new place (the field remembers the stir). */
  ax: number;
  y: number;
  r: number; // base radius, px
  base: number; // base alpha
  phase: number; // sway/twinkle phase offset
  tw: number; // twinkle speed, rad/s
  sway: number; // sway amplitude, px
  swaySp: number; // sway speed, rad/s
  vy: number; // upward drift, px/s
  glow: number; // pointer excitement 0..1 (decays)
  white: boolean;
}

interface Burst {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number; // total lifetime, s
  size: number;
  white: boolean;
}

/** Pre-rendered radial-glow sprite — the only drawing primitive. */
function makeSprite(r: number, g: number, b: number): HTMLCanvasElement {
  const s = document.createElement("canvas");
  s.width = s.height = 32;
  const c = s.getContext("2d");
  if (!c) return s;
  const grad = c.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
  grad.addColorStop(0.35, `rgba(${r},${g},${b},0.55)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  c.fillStyle = grad;
  c.fillRect(0, 0, 32, 32);
  return s;
}

const POINTER_RADIUS = 130;
const POINTER_FORCE = 95; // px/s of nudge at the pointer's core

export function SparkleField() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return; // motion is the point — no static stand-in
    }

    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const AMBER = makeSprite(253, 224, 121); // warm gold — the brand dust
    const WHITE = makeSprite(244, 244, 245); // occasional zinc-white accent

    let w = 0;
    let h = 0;
    let sparks: Spark[] = [];
    let bursts: Burst[] = [];
    const pointer = { x: -1e4, y: -1e4 };

    const spawn = (n: number): Spark[] =>
      Array.from({ length: n }, () => ({
        ax: Math.random() * w,
        y: Math.random() * h,
        r: 0.7 + Math.random() * 1.1,
        base: 0.2 + Math.random() * 0.38,
        phase: Math.random() * Math.PI * 2,
        tw: 0.6 + Math.random() * 1.4,
        sway: 6 + Math.random() * 14,
        swaySp: 0.3 + Math.random() * 0.5,
        vy: 6 + Math.random() * 16,
        glow: 0,
        white: Math.random() < 0.22,
      }));

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = Math.max(1, Math.round(rect.width));
      h = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.min(85, Math.max(18, Math.round((w * h) / 15000)));
      sparks = spawn(n);
    };

    // Pointer → canvas coordinates (getBoundingClientRect already
    // accounts for any scroll offset of the canvas itself).
    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
    };
    const onLeave = () => {
      pointer.x = -1e4;
      pointer.y = -1e4;
    };

    // Any press inside the welcome area bursts from that exact point —
    // including presses on cards/buttons above the canvas (purely
    // visual; the canvas never intercepts the event itself).
    const onDown = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (x < -20 || y < -20 || x > w + 20 || y > h + 20) return;
      for (let i = 0; i < 12; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 40 + Math.random() * 110;
        bursts.push({
          x,
          y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp - 28, // bias upward — eureka flies up
          life: 0,
          max: 0.7 + Math.random() * 0.7,
          size: 2.2 + Math.random() * 3.4,
          white: Math.random() < 0.3,
        });
      }
    };

    let raf = 0;
    let last = performance.now();

    const frame = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      const time = t / 1000;

      ctx.clearRect(0, 0, w, h);

      // ── ambient dust ──
      for (const s of sparks) {
        s.y -= s.vy * dt;
        if (s.y < -12) {
          s.y = h + 12;
          s.ax = Math.random() * w; // respawn from the bottom
        }
        const px = s.ax + Math.sin(time * s.swaySp + s.phase) * s.sway;

        // pointer stir — repel + excite
        const dx = px - pointer.x;
        const dy = s.y - pointer.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < POINTER_RADIUS * POINTER_RADIUS) {
          const d = Math.sqrt(d2) || 1;
          const near = 1 - d / POINTER_RADIUS;
          const push = near * POINTER_FORCE * dt;
          s.ax += (dx / d) * push;
          s.y += (dy / d) * push * 0.6;
          s.glow = Math.min(1, s.glow + near * 3.5 * dt);
        }
        s.glow = Math.max(0, s.glow - 1.6 * dt);

        const alpha = Math.min(
          1,
          s.base * (0.55 + 0.45 * Math.sin(time * s.tw + s.phase)) +
            s.glow * 0.55
        );
        const size = s.r * (4.5 + s.glow * 3);
        ctx.globalAlpha = alpha;
        ctx.drawImage(
          s.white ? WHITE : AMBER,
          px - size / 2,
          s.y - size / 2,
          size,
          size
        );
      }

      // ── press bursts ──
      if (bursts.length > 0) {
        const alive: Burst[] = [];
        for (const b of bursts) {
          b.life += dt;
          if (b.life >= b.max) continue;
          const k = 1 - b.life / b.max;
          const drag = Math.pow(0.12, dt); // ~3.5%/frame velocity bleed
          b.vx *= drag;
          b.vy = b.vy * drag - 26 * dt; // buoyant: drifts up as it slows
          b.x += b.vx * dt;
          b.y += b.vy * dt;
          const size = b.size * (0.5 + k * 1.1);
          ctx.globalAlpha = k * 0.9;
          ctx.drawImage(
            b.white ? WHITE : AMBER,
            b.x - size / 2,
            b.y - size / 2,
            size,
            size
          );
          alive.push(b);
        }
        bursts = alive;
      }

      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    };

    resize();
    raf = requestAnimationFrame(frame);

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    window.addEventListener("pointerleave", onLeave);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 h-full w-full"
    />
  );
}
