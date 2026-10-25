// Binance USDⓈ-M futures provider: live book + 1m klines over combined-stream WebSockets with dynamic
// SUBSCRIBE / UNSUBSCRIBE, REST for snapshots, klines and 24h statistics.
//
// Since Binance's 2025 WebSocket split, `<sym>@kline_1m` is only served on /market and `<sym>@bookTicker`
// on /public (the legacy /stream route still carries bookTicker but no klines — verified 2026-10-24),
// so the provider keeps one connection per route.

import type { Candle, FeedProvider, Timeframe } from '../../../shared/types.ts';
import type { Clock, TimerHandle } from './clock.ts';
import { errorMessage, getJson, HttpError, RequestQueue, type FetchFn } from './http.ts';
import type { FeedRef, Provider, ProviderSink, ProviderStatus, TradePrint } from './provider.ts';
import { ReconnectingSocket, type SocketFactory } from './socket.ts';
import type { Logger } from './types.ts';

export const BINANCE_REST = 'https://fapi.binance.com';
export const BINANCE_WS_BOOK = 'wss://fstream.binance.com/public/stream';
export const BINANCE_WS_KLINE = 'wss://fstream.binance.com/market/stream';

const num = (x: unknown): number | null => {
  const n = typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** REST kline rows ([openTime, o, h, l, c, v, …]) → candles. */
export function parseKlines(rows: unknown): Candle[] {
  if (!Array.isArray(rows)) throw new Error('Binance klines: unexpected response');
  const out: Candle[] = [];
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const t = num(r[0]);
    const o = num(r[1]);
    const h = num(r[2]);
    const l = num(r[3]);
    const c = num(r[4]);
    const v = num(r[5]);
    if (t == null || o == null || h == null || l == null || c == null || c <= 0) continue;
    const time = Math.floor(t / 1000);
    if (out.length && time <= out[out.length - 1].time) continue;
    out.push({ time, open: o, high: h, low: l, close: c, volume: v ?? 0 });
  }
  return out;
}

interface StreamConnectionOptions {
  name: string;
  url: string;
  clock: Clock;
  log: Logger;
  factory: SocketFactory;
  spacingMs: number;
  random?: () => number;
  onData: (data: unknown) => void;
  onDown: (sinceMs: number) => void;
  onChange: () => void;
}

/** One combined-stream connection: desired streams are synced with throttled, batched control messages. */
export class StreamConnection {
  readonly socket: ReconnectingSocket;
  readonly desired = new Set<string>();
  private readonly o: StreamConnectionOptions;
  /** Streams subscribed on the current connection (optimistically, when the request is queued). */
  private readonly sent = new Set<string>();
  private queue: Array<{ method: string; params?: string[]; id: number }> = [];
  private nextId = 1;
  private listId = -1;
  private syncTimer: TimerHandle | null = null;
  private pumpTimer: TimerHandle | null = null;
  private lastControlAt = -Infinity;

  constructor(o: StreamConnectionOptions) {
    this.o = o;
    this.socket = new ReconnectingSocket({
      name: o.name,
      url: o.url,
      clock: o.clock,
      log: o.log,
      factory: o.factory,
      random: o.random,
      wanted: () => this.desired.size > 0,
      onOpen: () => {
        this.sent.clear();
        this.queue = [];
        this.sync();
        o.onChange();
      },
      onMessage: (text) => this.onMessage(text),
      onClose: (info) => {
        this.sent.clear();
        this.queue = [];
        if (info.wasOpen) o.onDown(Math.max(info.lastMessageAt ?? 0, info.openedAt ?? 0) || o.clock.now());
        o.onChange();
      },
    });
  }

  add(stream: string): void {
    if (this.desired.has(stream)) return;
    this.desired.add(stream);
    this.socket.ensure();
    this.scheduleSync();
  }

  remove(stream: string): void {
    if (this.desired.delete(stream)) this.scheduleSync();
  }

