// Trade replay model (pure): the price path to play back, bars at any resolution, and the trade's state
// (position, P&L, stop / target) at any moment. Used by the journal's replay player.

import type { BracketChange, Candle, Fill, InstrumentSpec, TickSample } from './types.ts';

/** Playback speeds offered (× real time). */
export const REPLAY_SPEEDS = [1, 2, 5, 10, 30, 60, 120] as const;
/** Bar sizes offered, in seconds. */
export const REPLAY_RESOLUTIONS = [5, 15, 30, 60, 300] as const;

/** Stretches without samples longer than this are filled from the 1-minute bars. */
const GAP_MS = 90_000;

/** Points through a 1-minute bar: open → low → high → close for an up bar (high first for a down bar). */
function barPoints(bars: Candle[], from: number, to: number): TickSample[] {
  const out: TickSample[] = [];
  for (const c of bars) {
    const t0 = c.time * 1000;
    if (t0 + 60_000 <= from || t0 >= to) continue;
    const up = c.close >= c.open;
    const pts: Array<[number, number]> = [
      [0, c.open],
      [15_000, up ? c.low : c.high],
      [35_000, up ? c.high : c.low],
      [55_000, c.close],
    ];
    for (const [dt, p] of pts) if (t0 + dt >= from && t0 + dt < to) out.push([t0 + dt, p, p]);
  }
  return out;
}

/**
 * The price path to replay over [from, to]: the samples, with the stretches they don't cover (before the
 * first, after the last, gaps) filled by a path through the 1-minute bars, plus a point at every fill time
 * so each fill lands on a bar.
 */
export function replayPath(ticks: TickSample[], bars: Candle[], from: number, to: number, fillTimes: number[] = []): TickSample[] {
  const inside = ticks.filter((x) => x[0] >= from && x[0] <= to);
  let out: TickSample[];
  if (!inside.length) {
    out = barPoints(bars, from, to + 1);
  } else {
    out = [];
    if (inside[0][0] - from > GAP_MS) out.push(...barPoints(bars, from, inside[0][0]));
    for (let i = 0; i < inside.length; i++) {
      out.push(inside[i]);
      const next = inside[i + 1];
      if (next && next[0] - inside[i][0] > GAP_MS) out.push(...barPoints(bars, inside[i][0] + 1, next[0]));
    }
    const last = inside[inside.length - 1][0];
    if (to - last > GAP_MS) out.push(...barPoints(bars, last + 1, to + 1));
  }
  if (!out.length) return out;
  const extra: TickSample[] = [];
  for (const ft of fillTimes) {
    if (ft < from || ft > to) continue;
    const i = indexAtOrBefore(out, ft);
    const ref = out[Math.max(0, i)];
    if (i < 0 || out[i][0] !== ft) extra.push([ft, ref[1], ref[2]]);
  }
  return extra.length ? [...out, ...extra].sort((a, b) => a[0] - b[0]) : out;
}

