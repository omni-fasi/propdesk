// Tick recorder for trade replays. Every quoted symbol is sampled 4× a second (only when bid/ask moved);
// the last few minutes stay in memory, and once a position opens in a symbol its samples are written to
// the database — the in-memory pre-roll first, then live until a few minutes after the position closes.

import type { Quote, TickSample } from '../../../shared/types.ts';
import type { Logger, MarketHub } from '../market/types.ts';
import type { Store } from '../store.ts';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export interface TickRecorderOptions {
  market: MarketHub;
  store: Store;
  now: () => number;
  /** Symbols to record right now: those with an open position on any account. */
  activeSymbols: () => ReadonlySet<string>;
  log: Logger;
  /** Sampling period (default 250 ms). */
  sampleMs?: number;
  /** In-memory history per symbol, written when a position opens (default 10 min). */
  preRollMs?: number;
  /** Recording continues this long after the last position in a symbol closes (default 3 min). */
  postRollMs?: number;
  /** Write batching period (default 2 s). */
  flushMs?: number;
  /** Samples older than this are deleted (default 120 days). */
  retentionMs?: number;
}

export class TickRecorder {
  private readonly store: Store;
  private readonly now: () => number;
  private readonly activeSymbols: () => ReadonlySet<string>;
  private readonly log: Logger;
  private readonly sampleMs: number;
  private readonly preRollMs: number;
  private readonly postRollMs: number;
  private readonly flushMs: number;
  private readonly retentionMs: number;
  /** Newest quote per symbol since the last sample. */
  private latest = new Map<string, Quote>();
  /** Last sample taken per symbol. */
  private last = new Map<string, TickSample>();
  /** Recent samples not written yet (the pre-roll). */
  private ring = new Map<string, TickSample[]>();
  /** symbol → record until (Infinity while a position is open). */
  private recording = new Map<string, number>();
  private pending: Array<[string, TickSample]> = [];
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private unsub: (() => void) | null;

  constructor(o: TickRecorderOptions) {
    this.store = o.store;
    this.now = o.now;
    this.activeSymbols = o.activeSymbols;
    this.log = o.log;
    this.sampleMs = o.sampleMs ?? 250;
    this.preRollMs = o.preRollMs ?? 10 * MIN;
    this.postRollMs = o.postRollMs ?? 3 * MIN;
    this.flushMs = o.flushMs ?? 2_000;
    this.retentionMs = o.retentionMs ?? 120 * DAY;
    this.unsub = o.market.onQuote((q) => this.latest.set(q.symbol, q));
  }

  /** Start the sampling / write / cleanup timers (tests call sample() and flush() directly). */
  start(): void {
    if (this.timers.length) return;
    this.prune();
    this.timers.push(setInterval(() => this.sample(), this.sampleMs));
    this.timers.push(setInterval(() => this.flush(), this.flushMs));
    this.timers.push(setInterval(() => this.prune(), 6 * 60 * MIN));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.unsub?.();
    this.unsub = null;
    this.sample();
    this.flush();
  }

  /** One sampling step: update which symbols record, then sample every symbol whose bid/ask moved. */
  sample(): void {
    const t = this.now();
    const active = this.activeSymbols();
    for (const s of active) {
      if (this.recording.get(s) === Infinity) continue;
      if (!this.recording.has(s)) {
        for (const x of this.ring.get(s) ?? []) this.pending.push([s, x]);
        this.ring.delete(s);
      }
      this.recording.set(s, Infinity);
    }
    for (const [s, until] of this.recording) {
      if (active.has(s)) continue;
      if (until === Infinity) this.recording.set(s, t + this.postRollMs);
      else if (t > until) this.recording.delete(s);
    }

    for (const [s, q] of this.latest) {
      if (!(q.bid > 0 && q.ask > 0 && q.ask >= q.bid)) continue;
      const prev = this.last.get(s);
      if (prev && prev[1] === q.bid && prev[2] === q.ask) continue;
      const ts = Math.max(prev ? prev[0] + 1 : 0, Number.isFinite(q.ts) ? Math.min(q.ts, t) : t);
      const tick: TickSample = [ts, q.bid, q.ask];
      this.last.set(s, tick);
      if (this.recording.has(s)) {
        this.pending.push([s, tick]);
        continue;
      }
      let ring = this.ring.get(s);
      if (!ring) this.ring.set(s, (ring = []));
      ring.push(tick);
      let drop = 0;
      while (drop < ring.length && ring[drop][0] < t - this.preRollMs) drop++;
      if (drop) ring.splice(0, drop);
    }
    this.latest.clear();
  }

  flush(): void {
    if (!this.pending.length) return;
    const rows = this.pending;
    this.pending = [];
    try {
      this.store.tx(() => this.store.insertTicks(rows));
    } catch (err) {
      this.log.warn('replay: writing %d ticks failed: %s', rows.length, err instanceof Error ? err.message : String(err));
    }
  }

  prune(): void {
    try {
      const n = this.store.deleteTicksBefore(this.now() - this.retentionMs);
      if (n) this.log.info('replay: deleted %d old ticks', n);
    } catch (err) {
      this.log.warn('replay: pruning ticks failed: %s', err instanceof Error ? err.message : String(err));
    }
  }
}
