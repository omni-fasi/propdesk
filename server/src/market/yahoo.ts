// Yahoo Finance provider (CME futures, forex): streamer WebSocket for live prices, chart API for
// snapshots, history and a polling fallback while the streamer is silent for an open market.

import type { Candle, FeedProvider, Timeframe, ZonedTime } from '../../../shared/types.ts';
import { isMarketOpen } from '../../../shared/time.ts';
import { aggregate, bucketStart, mergeInto } from './candles.ts';
import type { Clock, TimerHandle } from './clock.ts';
import { errorMessage, getJson, HttpError, RequestQueue, type FetchFn } from './http.ts';
import type { FeedRef, FeedTick, Provider, ProviderSink, ProviderStatus } from './provider.ts';
import { ReconnectingSocket, type CloseInfo, type SocketFactory } from './socket.ts';
import type { Logger } from './types.ts';
import { decodeStreamerFrame, type PricingData } from './yahooProto.ts';

export const YAHOO_WS_URL = 'wss://streamer.finance.yahoo.com/?version=2';
export const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const DAY = 86_400;

/** Chart API interval per timeframe and how far back Yahoo serves it (verified 2026-10: 1m ≤ 8 days per request within 30 days, 5m/15m 60 days, 1h 730 days). */
const INTERVALS: Record<Timeframe, { interval: string; step: number; maxAgeSec: number | null; windowSec: number | null }> = {
  '1m': { interval: '1m', step: 60, maxAgeSec: 29.5 * DAY, windowSec: 7 * DAY },
  '5m': { interval: '5m', step: 300, maxAgeSec: 59.5 * DAY, windowSec: null },
  '15m': { interval: '15m', step: 900, maxAgeSec: 59.5 * DAY, windowSec: null },
  '1h': { interval: '60m', step: 3600, maxAgeSec: 729 * DAY, windowSec: null },
  '4h': { interval: '60m', step: 3600, maxAgeSec: 729 * DAY, windowSec: null }, // aggregated from 1h
  '1d': { interval: '1d', step: DAY, maxAgeSec: null, windowSec: null },
};

// ───────────────────────────── Chart API ─────────────────────────────

export interface ChartMeta {
  symbol?: string;
  regularMarketPrice?: number;
  /** Seconds. */
  regularMarketTime?: number;
  previousClose?: number;
  chartPreviousClose?: number;
  exchangeTimezoneName?: string;
  priceHint?: number;
}

export interface ChartData {
  meta: ChartMeta;
  bars: Candle[];
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * Parse a v8 chart response into clean ascending bars. Rows with null prices are skipped, rows outside
 * [fromSec, toSec) dropped (Yahoo appends the live price even past the requested end), intraday times are
 * floored to the interval and daily ones normalized to the trading day of `dayRule`. Yahoo also repeats the
 * current bar as an unaligned "live" row; rows landing in the same bucket are merged.
 */
export function parseChart(json: unknown, stepSec: number, opts: { fromSec?: number; toSec?: number; dayRule?: ZonedTime } = {}): ChartData {
  type Result = { meta?: ChartMeta; timestamp?: unknown[]; indicators?: { quote?: Array<Record<string, unknown[] | undefined>> } };
  const chart = (json as { chart?: { result?: Result[] | null; error?: { code?: string; description?: string } | null } } | null)?.chart;
  const result = chart?.result?.[0];
  if (!result) throw new Error(`Yahoo chart: ${chart?.error?.description ?? chart?.error?.code ?? 'empty response'}`);
  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const bars: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    if (!isNum(t) || !isNum(o) || !isNum(h) || !isNum(l) || !isNum(c) || c <= 0) continue;
    if (opts.fromSec != null && t < opts.fromSec) continue;
    if (opts.toSec != null && t >= opts.toSec) continue;
    const time = stepSec >= DAY ? bucketStart('1d', t, opts.dayRule) : Math.floor(t / stepSec) * stepSec;
    const v = q.volume?.[i];
    const bar: Candle = { time, open: o, high: Math.max(h, o, c), low: Math.min(l, o, c), close: c, volume: isNum(v) && v > 0 ? v : 0 };
    const last = bars[bars.length - 1];
    if (last && last.time === time) bars[bars.length - 1] = mergeInto(last, bar, 'max');
    else if (!last || time > last.time) bars.push(bar);
  }
  return { meta: result.meta ?? {}, bars };
}

