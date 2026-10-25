// Small fetch helpers: timeouts, typed HTTP errors, and a concurrency/spacing limited queue.

import type { Clock, TimerHandle } from './clock.ts';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;
  /** From a Retry-After header, when present. */
  readonly retryAfterMs: number | null;

  constructor(status: number, url: string, body: string, retryAfterMs: number | null = null) {
    super(`HTTP ${status} ${url.replace(/\?.*$/, '')}${body ? `: ${body.slice(0, 160)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface GetOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function getJson<T = unknown>(fetchFn: FetchFn, url: string, o: GetOptions = {}): Promise<T> {
  const timeout = AbortSignal.timeout(o.timeoutMs ?? 15_000);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  const res = await fetchFn(url, { headers: o.headers, signal });
  const text = await res.text();
  if (!res.ok) {
    const ra = Number(res.headers.get('retry-after'));
    throw new HttpError(res.status, url, text, Number.isFinite(ra) && ra > 0 ? ra * 1000 : null);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON from ${url.replace(/\?.*$/, '')}`);
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.name === 'TimeoutError' ? 'request timed out' : e.message;
  return String(e);
}

/** Runs async jobs with at most `max` in flight and at least `spacingMs` between job starts. */
export class RequestQueue {
  private readonly max: number;
  private readonly spacingMs: number;
  private readonly clock: Clock;
  private active = 0;
  private lastStart = -Infinity;
  private waiting: Array<{ start: () => void; reject: (e: unknown) => void }> = [];
  private timer: TimerHandle | null = null;

  constructor(max: number, spacingMs: number, clock: Clock) {
    this.max = max;
    this.spacingMs = spacingMs;
    this.clock = clock;
  }

  run<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++;
        this.lastStart = this.clock.now();
        let p: Promise<T>;
        try {
          p = job();
        } catch (e) {
          p = Promise.reject(e);
        }
        p.then(resolve, reject).finally(() => {
          this.active--;
          this.pump();
        });
      };
      this.waiting.push({ start, reject });
      this.pump();
    });
  }

  /** Reject everything that has not started yet. */
  clear(reason: unknown): void {
    if (this.timer != null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    for (const w of this.waiting.splice(0)) w.reject(reason);
  }

  private pump(): void {
    while (this.active < this.max && this.waiting.length) {
      const wait = this.lastStart + this.spacingMs - this.clock.now();
      if (wait > 0) {
        if (this.timer == null) {
          this.timer = this.clock.setTimeout(() => {
            this.timer = null;
            this.pump();
          }, wait);
        }
        return;
      }
      this.waiting.shift()!.start();
    }
  }
}