  /** Periodic liveness check: LIST_SUBSCRIPTIONS doubles as an application-level ping and a resync. */
  heartbeat(now: number, watchdogMs: number): void {
    if (!this.socket.isOpen) return;
    const last = Math.max(this.socket.lastMessageAt ?? 0, this.socket.openedAt ?? 0);
    if (now - last > watchdogMs) {
      this.socket.reconnect(`no data for ${Math.round((now - last) / 1000)} s`);
      return;
    }
    if (this.queue.length) return;
    this.listId = this.nextId++;
    this.queue.push({ method: 'LIST_SUBSCRIPTIONS', id: this.listId });
    this.pump();
  }

  stop(): void {
    if (this.syncTimer != null) this.o.clock.clearTimeout(this.syncTimer);
    if (this.pumpTimer != null) this.o.clock.clearTimeout(this.pumpTimer);
    this.syncTimer = this.pumpTimer = null;
    this.socket.stop();
  }

  private scheduleSync(): void {
    if (this.syncTimer != null) return;
    // Batch changes made in the same moment (e.g. a client subscribing to its whole watchlist).
    this.syncTimer = this.o.clock.setTimeout(() => {
      this.syncTimer = null;
      this.sync();
    }, 50);
  }

  private sync(): void {
    if (!this.socket.isOpen) return;
    const add = [...this.desired].filter((s) => !this.sent.has(s));
    const rm = [...this.sent].filter((s) => !this.desired.has(s));
    for (let i = 0; i < rm.length; i += 50) this.queue.push({ method: 'UNSUBSCRIBE', params: rm.slice(i, i + 50), id: this.nextId++ });
    for (let i = 0; i < add.length; i += 50) this.queue.push({ method: 'SUBSCRIBE', params: add.slice(i, i + 50), id: this.nextId++ });
    for (const s of rm) this.sent.delete(s);
    for (const s of add) this.sent.add(s);
    this.pump();
  }

  /** Send queued control messages, at most one per spacingMs (Binance allows 10/s; we stay ≤ 4/s). */
  private pump(): void {
    if (this.pumpTimer != null) return;
    while (this.queue.length && this.socket.isOpen) {
      const wait = this.lastControlAt + this.o.spacingMs - this.o.clock.now();
      if (wait > 0) {
        this.pumpTimer = this.o.clock.setTimeout(() => {
          this.pumpTimer = null;
          this.pump();
        }, wait);
        return;
      }
      const msg = this.queue.shift()!;
      this.lastControlAt = this.o.clock.now();
      if (!this.socket.send(JSON.stringify(msg))) return;
    }
  }

  private onMessage(text: string): void {
    const msg = JSON.parse(text) as { stream?: unknown; data?: unknown; id?: unknown; result?: unknown; error?: unknown; code?: unknown; msg?: unknown };
    if (typeof msg.stream === 'string') {
      this.o.onData(msg.data);
      return;
    }
    if (msg.error != null || msg.code != null) {
      this.o.log.warn(`[${this.o.name}] request ${String(msg.id)} rejected: ${JSON.stringify(msg.error ?? { code: msg.code, msg: msg.msg })}`);
      return;
    }
    if (msg.id === this.listId && Array.isArray(msg.result)) {
      const have = new Set(msg.result as string[]);
      const missing = [...this.sent].filter((s) => !have.has(s));
      if (missing.length) {
        this.o.log.warn(`[${this.o.name}] server lost ${missing.length} subscription(s), resubscribing`);
        for (const s of missing) this.sent.delete(s);
        this.sync();
      }
    }
  }
}

export interface BinanceProviderOptions {
  clock: Clock;
  log: Logger;
  fetch: FetchFn;
  socketFactory: SocketFactory;
  restBase?: string;
  bookUrl?: string;
  klineUrl?: string;
  /** Minimum spacing between control messages on one connection. */
  controlSpacingMs?: number;
  heartbeatMs?: number;
  /** Reconnect a connection that delivered nothing (not even heartbeat replies) for this long. */
  watchdogMs?: number;
  /** 24h statistics refresh period for subscribed symbols. */
  tickerMs?: number;
  random?: () => number;
}

