// Candle helpers: bucketing, aggregation, live overlay, tick → 1m bars, presentation, caches.
// Everything here works in feed time (unshifted); the hub applies the delay shift on the way out.

import type { Candle, InstrumentSpec, Timeframe, ZonedTime } from '../../../shared/types.ts';
import { TIMEFRAME_SECONDS } from '../../../shared/types.ts';
import { roundPrice } from '../../../shared/risk.ts';
import { parseDayKey, tradingDayOf } from '../../../shared/time.ts';

export const UTC_MIDNIGHT: ZonedTime = { hour: 0, minute: 0, tz: 'UTC' };

/**
 * Open time (seconds) of the `tf` bar containing `timeSec`. Intraday bars sit on the UTC epoch grid
 * (Binance, and Yahoo's hour-aligned futures/FX bars); daily bars are the trading day of `dayRule`,
 * labelled 00:00 UTC of that day.
 */
export function bucketStart(tf: Timeframe, timeSec: number, dayRule: ZonedTime = UTC_MIDNIGHT): number {
  if (tf !== '1d') {
    const step = TIMEFRAME_SECONDS[tf];
    return Math.floor(timeSec / step) * step;
  }
  if (dayRule.tz === 'UTC' && dayRule.hour === 0 && dayRule.minute === 0) return Math.floor(timeSec / 86400) * 86400;
  const { year, month, day } = parseDayKey(tradingDayOf(timeSec * 1000, dayRule));
  return Date.UTC(year, month - 1, day) / 1000;
}

/** Fold a later bar of the same bucket into an earlier one. */
export function mergeInto(a: Candle, b: Candle, volume: 'add' | 'max' | 'keep' = 'add'): Candle {
  return {
    time: a.time,
    open: a.open,
    high: Math.max(a.high, b.high),
    low: Math.min(a.low, b.low),
    close: b.close,
    volume: volume === 'add' ? a.volume + b.volume : volume === 'max' ? Math.max(a.volume, b.volume) : a.volume,
  };
}

/** Aggregate ascending finer bars into `tf` buckets (1m → 5m/15m/1h…, 1h → 4h). */
export function aggregate(bars: Candle[], tf: Timeframe, dayRule?: ZonedTime): Candle[] {
  const out: Candle[] = [];
  for (const b of bars) {
    const t = bucketStart(tf, b.time, dayRule);
    const last = out[out.length - 1];
    if (last && last.time === t) out[out.length - 1] = mergeInto(last, b);
    else if (!last || t > last.time) out.push({ ...b, time: t });
  }
  return out;
}

/**
 * Bring cached history up to date with the live 1m bars received since it was fetched.
 * `coveredSec`: feed time up to which `hist` is complete. The live bar of that minute only extends
 * high/low/close (its volume is partly counted already); later minutes also add their volume.
 */
export function overlayLive(hist: Candle[], live: Candle[], tf: Timeframe, coveredSec: number, dayRule?: ZonedTime): Candle[] {
  const firstMinute = Math.floor(coveredSec / 60) * 60;
  const out = hist.slice();
  for (const l of live) {
    if (l.time < firstMinute) continue;
    const t = bucketStart(tf, l.time, dayRule);
    const last = out[out.length - 1];
    if (!last || t > last.time) out.push({ ...l, time: t });
    else if (t === last.time) {
      if (tf === '1m') out[out.length - 1] = mergeInto(last, l, 'max');
      else out[out.length - 1] = mergeInto(last, l, l.time > firstMinute ? 'add' : 'keep');
    }
    // t < last.time: older than the cached tail; history wins.
  }
  return out;
}

const roundVol = (v: number) => Math.round(v * 1e6) / 1e6;

/** Feed bar → app bar: shifted by the feed delay and rounded to the instrument tick. */
export function presentBar(c: Candle, spec: InstrumentSpec, shiftSec: number): Candle {
  return {
    time: c.time + shiftSec,
    open: roundPrice(spec, c.open),
    high: roundPrice(spec, c.high),
    low: roundPrice(spec, c.low),
    close: roundPrice(spec, c.close),
    volume: roundVol(c.volume),
  };
}

/** Builds live 1m bars from trade ticks; volume comes from deltas of the cumulative day volume. */
export class LiveBarBuilder {
  bar: Candle | null = null;
  private dayVolume: number | null = null;

  /** Apply a price tick. Returns the updated bar, or null for a tick older than the current bar. */
  tick(tsMs: number, price: number, dayVolume?: number | null): Candle | null {
    let dv = 0;
    if (dayVolume != null && Number.isFinite(dayVolume)) {
      // A drop means the session counter was reset: re-baseline, never add negative volume.
      if (this.dayVolume != null && dayVolume > this.dayVolume) dv = dayVolume - this.dayVolume;
      this.dayVolume = dayVolume;
    }
    const t = Math.floor(tsMs / 60_000) * 60;
    const b = this.bar;
    if (!b || t > b.time) this.bar = { time: t, open: price, high: price, low: price, close: price, volume: dv };
    else if (t === b.time) this.bar = { time: t, open: b.open, high: Math.max(b.high, price), low: Math.min(b.low, price), close: price, volume: b.volume + dv };
    else return null;
    return this.bar;
  }

  /** Adopt a bar from another source (REST snapshot / chart poll) when it is at least as recent. */
  set(c: Candle): void {
    if (!this.bar || c.time >= this.bar.time) this.bar = { ...c };
  }
}

/** Size-bounded LRU map whose entries expire (but stay readable as stale until evicted). */
export class TtlCache<V> {
  private readonly max: number;
  private map = new Map<string, { value: V; expires: number }>();

  constructor(max: number) {
    this.max = max;
  }

  get(key: string, now: number): { value: V; fresh: boolean } | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return { value: e.value, fresh: now < e.expires };
  }

  set(key: string, value: V, ttlMs: number, now: number): void {
    this.map.delete(key);
    this.map.set(key, { value, expires: now + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }

  deleteWhere(pred: (key: string) => boolean): void {
    for (const k of [...this.map.keys()]) if (pred(k)) this.map.delete(k);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/** Share one in-flight promise between concurrent identical requests. */
export function shared<T>(inflight: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> {
  let p = inflight.get(key);
  if (!p) {
    p = run().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}
