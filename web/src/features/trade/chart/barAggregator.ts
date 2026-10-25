// Keeps the chart's bar array current from live 1m candles and quotes, for any timeframe.
//
// - New bars are placed on the grid of the history (last bar time + k·tf), so provider-specific
//   alignments (daily bars at 00:00 ET vs UTC, 4h aggregated from 1h…) are respected.
// - Volume of the forming bar = base + Σ per-minute contributions. A live 1m candle repeats with the
//   cumulative volume of its minute; minutes that were already (partly) included in the history count
//   only their growth since we first saw them, so nothing is counted twice.

import type { Candle } from '@shared/types';

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface MinuteVol {
  first: number;
  last: number;
  /** The minute had started when the history was loaded (its volume is partly in `base`). */
  pre: boolean;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Sort, de-duplicate (last wins) and drop malformed candles — lightweight-charts throws on bad data. */
export function sanitize(candles: Candle[]): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const c of candles) {
    if (!c || !finite(c.time) || !finite(c.open) || !finite(c.high) || !finite(c.low) || !finite(c.close)) continue;
    const high = Math.max(c.high, c.open, c.close);
    const low = Math.min(c.low, c.open, c.close);
    byTime.set(Math.floor(c.time), { time: Math.floor(c.time), open: c.open, high, low, close: c.close, volume: finite(c.volume) && c.volume > 0 ? c.volume : 0 });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export class BarAggregator {
  readonly tf: number;
  bars: Bar[];
  private loadedAt: number;
  private trackTime = Number.NaN;
  private base = 0;
  private fromHistory = false;
  private fromQuote = false;
  private minutes = new Map<number, MinuteVol>();

  constructor(tfSec: number, bars: Bar[], loadedAtSec: number) {
    this.tf = tfSec;
    this.bars = bars;
    this.loadedAt = loadedAtSec;
    const last = bars[bars.length - 1];
    if (last) this.track(last, true, false);
  }

  get last(): Bar | undefined {
    return this.bars[this.bars.length - 1];
  }

  /** Older history was loaded: put it in front (drops overlaps). Returns how many bars were added. */
  prepend(older: Bar[]): number {
    const first = this.bars[0];
    const add = first ? older.filter((b) => b.time < first.time) : older;
    if (add.length) this.bars = [...add, ...this.bars];
    return add.length;
  }

  private track(bar: Bar, fromHistory: boolean, fromQuote: boolean): void {
    this.trackTime = bar.time;
    this.base = fromHistory ? bar.volume : 0;
    this.fromHistory = fromHistory;
    this.fromQuote = fromQuote;
    this.minutes.clear();
  }

  private bucketStart(t: number): number {
    const last = this.last;
    if (!last) return Math.floor(t / this.tf) * this.tf;
    return last.time + Math.floor((t - last.time) / this.tf) * this.tf;
  }

  private volume(): number {
    let v = this.base;
    for (const m of this.minutes.values()) v += m.pre ? Math.max(0, m.last - m.first) : m.last;
    return v;
  }

  /**
   * Merge a live 1m candle. Returns the bar to draw and whether it is a new bar, or null when the
   * candle belongs to an older bar (ignored).
   */
  applyMinute(c: Candle): { bar: Bar; isNew: boolean } | null {
    if (!finite(c.time) || !finite(c.close) || !finite(c.high) || !finite(c.low) || !finite(c.open)) return null;
    const vol = finite(c.volume) && c.volume > 0 ? c.volume : 0;
    const last = this.last;
    if (last && c.time < last.time) return null;
    const start = this.bucketStart(c.time);
    let isNew = false;
    let bar: Bar;
    if (last && start === last.time) {
      bar = last;
      if (this.trackTime !== bar.time) this.track(bar, false, false);
      if (this.fromQuote && c.time === bar.time && this.minutes.size === 0) {
        // Bar was opened from a quote; the first minute candle knows the true open.
        bar.open = c.open;
      }
      bar.high = Math.max(bar.high, c.high);
      bar.low = Math.min(bar.low, c.low);
      bar.close = c.close;
    } else {
      bar = { time: start, open: c.open, high: c.high, low: c.low, close: c.close, volume: 0 };
      this.bars.push(bar);
      this.track(bar, false, false);
      isNew = true;
    }
    const m = this.minutes.get(c.time);
    if (m) m.last = Math.max(m.last, vol);
    else this.minutes.set(c.time, { first: vol, last: vol, pre: this.fromHistory && c.time <= this.loadedAt });
    bar.volume = this.volume();
    return { bar, isNew };
  }

  /** Nudge the forming bar from a live price (smoother than waiting for the next candle message). */
  applyPrice(price: number, tsSec: number): { bar: Bar; isNew: boolean } | null {
    if (!finite(price) || price <= 0 || !finite(tsSec)) return null;
    const last = this.last;
    if (!last) return null;
    if (tsSec < last.time) return null;
    const start = this.bucketStart(tsSec);
    if (start === last.time) {
      last.close = price;
      if (price > last.high) last.high = price;
      if (price < last.low) last.low = price;
      return { bar: last, isNew: false };
    }
    const bar: Bar = { time: start, open: price, high: price, low: price, close: price, volume: 0 };
    this.bars.push(bar);
    this.track(bar, false, true);
    return { bar, isNew: true };
  }
}

/** Index of the last bar with time ≤ t (binary search), or -1. */
export function barIndexAt(bars: Bar[], t: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