export class BinanceProvider implements Provider {
  readonly name: FeedProvider = 'binance';
  readonly nativeBars = true;

  private readonly sink: ProviderSink;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly fetchFn: FetchFn;
  private readonly rest: string;
  private readonly book: StreamConnection;
  private readonly kline: StreamConnection;
  private readonly heartbeatMs: number;
  private readonly watchdogMs: number;
  private readonly tickerMs: number;
  private readonly feeds = new Map<string, FeedRef>();
  private readonly queue: RequestQueue;
  private readonly abort = new AbortController();
  private cooldownUntil = -Infinity;
  private timer: TimerHandle | null = null;
  private lastHeartbeatAt = 0;
  private lastTickerAt = 0;
  private started = false;

  constructor(sink: ProviderSink, o: BinanceProviderOptions) {
    this.sink = sink;
    this.clock = o.clock;
    this.log = o.log;
    this.fetchFn = o.fetch;
    this.rest = o.restBase ?? BINANCE_REST;
    this.heartbeatMs = o.heartbeatMs ?? 30_000;
    this.watchdogMs = o.watchdogMs ?? 75_000;
    this.tickerMs = o.tickerMs ?? 60_000;
    this.queue = new RequestQueue(4, 0, o.clock);
    const bookUrl = o.bookUrl ?? BINANCE_WS_BOOK;
    const klineUrl = o.klineUrl ?? BINANCE_WS_KLINE;
    const conn = (name: string, url: string) =>
      new StreamConnection({
        name,
        url,
        clock: o.clock,
        log: o.log,
        factory: o.socketFactory,
        spacingMs: o.controlSpacingMs ?? 250,
        random: o.random,
        onData: (d) => this.onData(d),
        onDown: (since) => sink.down(since),
        onChange: () => sink.changed(),
      });
    this.book = conn('binance', bookUrl);
    this.kline = klineUrl === bookUrl ? this.book : conn('binance-kline', klineUrl);
  }

  private get connections(): StreamConnection[] {
    return this.kline === this.book ? [this.book] : [this.book, this.kline];
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const now = this.clock.now();
    this.lastHeartbeatAt = this.lastTickerAt = now;
    for (const c of this.connections) c.socket.start();
    this.timer = this.clock.setInterval(() => {
      try {
        this.onTimer();
      } catch (e) {
        this.log.error(`[binance] timer failed: ${errorMessage(e)}`);
      }
    }, 1000);
  }

  stop(): void {
    this.started = false;
    if (this.timer != null) this.clock.clearInterval(this.timer);
    this.timer = null;
    for (const c of this.connections) c.stop();
    this.abort.abort();
    this.queue.clear(new Error('market data stopped'));
  }

  subscribe(ref: FeedRef): void {
    this.feeds.set(ref.feed, ref);
    const s = ref.feed.toLowerCase();
    this.book.add(`${s}@bookTicker`);
    this.kline.add(`${s}@kline_1m`);
    this.sink.changed();
  }

  unsubscribe(feed: string): void {
    if (!this.feeds.delete(feed)) return;
    const s = feed.toLowerCase();
    this.book.remove(`${s}@bookTicker`);
    this.kline.remove(`${s}@kline_1m`);
    this.sink.changed();
  }

  reconnect(reason: string): void {
    for (const c of this.connections) c.socket.reconnect(reason);
  }

