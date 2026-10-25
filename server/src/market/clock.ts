// Injectable time source and timers, so the market layer can be driven by a manual clock in tests.

export type TimerHandle = unknown;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

/** Real time. Timers are unref'd: the market layer alone never keeps the process alive. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  setInterval(fn, ms) {
    const t = setInterval(fn, ms);
    t.unref();
    return t;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

interface ManualTimer {
  id: number;
  due: number;
  interval: number | null;
  fn: () => void;
}

/** Deterministic clock for tests: time only moves with advance() / jump(). */
export class ManualClock implements Clock {
  t: number;
  private timers = new Map<number, ManualTimer>();
  private nextId = 1;

  constructor(start: number) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { id, due: this.t + Math.max(0, ms), interval: null, fn });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    const every = Math.max(1, ms);
    this.timers.set(id, { id, due: this.t + every, interval: every, fn });
    return id;
  }

  clearInterval(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  /** Move time forward by `ms`, firing due timers in chronological order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: ManualTimer | null = null;
      for (const tm of this.timers.values()) {
        if (tm.due <= end && (!next || tm.due < next.due || (tm.due === next.due && tm.id < next.id))) next = tm;
      }
      if (!next) break;
      this.t = Math.max(this.t, next.due);
      if (next.interval != null) next.due = this.t + next.interval;
      else this.timers.delete(next.id);
      next.fn();
    }
    this.t = end;
  }

  /** Jump forward without firing anything, like a suspended process. Overdue timers fire once on the next advance(). */
  jump(ms: number): void {
    this.t += ms;
  }

  pendingTimers(): number {
    return this.timers.size;
  }
}