function yahooError(e: HttpError): Error {
  try {
    const j = JSON.parse(e.body) as { chart?: { error?: { description?: string } } };
    const d = j.chart?.error?.description;
    if (d) return new Error(`Yahoo ${e.status}: ${d}`);
  } catch {
    // not JSON
  }
  return e;
}

export type YahooProfile = 'browser' | 'plain';

export interface YahooHttpOptions {
  fetch: FetchFn;
  clock: Clock;
  log: Logger;
  signal: AbortSignal;
  userAgent?: string;
  hosts?: string[];
  /** Header profiles tried in order. 'browser' = browser UA + Yahoo cookie, 'plain' = runtime defaults. */
  profiles?: YahooProfile[];
  maxConcurrent?: number;
  spacingMs?: number;
}

/**
 * Chart API client. Yahoo's bot filter answers 429 per client fingerprint: a browser UA (with the A3
 * cookie from fc.yahoo.com) usually passes, while the runtime's default UA sits in a separate bucket.
 * On 429 a profile cools down (2 min, doubling) and the next one is used.
 */
export class YahooHttp {
  private readonly o: YahooHttpOptions;
  private readonly ua: string;
  private readonly hosts: string[];
  private readonly profiles: Array<{ name: YahooProfile; cooldownUntil: number; strikes: number }>;
  private readonly queue: RequestQueue;
  private preferred = 0;
  private cookie: string | null = null;
  private cookieAt = -Infinity;
  private cookieTask: Promise<void> | null = null;

  constructor(o: YahooHttpOptions) {
    this.o = o;
    this.ua = o.userAgent ?? BROWSER_UA;
    this.hosts = o.hosts ?? ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
    this.profiles = (o.profiles ?? ['browser', 'plain']).map((name) => ({ name, cooldownUntil: -Infinity, strikes: 0 }));
    this.queue = new RequestQueue(o.maxConcurrent ?? 2, o.spacingMs ?? 150, o.clock);
  }

  chart(symbol: string, params: Record<string, string | number>): Promise<unknown> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
    const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`;
    return this.queue.run(() => this.request(path));
  }

  /** Every profile is cooling down after 429s. */
  rateLimited(now = this.o.clock.now()): boolean {
    return this.profiles.every((p) => p.cooldownUntil > now);
  }

  close(): void {
    this.queue.clear(new Error('market data stopped'));
  }

  private async request(path: string): Promise<unknown> {
    let lastErr: unknown = null;
    let host = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      const idx = this.pick(this.o.clock.now());
      if (idx < 0) throw lastErr ?? new Error('Yahoo rate limit (429), cooling down');
      const profile = this.profiles[idx];
      const headers = profile.name === 'browser' ? await this.browserHeaders() : {};
      try {
        const json = await getJson(this.o.fetch, `https://${this.hosts[host % this.hosts.length]}${path}`, { headers, signal: this.o.signal, timeoutMs: 15_000 });
        profile.strikes = 0;
        this.preferred = idx;
        return json;
      } catch (e) {
        lastErr = e;
        if (this.o.signal.aborted) throw e;
        if (e instanceof HttpError && e.status === 429) {
          profile.strikes++;
          profile.cooldownUntil = this.o.clock.now() + Math.min(60 * 60_000, 2 * 60_000 * 2 ** (profile.strikes - 1));
          this.o.log.debug(`[yahoo] 429 with the ${profile.name} profile, cooling it down`);
          continue;
        }
        if (e instanceof HttpError && e.status < 500) throw yahooError(e);
        // Network error / 5xx: try the other host once.
        if (++host >= 2) throw e;
      }
    }
    throw lastErr;
  }

  private pick(now: number): number {
    for (let i = 0; i < this.profiles.length; i++) {
      const idx = (this.preferred + i) % this.profiles.length;
      if (this.profiles[idx].cooldownUntil <= now) return idx;
    }
    return -1;
  }

  private async browserHeaders(): Promise<Record<string, string>> {
    if (this.o.clock.now() - this.cookieAt > 6 * 3600_000 && !this.cookieTask) {
      this.cookieTask = this.fetchCookie().finally(() => {
        this.cookieTask = null;
      });
    }
    if (this.cookieTask && this.cookie == null) await this.cookieTask;
    const h: Record<string, string> = { 'User-Agent': this.ua, Accept: '*/*' };
    if (this.cookie) h.Cookie = this.cookie;
    return h;
  }

  private async fetchCookie(): Promise<void> {
    this.cookieAt = this.o.clock.now();
    try {
      const res = await this.o.fetch('https://fc.yahoo.com/', {
        headers: { 'User-Agent': this.ua },
        redirect: 'manual',
        signal: AbortSignal.any([this.o.signal, AbortSignal.timeout(10_000)]),
      });
      await res.arrayBuffer().catch(() => undefined);
      const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      const cookies = raw.map((c) => c.split(';')[0].trim()).filter((c) => /^A(1|3|1S)=/.test(c));
      if (cookies.length) this.cookie = cookies.join('; ');
    } catch (e) {
      this.o.log.debug(`[yahoo] cookie request failed: ${errorMessage(e)}`);
    }
  }
}