  async seed(ref: FeedRef): Promise<void> {
    const sym = encodeURIComponent(ref.feed);
    const [book, day] = await Promise.allSettled([
      this.get<Record<string, unknown>>(`/fapi/v1/ticker/bookTicker?symbol=${sym}`),
      this.get<Record<string, unknown>>(`/fapi/v1/ticker/24hr?symbol=${sym}`),
    ]);
    if (book.status === 'rejected' && day.status === 'rejected') throw book.reason;
    const b = book.status === 'fulfilled' ? book.value : {};
    const d = day.status === 'fulfilled' ? day.value : {};
    const bid = num(b.bidPrice);
    const ask = num(b.askPrice);
    const last = num(d.lastPrice);
    const hasBook = bid != null && ask != null && bid > 0 && ask > 0;
    this.sink.tick({
      feed: ref.feed,
      ts: num(b.time) ?? num(d.closeTime) ?? this.clock.now(),
      ...(hasBook ? { bid, ask } : {}),
      ...(last != null && last > 0 ? { last } : {}),
      ...(num(d.openPrice) ? { refPrice: num(d.openPrice)! } : {}),
      source: 'seed',
    });
  }

  async history(ref: FeedRef, tf: Timeframe, endMs: number, limit: number): Promise<Candle[]> {
    const n = Math.max(1, Math.min(1500, Math.floor(limit)));
    const rows = await this.get<unknown>(`/fapi/v1/klines?symbol=${encodeURIComponent(ref.feed)}&interval=${tf}&endTime=${Math.floor(endMs) - 1}&limit=${n}`);
    return parseKlines(rows).filter((b) => b.time * 1000 < endMs);
  }

  async history1m(ref: FeedRef, fromMs: number, toMs: number): Promise<Candle[]> {
    const out: Candle[] = [];
    let start = Math.floor(fromMs / 60_000) * 60_000;
    for (let page = 0; page < 60 && start <= toMs; page++) {
      const rows = parseKlines(
        await this.get<unknown>(`/fapi/v1/klines?symbol=${encodeURIComponent(ref.feed)}&interval=1m&startTime=${start}&endTime=${Math.floor(toMs)}&limit=1500`),
      );
      for (const b of rows) if (!out.length || b.time > out[out.length - 1].time) out.push(b);
      if (rows.length < 1500) break;
      start = rows[rows.length - 1].time * 1000 + 60_000;
    }
    return out;
  }

  /** Aggregated trades in [fromMs, toMs]; Binance serves at most 1,000 per call and windows under an hour. */
  async trades(ref: FeedRef, fromMs: number, toMs: number, maxPrints: number): Promise<TradePrint[] | null> {
    const out: TradePrint[] = [];
    let start = Math.floor(fromMs);
    let lastId = -1;
    while (start <= toMs) {
      const end = Math.min(Math.floor(toMs), start + 3_599_999);
      const rows = await this.get<Array<{ a: number; p: string; T: number }>>(
        `/fapi/v1/aggTrades?symbol=${encodeURIComponent(ref.feed)}&startTime=${start}&endTime=${end}&limit=1000`,
      );
      if (!Array.isArray(rows)) throw new Error('Binance aggTrades: unexpected response');
      for (const r of rows) {
        const price = Number(r.p);
        if (r.a <= lastId || !(price > 0)) continue;
        lastId = r.a;
        out.push({ ts: r.T, price });
      }
      if (out.length > maxPrints) return null;
      // A full page may stop mid-millisecond: continue from the last print's time (duplicates are skipped by id).
      const lastT = rows.length ? rows[rows.length - 1].T : end;
      start = rows.length >= 1000 ? (lastT > start ? lastT : start + 1) : end + 1;
    }
    return out;
  }

