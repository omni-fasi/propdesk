// Per-feed data delay detection: median of (now − quote time) while the market is open, rounded to
// whole minutes, with hysteresis so the applied time-shift does not flap.

export interface DelayOptions {
  /** Samples kept for the median. */
  window?: number;
  /** Samples older than this are dropped (ms). */
  maxAgeMs?: number;
  /** Larger lags mean "no recent trade" (e.g. right after the open), not a feed delay; ignored (ms). */
  maxLagMs?: number;
  /** A different estimate must persist this long before it replaces the applied delay (ms). */
  holdMs?: number;
  /** For the first N samples the estimate is applied immediately (start-up / provisional values). */
  warmup?: number;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Delay in whole minutes (as seconds) for a median lag; sub-30 s lags are latency, not delay. */
export function roundDelay(lagMs: number): number {
  if (lagMs < 30_000) return 0;
  return Math.round(lagMs / 60_000) * 60;
}

export class DelayDetector {
  /** Applied delay in seconds (0 = real time). */
  delaySec = 0;
  /** Whether any live sample has been seen (a preset value is provisional). */
  known = false;

  private readonly window: number;
  private readonly maxAgeMs: number;
  private readonly maxLagMs: number;
  private readonly holdMs: number;
  private readonly warmup: number;
  private samples: Array<{ lag: number; at: number }> = [];
  private total = 0;
  private candidate: { sec: number; since: number } | null = null;
  private evaluatedAt = -Infinity;

  constructor(o: DelayOptions = {}) {
    this.window = o.window ?? 41;
    this.maxAgeMs = o.maxAgeMs ?? 10 * 60_000;
    this.maxLagMs = o.maxLagMs ?? 30 * 60_000;
    this.holdMs = o.holdMs ?? 90_000;
    this.warmup = o.warmup ?? 8;
  }

  /** A provisional delay (persisted from an earlier run, or a REST snapshot), used until live samples arrive. */
  preset(sec: number): boolean {
    if (this.known || sec === this.delaySec) return false;
    this.delaySec = sec;
    return true;
  }

  /** Record the lag of a live price observed while its market is open. Returns true when delaySec changed. */
  addSample(lagMs: number, now: number): boolean {
    if (!Number.isFinite(lagMs) || lagMs > this.maxLagMs) return false;
    this.samples.push({ lag: lagMs, at: now });
    this.total++;
    while (this.samples.length > this.window || now - this.samples[0].at > this.maxAgeMs) this.samples.shift();
    // Evaluate at most once per second once warmed up (Binance can deliver 100+ ticks/s).
    if (this.total > this.warmup && now - this.evaluatedAt < 1000) return false;
    this.evaluatedAt = now;
    return this.evaluate(now);
  }

  /** Current (unapplied) estimate in seconds, or null without samples. */
  estimate(): number | null {
    if (!this.samples.length) return null;
    return roundDelay(median(this.samples.map((s) => s.lag)));
  }

  private evaluate(now: number): boolean {
    const est = this.estimate();
    if (est == null) return false;
    if (!this.known || this.total <= this.warmup) {
      this.known = true;
      this.candidate = null;
      return this.apply(est);
    }
    if (est === this.delaySec) {
      this.candidate = null;
      return false;
    }
    if (!this.candidate || this.candidate.sec !== est) {
      this.candidate = { sec: est, since: now };
      return false;
    }
    if (now - this.candidate.since < this.holdMs) return false;
    this.candidate = null;
    return this.apply(est);
  }

  private apply(sec: number): boolean {
    if (sec === this.delaySec) return false;
    this.delaySec = sec;
    return true;
  }
}