// ───────────────────────────── Provider ─────────────────────────────

export interface YahooProviderOptions {
  clock: Clock;
  log: Logger;
  fetch: FetchFn;
  socketFactory: SocketFactory;
  wsUrl?: string;
  hosts?: string[];
  userAgent?: string;
  profiles?: YahooProfile[];
  /** Streamer silence for a symbol (market open) after which the chart API is polled. */
  silentMs?: number;
  /** Poll period per symbol; stretched when many symbols poll at once. */
  pollMs?: number;
  /** Reconnect when the streamer sent nothing for this long while a subscribed market is open. */
  watchdogMs?: number;
  requestSpacingMs?: number;
  random?: () => number;
}

interface YFeed {
  ref: FeedRef;
  /** Last streamer message for this symbol (initially the subscription time). */
  lastStreamAt: number;
  polling: boolean;
  lastPollAt: number;
  inFlight: boolean;
  /** Provider time of the newest trade seen via REST (seed / poll), so a poll only emits new prices. */
  lastTradeTs: number | null;
  pollError: string | null;
}

export class YahooProvider implements Provider {
  readonly name: FeedProvider = 'yahoo';
  readonly nativeBars = false;

  private readonly sink: ProviderSink;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly http: YahooHttp;
  private readonly socket: ReconnectingSocket;
  private readonly feeds = new Map<string, YFeed>();
  private readonly abort = new AbortController();
  private readonly silentMs: number;
  private readonly pollMs: number;
  private readonly watchdogMs: number;
  private readonly pendingSub = new Set<string>();
  private readonly pendingUnsub = new Set<string>();
  private timer: TimerHandle | null = null;
  private flushTimer: TimerHandle | null = null;
  private started = false;
  private badFrames = 0;