  status(): ProviderStatus {
    const now = this.clock.now();
    const conns = this.connections;
    const active = this.feeds.size > 0;
    const open = conns.filter((c) => c.socket.isOpen);
    const lastAt = conns.map((c) => c.socket.lastMessageAt ?? 0);
    const lastMessageAt = (active ? Math.min(...lastAt) : Math.max(...lastAt)) || null;
    const connected = open.length === conns.length;
    const connectedSince = connected ? Math.max(...conns.map((c) => c.socket.openedAt ?? 0)) || null : null;
    const base = { lastMessageAt, connected, connectedSince };
    const n = `${this.feeds.size} symbol${this.feeds.size === 1 ? '' : 's'}`;
    if (!this.started) return { ...base, state: 'connecting', message: 'Starting' };
    if (connected) return { ...base, state: 'live', message: active ? `Streaming ${n}` : 'Connected, no symbols' };
    if (!active && conns.every((c) => c.socket.state === 'idle' || c.socket.isOpen)) return { ...base, state: 'live', message: 'Idle, no symbols' };
    if (open.length) {
      const down = conns.find((c) => !c.socket.isOpen)!;
      return { ...base, state: 'degraded', message: `${down === this.kline ? 'Kline' : 'Order book'} stream reconnecting` };
    }
    const worst = conns.reduce((a, c) => (c.socket.failures > a.socket.failures ? c : a));
    if (!worst.socket.everOpened && worst.socket.failures < 2) return { ...base, state: 'connecting', message: 'Connecting to Binance' };
    if (worst.socket.everOpened && worst.socket.failures <= 1 && now - (worst.socket.downSince ?? now) < 10_000) return { ...base, state: 'connecting', message: 'Reconnecting' };
    return { ...base, state: 'down', message: `Binance unreachable${worst.socket.lastError ? ` (${worst.socket.lastError})` : ''}, retrying` };
  }

  private onTimer(): void {
    const now = this.clock.now();
    if (now - this.lastHeartbeatAt >= this.heartbeatMs) {
      this.lastHeartbeatAt = now;
      for (const c of this.connections) c.heartbeat(now, this.watchdogMs);
    }
    if (now - this.lastTickerAt >= this.tickerMs) {
      this.lastTickerAt = now;
      for (const feed of this.feeds.keys()) void this.refreshDayStats(feed);
    }
  }

  /** 24h open (reference for changePct) of a subscribed symbol. */
  private async refreshDayStats(feed: string): Promise<void> {
    try {
      const d = await this.get<Record<string, unknown>>(`/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(feed)}`);
      const open = num(d.openPrice);
      if (open && this.feeds.has(feed)) this.sink.tick({ feed, ts: num(d.closeTime) ?? this.clock.now(), refPrice: open, source: 'seed' });
    } catch (e) {
      this.log.debug(`[binance] 24h stats for ${feed} failed: ${errorMessage(e)}`);
    }
  }

  private onData(data: unknown): void {
    const d = data as Record<string, unknown> | null;
    if (!d || typeof d.s !== 'string') return;
    const now = this.clock.now();
    if (d.e === 'bookTicker') {
      const bid = num(d.b);
      const ask = num(d.a);
      if (bid != null && ask != null && bid > 0 && ask > 0) this.sink.tick({ feed: d.s, ts: num(d.E) ?? num(d.T) ?? now, bid, ask, source: 'stream' });
    } else if (d.e === 'kline') {
      const k = d.k as Record<string, unknown> | undefined;
      const t = num(k?.t);
      const o = num(k?.o);
      const h = num(k?.h);
      const l = num(k?.l);
      const c = num(k?.c);
      if (t == null || o == null || h == null || l == null || c == null || c <= 0) return;
      this.sink.bar(d.s, { time: Math.floor(t / 1000), open: o, high: h, low: l, close: c, volume: num(k?.v) ?? 0 }, true);
      this.sink.tick({ feed: d.s, ts: num(d.E) ?? now, last: c, source: 'stream' });
    }
  }

  private get<T>(path: string): Promise<T> {
    return this.queue.run(async () => {
      const now = this.clock.now();
      if (now < this.cooldownUntil) throw new Error(`Binance rate limit, retry in ${Math.ceil((this.cooldownUntil - now) / 1000)} s`);
      try {
        return await getJson<T>(this.fetchFn, this.rest + path, { signal: this.abort.signal, timeoutMs: 10_000 });
      } catch (e) {
        if (e instanceof HttpError && (e.status === 429 || e.status === 418)) {
          this.cooldownUntil = this.clock.now() + (e.retryAfterMs ?? 30_000);
          this.log.warn(`[binance] REST rate limited (${e.status}), pausing requests`);
        }
        throw e;
      }
    });
  }
}
