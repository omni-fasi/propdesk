import { useEffect, useRef } from 'react';

// Monochrome paper with a few green accents — celebratory, not a rainbow.
const COLORS = ['#ffffff', '#f2f2f2', '#d4d4d4', '#a3a3a3', '#6b6b6b', '#1fc773', '#16a862', '#f2f2f2', '#1fc773'];

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  rot: number;
  vr: number;
  tilt: number;
  vt: number;
  phase: number;
  color: string;
  delay: number;
}

/** A short, gentle fall of paper pieces over the screen. Skipped with prefers-reduced-motion. */
export function Confetti({ count = 120, duration = 4200 }: { count?: number; duration?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let w = 0;
    let h = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const pieces: Piece[] = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: -20 - Math.random() * h * 0.35,
      vx: (Math.random() - 0.5) * 1.2,
      vy: 1.6 + Math.random() * 2.2,
      w: 5 + Math.random() * 5,
      h: 8 + Math.random() * 8,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.12,
      tilt: Math.random() * Math.PI * 2,
      vt: 0.05 + Math.random() * 0.08,
      phase: Math.random() * Math.PI * 2,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      delay: Math.random() * 700,
    }));

    const start = performance.now();
    let last = start;
    let raf = 0;
    const frame = (now: number) => {
      const elapsed = now - start;
      const dt = Math.min(3, (now - last) / 16.67);
      last = now;
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = elapsed > duration - 700 ? Math.max(0, (duration - elapsed) / 700) : 1;
      for (const p of pieces) {
        if (elapsed < p.delay) continue;
        p.vy = Math.min(4.2, p.vy + 0.035 * dt);
        p.x += (p.vx + Math.sin(elapsed / 420 + p.phase) * 0.7) * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        p.tilt += p.vt * dt;
        if (p.y > h + 20) continue;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.scale(Math.cos(p.tilt), 1);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (elapsed < duration) raf = requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, w, h);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [count, duration]);

  return <canvas ref={ref} aria-hidden className="pointer-events-none fixed inset-0 h-full w-full" />;
}
