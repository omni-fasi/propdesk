// Gap detection: (a) process suspend — a 1 s interval timer firing much too late; (b) provider outages.
// A gap is reported once, after data resumes from every provider that was affected.

import type { Clock, TimerHandle } from './clock.ts';
import type { MarketGap } from './types.ts';

export class SuspendDetector {
  private readonly clock: Clock;
  private readonly onSuspend: (fromMs: number, toMs: number) => void;
  private readonly intervalMs: number;
  private readonly lateMs: number;
  private timer: TimerHandle | null = null;
  private last = 0;

  constructor(clock: Clock, onSuspend: (fromMs: number, toMs: number) => void, o: { intervalMs?: number; lateMs?: number } = {}) {
    this.clock = clock;
    this.onSuspend = onSuspend;
    this.intervalMs = o.intervalMs ?? 1000;
    this.lateMs = o.lateMs ?? 5000;
  }

  start(): void {
    if (this.timer != null) return;
    this.last = this.clock.now();
    this.timer = this.clock.setInterval(() => this.check(), this.intervalMs);
  }

  stop(): void {
    if (this.timer != null) this.clock.clearInterval(this.timer);
    this.timer = null;
  }

  check(): void {
    const now = this.clock.now();
    const from = this.last;
    this.last = now;
    if (now - from > this.intervalMs + this.lateMs) this.onSuspend(from, now);
  }
}

export interface GapSource {
  readonly name: string;
  /** Has subscriptions, i.e. data is expected from it. */
  active(): boolean;
  /** Data has been flowing again since `markMs`. */
  resumedSince(markMs: number, now: number): boolean;
}

interface PendingGap {
  fromMs: number;
  /** Source → time after which it must show data again. */
  waiting: Map<string, number>;
  firstResumeAt: number | null;
  symbols: Set<string>;
}

export interface GapTrackerOptions {
  clock: Clock;
  sources: GapSource[];
  retained: () => string[];
  emit: (gap: MarketGap) => void;
  /** Shorter interruptions are ignored. */
  minGapMs?: number;
  /** Once one source is back, wait at most this long for the others before reporting. */
  settleMs?: number;
}

export class GapTracker {
  private readonly o: Required<GapTrackerOptions>;
  private pending: PendingGap | null = null;

  constructor(o: GapTrackerOptions) {
    this.o = { minGapMs: 5000, settleMs: 20_000, ...o };
  }

  get isPending(): boolean {
    return this.pending != null;
  }

  /** The process was suspended between fromMs and toMs: every active source has to resume. */
  suspended(fromMs: number, toMs: number): void {
    const sources = this.o.sources.filter((s) => s.active()).map((s) => s.name);
    this.open(fromMs, toMs, sources);
    if (!sources.length) this.finish(toMs);
  }

  /** A source stopped delivering data at sinceMs. */
  down(source: string, sinceMs: number): void {
    this.open(sinceMs, this.o.clock.now(), [source]);
  }

  /** Called periodically (and cheaply when nothing is pending). */
  tick(now = this.o.clock.now()): void {
    const p = this.pending;
    if (!p) return;
    for (const [name, mark] of p.waiting) {
      const src = this.o.sources.find((s) => s.name === name);
      if (!src || !src.active() || src.resumedSince(mark, now)) {
        p.waiting.delete(name);
        p.firstResumeAt ??= now;
      }
    }
    if (!p.waiting.size || (p.firstResumeAt != null && now - p.firstResumeAt >= this.o.settleMs)) this.finish(now);
  }

  private open(fromMs: number, markMs: number, sources: string[]): void {
    const p = (this.pending ??= { fromMs, waiting: new Map(), firstResumeAt: null, symbols: new Set() });
    p.fromMs = Math.min(p.fromMs, fromMs);
    for (const s of sources) p.waiting.set(s, Math.max(p.waiting.get(s) ?? 0, markMs));
    for (const s of this.o.retained()) p.symbols.add(s);
  }

  private finish(now: number): void {
    const p = this.pending;
    this.pending = null;
    if (!p || now - p.fromMs < this.o.minGapMs) return;
    for (const s of this.o.retained()) p.symbols.add(s);
    this.o.emit({ fromMs: p.fromMs, toMs: now, symbols: [...p.symbols].sort() });
  }
}
