// Chart drawing model (pure): where a drawing's times sit among the bars of any timeframe, pixel hit tests,
// and the long / short position tool's numbers. Used by the trade chart's drawing layer.

import type { Drawing, DrawingKind } from './types.ts';

export interface TimedBar {
  time: number;
}

export interface Pt {
  x: number;
  y: number;
}

/** Points each kind is anchored by. */
export const DRAWING_POINTS: Record<DrawingKind, number> = { trendline: 2, hline: 1, hray: 1, rect: 2, long: 2, short: 2 };

export const isPositionKind = (k: DrawingKind): k is 'long' | 'short' => k === 'long' || k === 'short';

/**
 * Fractional bar index ("logical") of unix-seconds time `t`: bar i spans [time_i, time_i + tf). A time inside
 * a gap (market closed) lands on the next bar; times before / after the bars extrapolate at one bar per `tf`.
 */
export function timeToLogical(bars: readonly TimedBar[], tf: number, t: number): number {
  const n = bars.length;
  if (!n) return 0;
  if (t <= bars[0].time) return (t - bars[0].time) / tf;
  const last = bars[n - 1].time;
  if (t >= last) return n - 1 + (t - last) / tf;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].time <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo + Math.min(1, (t - bars[lo].time) / tf);
}

/** Inverse of timeToLogical; a whole index gives that bar's open time. */
export function logicalToTime(bars: readonly TimedBar[], tf: number, l: number): number {
  const n = bars.length;
  if (!n) return 0;
  if (l <= 0) return Math.round(bars[0].time + l * tf);
  if (l >= n - 1) return Math.round(bars[n - 1].time + (l - (n - 1)) * tf);
  const i = Math.floor(l);
  return Math.round(bars[i].time + (l - i) * Math.min(tf, bars[i + 1].time - bars[i].time));
}

/** Distance from p to the segment a–b. */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** p lies in the box spanned by a and b, grown by `tol` on every side. */
export function inBox(p: Pt, a: Pt, b: Pt, tol = 0): boolean {
  return p.x >= Math.min(a.x, b.x) - tol && p.x <= Math.max(a.x, b.x) + tol && p.y >= Math.min(a.y, b.y) - tol && p.y <= Math.max(a.y, b.y) + tol;
}

// ───────────────────────────── position tool ─────────────────────────────

export interface PositionLevels {
  dir: 1 | -1;
  entry: number;
  tp: number;
  sl: number;
  /** Price distances to the target / stop (positive). */
  reward: number;
  risk: number;
  /** reward ÷ risk. */
  ratio: number;
}

export function positionLevels(d: Pick<Drawing, 'kind' | 'points' | 'tp' | 'sl'>): PositionLevels | null {
  if (!isPositionKind(d.kind) || d.tp == null || d.sl == null || !d.points.length) return null;
  const dir = d.kind === 'long' ? 1 : -1;
  const entry = d.points[0].price;
  const reward = (d.tp - entry) * dir;
  const risk = (entry - d.sl) * dir;
  return { dir, entry, tp: d.tp, sl: d.sl, reward, risk, ratio: risk > 0 ? reward / risk : 0 };
}

/** Keeps the target and the stop at least one tick on their own side of the entry. */
export function clampLevels(kind: 'long' | 'short', entry: number, tp: number, sl: number, tick: number): { tp: number; sl: number } {
  const dir = kind === 'long' ? 1 : -1;
  return {
    tp: (tp - entry) * dir >= tick ? tp : entry + dir * tick,
    sl: (entry - sl) * dir >= tick ? sl : entry - dir * tick,
  };
}