  constructor(sink: ProviderSink, o: YahooProviderOptions) {
    this.sink = sink;
    this.clock = o.clock;
    this.log = o.log;
    this.silentMs = o.silentMs ?? 15_000;
    this.pollMs = o.pollMs ?? 4_000;
    this.watchdogMs = o.watchdogMs ?? 90_000;
    this.http = new YahooHttp({
      fetch: o.fetch,
      clock: o.clock,
      log: o.log,
      signal: this.abort.signal,
      userAgent: o.userAgent,
      hosts: o.hosts,
      profiles: o.profiles,
      spacingMs: o.requestSpacingMs,
    });
    this.socket = new ReconnectingSocket({
      name: 'yahoo',
      url: o.wsUrl ?? YAHOO_WS_URL,
      headers: { Origin: 'https://finance.yahoo.com', 'User-Agent': o.userAgent ?? BROWSER_UA },
      clock: o.clock,
      log: o.log,
      factory: o.socketFactory,
      random: o.random,
      wanted: () => this.feeds.size > 0,
      onOpen: () => this.onOpen(),
      onMessage: (text) => this.onMessage(text),
      onClose: (info) => this.onClose(info),
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.socket.start();
    this.timer = this.clock.setInterval(() => {
      try {
        this.onTimer();
      } catch (e) {
        this.log.error(`[yahoo] timer failed: ${errorMessage(e)}`);
      }
    }, 1000);
  }

  stop(): void {
    this.started = false;
    if (this.timer != null) this.clock.clearInterval(this.timer);
    if (this.flushTimer != null) this.clock.clearTimeout(this.flushTimer);
    this.timer = this.flushTimer = null;
    this.socket.stop();
    this.abort.abort();
    this.http.close();
  }

  subscribe(ref: FeedRef): void {
    const existing = this.feeds.get(ref.feed);
    if (existing) {
      existing.ref = ref;
      return;
    }
    this.feeds.set(ref.feed, { ref, lastStreamAt: this.clock.now(), polling: false, lastPollAt: -Infinity, inFlight: false, lastTradeTs: null, pollError: null });
    this.pendingUnsub.delete(ref.feed);
    this.pendingSub.add(ref.feed);
    this.socket.ensure();
    this.scheduleFlush();
    this.sink.changed();
  }

  unsubscribe(feed: string): void {
    if (!this.feeds.delete(feed)) return;
    this.pendingSub.delete(feed);
    this.pendingUnsub.add(feed);
    this.scheduleFlush();
    this.sink.changed();
  }

  reconnect(reason: string): void {
    this.socket.reconnect(reason);
  }

  async seed(ref: FeedRef): Promise<void> {
    const now = this.clock.now();
    const data = parseChart(await this.http.chart(ref.feed, { range: '1d', interval: '1m', includePrePost: 'false' }), 60, { toSec: Math.floor(now / 1000) + 60 });
    const m = data.meta;
    const lastBar = data.bars[data.bars.length - 1];
    if (lastBar) this.sink.bar(ref.feed, lastBar, false);
    const price = isNum(m.regularMarketPrice) && m.regularMarketPrice > 0 ? m.regularMarketPrice : lastBar?.close;
    if (price == null) return;
    const ts = isNum(m.regularMarketTime) ? m.regularMarketTime * 1000 : lastBar ? lastBar.time * 1000 : now;
    const f = this.feeds.get(ref.feed);
    if (f && (f.lastTradeTs == null || ts > f.lastTradeTs)) f.lastTradeTs = ts;
    this.sink.tick({ feed: ref.feed, ts, last: price, refPrice: m.previousClose ?? m.chartPreviousClose, source: 'seed' });
  }

  async history(ref: FeedRef, tf: Timeframe, endMs: number, limit: number): Promise<Candle[]> {
    const spec = INTERVALS[tf];
    const need = tf === '4h' ? limit * 4 + 4 : limit;
    const nowSec = Math.floor(this.clock.now() / 1000);
    const horizon = spec.maxAgeSec != null ? nowSec - spec.maxAgeSec : 0;
    let to = Math.min(Math.ceil(endMs / 1000), nowSec + spec.step);
    let bars: Candle[] = [];
    for (let page = 0; page < 8 && bars.length < need && to > horizon; page++) {
      // Generous span: markets are closed part of the day and on weekends.
      let span = Math.ceil((need - bars.length) * spec.step * 1.6) + 4 * DAY;
      if (spec.windowSec != null) span = Math.min(span, spec.windowSec);
      const from = Math.max(horizon, to - span);
      const json = await this.http.chart(ref.feed, { interval: spec.interval, period1: Math.floor(from), period2: to, includePrePost: 'false' });
      const got = parseChart(json, spec.step, { fromSec: from, toSec: to, dayRule: ref.dayRule }).bars;
      const first = bars[0]?.time ?? Infinity;
      bars = got.filter((b) => b.time < first).concat(bars);
      to = Math.floor(from);
    }
    const out = tf === '4h' ? aggregate(bars, '4h') : bars;
    return out.filter((b) => b.time * 1000 < endMs).slice(-limit);
  }

  async history1m(ref: FeedRef, fromMs: number, toMs: number): Promise<Candle[]> {
    const nowSec = Math.floor(this.clock.now() / 1000);
    const from = Math.max(Math.floor(fromMs / 1000) - 60, nowSec - INTERVALS['1m'].maxAgeSec!);
    const to = Math.min(Math.ceil(toMs / 1000) + 60, nowSec + 60);
    const out: Candle[] = [];
    for (let start = from; start < to; start += 7 * DAY) {
      const end = Math.min(to, start + 7 * DAY);
      const json = await this.http.chart(ref.feed, { interval: '1m', period1: Math.floor(start), period2: end, includePrePost: 'false' });
      for (const b of parseChart(json, 60, { fromSec: start, toSec: end }).bars) {
        if (!out.length || b.time > out[out.length - 1].time) out.push(b);
      }
    }
    return out;
  }

  status(): ProviderStatus {
    const now = this.clock.now();
    const s = this.socket;
    const feeds = [...this.feeds.values()];
    const polling = feeds.filter((f) => f.polling);
    const base = { lastMessageAt: s.lastMessageAt, connected: s.isOpen, connectedSince: s.openedAt };
    const names = (fs: YFeed[]) => (fs.length <= 3 ? fs.map((f) => f.ref.feed).join(', ') : `${fs.length} symbols`);
    const n = `${feeds.length} symbol${feeds.length === 1 ? '' : 's'}`;
    if (!this.started) return { ...base, state: 'connecting', message: 'Starting' };
    if (s.isOpen) {
      if (polling.length) {
        const failing = polling.some((f) => f.pollError);
        return { ...base, state: 'degraded', message: `No streamer data for ${names(polling)}, polling the chart API${failing ? ' (failing)' : ''}` };
      }
      if (!feeds.length) return { ...base, state: 'live', message: 'Connected, no symbols' };
      if (!feeds.some((f) => isMarketOpen(f.ref.session, now))) return { ...base, state: 'live', message: `Connected, markets closed (${n})` };
      return { ...base, state: 'live', message: `Streaming ${n}` };
    }
    if (!feeds.length && s.state === 'idle') return { ...base, state: 'live', message: 'Idle, no symbols' };
    if (!s.everOpened && s.failures < 2) return { ...base, state: 'connecting', message: 'Connecting to the Yahoo streamer' };
    if (polling.length && polling.some((f) => !f.pollError && f.lastPollAt > -Infinity)) {
      return { ...base, state: 'degraded', message: 'Streamer disconnected, polling the chart API' };
    }
    if (s.everOpened && s.failures <= 1 && now - (s.downSince ?? now) < 10_000) return { ...base, state: 'connecting', message: 'Reconnecting' };
    return { ...base, state: 'down', message: `Streamer unreachable${s.lastError ? ` (${s.lastError})` : ''}, retrying` };
  }

  private anyOpen(now: number): boolean {
    for (const f of this.feeds.values()) if (isMarketOpen(f.ref.session, now)) return true;
    return false;
  }

  private scheduleFlush(): void {
    if (this.flushTimer != null) return;
    this.flushTimer = this.clock.setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 50);
  }

  private flush(): void {
    if (this.socket.isOpen) {
      if (this.pendingUnsub.size) this.socket.send(JSON.stringify({ unsubscribe: [...this.pendingUnsub] }));
      if (this.pendingSub.size) this.socket.send(JSON.stringify({ subscribe: [...this.pendingSub] }));
    }
    // When closed, onOpen subscribes the full set.
    this.pendingSub.clear();
    this.pendingUnsub.clear();
  }

  private onOpen(): void {
    this.pendingSub.clear();
    this.pendingUnsub.clear();
    if (this.feeds.size) this.socket.send(JSON.stringify({ subscribe: [...this.feeds.keys()] }));
    this.sink.changed();
  }

  private onClose(info: CloseInfo): void {
    if (info.wasOpen) {
      const now = this.clock.now();
      // With open markets data stopped at the last message; otherwise nothing was missed before the close.
      const since = this.anyOpen(now) ? Math.max(info.lastMessageAt ?? 0, info.openedAt ?? 0) || now : now;
      this.sink.down(since);
    }
    this.sink.changed();
  }

  private onMessage(text: string): void {
    let d: PricingData | null;
    try {
      d = decodeStreamerFrame(text);
    } catch (e) {
      if (++this.badFrames <= 3) this.log.warn(`[yahoo] undecodable streamer frame: ${errorMessage(e)}`);
      return;
    }
    if (!d) return;
    const f = this.feeds.get(d.id);
    if (!f) return;
    const now = this.clock.now();
    f.lastStreamAt = now;
    if (f.polling) {
      f.polling = false;
      this.log.info(`[yahoo] ${d.id}: streamer data resumed`);
      this.sink.changed();
    }
    if (!isNum(d.price) || d.price <= 0) return;
    const tick: FeedTick = { feed: d.id, ts: isNum(d.time) && d.time > 0 ? d.time : now, last: d.price, source: 'stream' };
    if (isNum(d.bid) && isNum(d.ask) && d.bid > 0 && d.ask > 0) {
      tick.bid = d.bid;
      tick.ask = d.ask;
    }
    if (isNum(d.dayVolume) && d.dayVolume >= 0) tick.dayVolume = d.dayVolume;
    const ref = isNum(d.previousClose) && d.previousClose > 0 ? d.previousClose : isNum(d.change) ? d.price - d.change : null;
    if (ref != null && ref > 0) tick.refPrice = ref;
    this.sink.tick(tick);
  }

  private onTimer(): void {
    const now = this.clock.now();
    let changed = false;
    let pollingCount = 0;
    for (const f of this.feeds.values()) {
      const should = isMarketOpen(f.ref.session, now) && now - f.lastStreamAt > this.silentMs;
      if (should !== f.polling) {
        f.polling = should;
        changed = true;
        if (should) this.log.info(`[yahoo] ${f.ref.feed}: no streamer data for ${Math.round((now - f.lastStreamAt) / 1000)} s, polling the chart API`);
      }
      if (should) pollingCount++;
    }
    // Stretch the period when many symbols poll, so Yahoo is asked at most ~1 request/1.5 s.
    const every = Math.max(this.pollMs, pollingCount * 1500);
    let started = 0;
    for (const f of this.feeds.values()) {
      if (!f.polling || f.inFlight || now - f.lastPollAt < every || started >= 2 || this.http.rateLimited(now)) continue;
      started++;
      void this.poll(f);
    }
    // A connection that went quiet while markets are open is probably dead.
    if (this.socket.isOpen && this.anyOpen(now)) {
      const last = Math.max(this.socket.lastMessageAt ?? 0, this.socket.openedAt ?? 0);
      if (now - last > this.watchdogMs) this.socket.reconnect(`no streamer data for ${Math.round((now - last) / 1000)} s`);
    }
    if (changed) this.sink.changed();
  }

  private async poll(f: YFeed): Promise<void> {
    f.inFlight = true;
    f.lastPollAt = this.clock.now();
    try {
      const nowSec = Math.floor(this.clock.now() / 1000);
      const json = await this.http.chart(f.ref.feed, { range: '1d', interval: '1m', includePrePost: 'false' });
      if (this.feeds.get(f.ref.feed) !== f || !f.polling) return;
      const data = parseChart(json, 60, { toSec: nowSec + 60 });
      for (const b of data.bars.slice(-2)) this.sink.bar(f.ref.feed, b, true);
      const m = data.meta;
      if (isNum(m.regularMarketTime) && isNum(m.regularMarketPrice) && m.regularMarketPrice > 0) {
        const ts = m.regularMarketTime * 1000;
        if (f.lastTradeTs == null || ts > f.lastTradeTs) {
          f.lastTradeTs = ts;
          this.sink.tick({ feed: f.ref.feed, ts, last: m.regularMarketPrice, refPrice: m.previousClose ?? m.chartPreviousClose, source: 'poll' });
        }
      }
      if (f.pollError) this.sink.changed();
      f.pollError = null;
    } catch (e) {
      const msg = errorMessage(e);
      if (f.pollError == null) {
        this.log.warn(`[yahoo] ${f.ref.feed}: chart poll failed: ${msg}`);
        this.sink.changed();
      }
      f.pollError = msg;
    } finally {
      f.inFlight = false;
    }
  }
}