/** Index of the last sample at or before `t` (−1 when none). */
export function indexAtOrBefore(path: TickSample[], t: number): number {
  let lo = 0;
  let hi = path.length - 1;
  if (hi < 0 || path[0][0] > t) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (path[mid][0] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export const midOf = (s: TickSample) => (s[1] + s[2]) / 2;

/** Open time (seconds) of the `sec`-second bar containing `t` (ms). */
export const barTimeOf = (t: number, sec: number) => Math.floor(t / 1000 / sec) * sec;

/** Adds one sample to `bars` (mutated): extends the forming bar or opens the next one at the previous close. */
export function pushSample(bars: Candle[], s: TickSample, sec: number): Candle {
  const p = midOf(s);
  const time = barTimeOf(s[0], sec);
  const last = bars[bars.length - 1];
  if (last && last.time === time) {
    last.high = Math.max(last.high, p);
    last.low = Math.min(last.low, p);
    last.close = p;
    return last;
  }
  const open = last ? last.close : p;
  const bar: Candle = { time, open, high: Math.max(open, p), low: Math.min(open, p), close: p, volume: 0 };
  bars.push(bar);
  return bar;
}

/** Bars of `sec` seconds from the samples with t ≤ upTo (the last one still forming), priced at the mid. */
export function replayBars(path: TickSample[], sec: number, upTo: number): Candle[] {
  const bars: Candle[] = [];
  for (const s of path) {
    if (s[0] > upTo) break;
    pushSample(bars, s, sec);
  }
  return bars;
}

export interface ReplayPosition {
  /** Signed size (+ long, − short). */
  qty: number;
  avg: number;
  /** Gross realized P&L so far. */
  realized: number;
  fees: number;
  /** Fills done so far. */
  fills: number;
}

/** Position built from the fills up to t (inclusive). */
export function positionAt(fills: Fill[], t: number): ReplayPosition {
  let qty = 0;
  let avg = 0;
  let realized = 0;
  let fees = 0;
  let n = 0;
  for (const f of fills) {
    if (f.ts > t) break;
    n++;
    fees += f.fee;
    realized += f.realizedPnl;
    const d = f.side === 'buy' ? f.qty : -f.qty;
    if (qty === 0 || Math.sign(qty) === Math.sign(d)) {
      avg = (avg * Math.abs(qty) + f.price * Math.abs(d)) / (Math.abs(qty) + Math.abs(d));
      qty += d;
    } else {
      const flip = Math.abs(d) > Math.abs(qty);
      qty += d;
      if (flip) avg = f.price;
    }
    qty = Number(qty.toFixed(8));
    if (qty === 0) avg = 0;
  }
  return { qty, avg, realized, fees, fills: n };
}

/** Open P&L of a position at a sample: longs are marked at the bid, shorts at the ask. */
export function openPnlAt(spec: Pick<InstrumentSpec, 'multiplier'>, pos: Pick<ReplayPosition, 'qty' | 'avg'>, s: TickSample): number {
  if (pos.qty === 0) return 0;
  const mark = pos.qty > 0 ? s[1] : s[2];
  return pos.qty * (mark - pos.avg) * spec.multiplier;
}

/** Worst and best open P&L while in the position, from the first fill up to t. */
export function openPnlRange(path: TickSample[], fills: Fill[], spec: Pick<InstrumentSpec, 'multiplier'>, t: number): { worst: number; best: number } {
  let worst = 0;
  let best = 0;
  if (!fills.length || fills[0].ts > t) return { worst, best };
  for (let i = Math.max(0, indexAtOrBefore(path, fills[0].ts)); i < path.length && path[i][0] <= t; i++) {
    const pos = positionAt(fills, path[i][0]);
    if (pos.qty === 0) continue;
    const pnl = openPnlAt(spec, pos, path[i]);
    worst = Math.min(worst, pnl);
    best = Math.max(best, pnl);
  }
  return { worst, best };
}

/** Stop / target in force at t (null before the first record). */
export function bracketAt(brackets: BracketChange[], t: number): BracketChange | null {
  let out: BracketChange | null = null;
  for (const b of brackets) {
    if (b.ts > t) break;
    out = b;
  }
  return out;
}

/** A speed that plays the whole window in about a minute. */
export function defaultSpeed(windowMs: number): number {
  const want = windowMs / 60_000;
  return REPLAY_SPEEDS.find((s) => s >= want) ?? REPLAY_SPEEDS[REPLAY_SPEEDS.length - 1];
}

/** Bar size for the window: 5 s bars for a few minutes, up to 5 min bars for long trades (≥ 1 min from bars). */
export function defaultResolution(windowMs: number, barsOnly: boolean): number {
  const m = windowMs / 60_000;
  const r = m <= 8 ? 5 : m <= 25 ? 15 : m <= 60 ? 30 : m <= 240 ? 60 : 300;
  return barsOnly ? Math.max(60, r) : r;
}
