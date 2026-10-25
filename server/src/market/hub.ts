// MarketHub implementation. Providers deliver feed-level prices and bars in feed time; the hub maps each
// feed to its app symbols (NQ & MNQ ← NQ=F), synthesizes quotes, detects delayed feeds and shifts them to
// "now", builds/caches candles, ref-counts subscriptions, and reports gaps and feed status.

import fs from 'node:fs';
import path from 'node:path';
import type { Candle, FeedProvider, FeedStatus, InstrumentSpec, Quote, Timeframe, ZonedTime } from '../../../shared/types.ts';
import { TIMEFRAME_SECONDS } from '../../../shared/types.ts';
import { isMarketOpen, NEW_YORK } from '../../../shared/time.ts';
import { BinanceProvider } from './binance.ts';
import { LiveBarBuilder, overlayLive, presentBar, shared, TtlCache, UTC_MIDNIGHT } from './candles.ts';
import { systemClock, type Clock, type TimerHandle } from './clock.ts';
import { DelayDetector, median, roundDelay } from './delay.ts';
import { GapTracker, SuspendDetector, type GapSource } from './gap.ts';
import { errorMessage, type FetchFn } from './http.ts';
import type { FeedRef, FeedTick, Provider, ProviderSink } from './provider.ts';
import { defaultSocketFactory, type SocketFactory } from './socket.ts';
import { newTickRuleState, synthesize, type Book, type TickRuleState } from './synth.ts';
import type { MarketGap, MarketHub, MarketHubOptions } from './types.ts';
import { YahooProvider } from './yahoo.ts';

export interface HubDeps {
  clock?: Clock;
  fetch?: FetchFn;
  socketFactory?: SocketFactory;
  /** Replace provider construction (tests). */
  providers?: Partial<Record<FeedProvider, (sink: ProviderSink) => Provider>>;
  /** Delay before an unretained feed is unsubscribed; absorbs release/retain churn from clients. */
  lingerMs?: number;
  /** Drive delayed feeds live with their instruments' liveProxy (default true). */
  liveProxies?: boolean;
}

const MAX_LIMIT = 1500;
const DEFAULT_LIMIT = 500;
/** Live 1m bars kept per feed (covers the longest "latest" cache TTL with room to spare). */
const LIVE_BARS = 180;
/** How long a cached "latest bars" series is reused; live 1m bars are overlaid on top of it. */
const LIVE_TTL_MS: Record<Timeframe, number> = { '1m': 30_000, '5m': 60_000, '15m': 120_000, '1h': 300_000, '4h': 600_000, '1d': 1_800_000 };
const PAST_TTL_MS = 30 * 60_000;
const HISTORY_1M_TTL_MS = 30_000;
/** Minutes matched between a delayed feed and its live proxy for the price ratio (median). */
const PROXY_FIT_MINUTES = 15;
const PROXY_FIT_EVERY_MS = 60_000;
/** Proxy minutes copied in when it starts: the delayed history's missing tail. */
const PROXY_BACKFILL_MS = 60 * 60_000;

/** Yahoo's daily bars: CME trade date (17:00 ET rollover) for futures, London calendar day for FX. */
const CME_DAY: ZonedTime = { hour: 17, minute: 0, tz: NEW_YORK };
const LONDON_DAY: ZonedTime = { hour: 0, minute: 0, tz: 'Europe/London' };

function dayRuleFor(spec: InstrumentSpec): ZonedTime {
  if (spec.provider === 'yahoo' && spec.session === 'cme') return CME_DAY;
  if (spec.provider === 'yahoo' && spec.session === 'fx') return LONDON_DAY;
  return UTC_MIDNIGHT;
}

/**
 * A delayed feed (Yahoo CME) driven live by a real-time proxy (a Binance perpetual of the same market):
 * price = proxy price × ratio, the ratio being the median of the latest minutes where both have a close.
 * Its history keeps the delayed feed's real bars (not time-shifted); the minutes it lacks are proxy bars.
 */
interface ProxyState {
  feed: Feed;
  ratio: number | null;
  fittedAt: number;
  fitting: boolean;
  backfilled: boolean;
  failures: number;
}

interface Series {
  bars: Candle[];
  fetchedAt: number;
  /** Feed time (s) up to which `bars` is complete. */
  coveredSec: number;
  limit: number;
}

interface Feed {
  key: string;
  provider: Provider;
  ref: FeedRef;
  syms: Sym[];
  /** App symbols of this feed with at least one owner. */
  retained: number;
  subscribed: boolean;
  lingerTimer: TimerHandle | null;
  delay: DelayDetector;
  /** Latest prices, feed time. */
  lastTs: number | null;
  last: number | null;
  bid: number | null;
  ask: number | null;
  refPrice: number | null;
  /** Recent live 1m bars, feed time, ascending. */
  bars: Candle[];
  lastEmittedBar: number;
  builder: LiveBarBuilder;
  /** Real time since which live bars have been continuous (null: not subscribed / interrupted). */
  liveSince: number | null;
  lastLiveAt: number;
  seeding: boolean;
  seededAt: number;
  seedFailures: number;
  proxy: ProxyState | null;
  /** Delayed feeds that use this one as their live proxy. */
  dependents: Feed[];
}

interface Sym {
  spec: InstrumentSpec;
  feed: Feed;
  owners: Set<string>;
  quote: Quote | null;
  rule: TickRuleState;
}

export function createHub(opts: MarketHubOptions, deps: HubDeps = {}): MarketHub {
  const clock = deps.clock ?? systemClock;
  const log = opts.log;
  const fetchFn: FetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
  const socketFactory = deps.socketFactory ?? defaultSocketFactory;
  const lingerMs = deps.lingerMs ?? 10_000;

  const quoteL = new Set<(q: Quote) => void>();
  const candleL = new Set<(symbol: string, c: Candle) => void>();
  const gapL = new Set<(gap: MarketGap) => void>();
  const feedL = new Set<(feeds: FeedStatus[]) => void>();

  const providers = new Map<FeedProvider, Provider>();
  const feeds = new Map<string, Feed>();
  const syms = new Map<string, Sym>();
  const cache = new TtlCache<Series | Candle[]>(160);
  const seriesInflight = new Map<string, Promise<Series>>();
  const barsInflight = new Map<string, Promise<Candle[]>>();
  const unknownWarned = new Set<string>();
  const gapSources: GapSource[] = [];
  let running = false;
  let tickTimer: TimerHandle | null = null;
  let statusTimer: TimerHandle | null = null;
  let lastStatusSig = '';

  const safe = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      log.error(`[market] ${what} failed: ${errorMessage(e)}`);
    }
  };

  // ───────────────────────────── providers & feeds ─────────────────────────────

  function makeSink(name: FeedProvider): ProviderSink {
    const feedOf = (feed: string) => feeds.get(`${name}:${feed}`);
    return {
      tick: (t) => {
        const f = feedOf(t.feed);
        if (f) safe('tick', () => onTick(f, t));
      },
      bar: (feed, bar, live) => {
        const f = feedOf(feed);
        if (f) safe('bar', () => onBar(f, bar, live));
      },
      changed: () => scheduleStatus(),
      down: (since) => {
        for (const f of feeds.values()) if (f.provider.name === name) f.liveSince = null;
        if (running) gaps.down(name, since);
        scheduleStatus();
      },
    };
  }

  function providerFor(name: FeedProvider): Provider {
    let p = providers.get(name);
    if (!p) {
      const sink = makeSink(name);
      const custom = deps.providers?.[name];
      p = custom
        ? custom(sink)
        : name === 'binance'
          ? new BinanceProvider(sink, { clock, log, fetch: fetchFn, socketFactory })
          : new YahooProvider(sink, { clock, log, fetch: fetchFn, socketFactory });
      providers.set(name, p);
      const prov = p;
      gapSources.push({
        name,
        active: () => subscribedFeeds(prov).length > 0,
        resumedSince: (mark, now) => {
          const s = prov.status();
          if (!s.connected) return false;
          if (s.lastMessageAt != null && s.lastMessageAt >= mark) return true;
          // Nothing will arrive while every subscribed market is closed; otherwise allow a quiet 5 s.
          if (!subscribedFeeds(prov).some((f) => isMarketOpen(f.ref.session, now))) return true;
          return now - Math.max(mark, s.connectedSince ?? now) >= 5000;
        },
      });
    }
    return p;
  }

  function subscribedFeeds(p: Provider): Feed[] {
    return [...feeds.values()].filter((f) => f.provider === p && f.subscribed);
  }

  function makeFeed(key: string, provider: Provider, ref: FeedRef): Feed {
    const feed: Feed = {
      key,
      provider,
      ref,
      syms: [],
      retained: 0,
      subscribed: false,
      lingerTimer: null,
      delay: new DelayDetector(),
      lastTs: null,
      last: null,
      bid: null,
      ask: null,
      refPrice: null,
      bars: [],
      lastEmittedBar: -Infinity,
      builder: new LiveBarBuilder(),
      liveSince: null,
      lastLiveAt: -Infinity,
      seeding: false,
      seededAt: -Infinity,
      seedFailures: 0,
      proxy: null,
      dependents: [],
    };
    feeds.set(key, feed);
    return feed;
  }

  for (const spec of opts.instruments) {
    const key = `${spec.provider}:${spec.feedSymbol}`;
    const feed = feeds.get(key) ?? makeFeed(key, providerFor(spec.provider), { feed: spec.feedSymbol, session: spec.session, dayRule: dayRuleFor(spec) });
    const sym: Sym = { spec, feed, owners: new Set(), quote: null, rule: newTickRuleState() };
    feed.syms.push(sym);
    syms.set(spec.symbol, sym);
  }

  if (deps.liveProxies !== false) {
    for (const f of [...feeds.values()]) {
      const proxy = f.syms[0]?.spec.liveProxy;
      if (!proxy) continue;
      const key = `binance:${proxy.feed}`;
      const p = feeds.get(key) ?? makeFeed(key, providerFor('binance'), { feed: proxy.feed, session: '24x7', dayRule: UTC_MIDNIGHT });
      f.proxy = { feed: p, ratio: null, fittedAt: -Infinity, fitting: false, backfilled: false, failures: 0 };
      p.dependents.push(f);
    }
  }

  /** Time shift applied to a feed's prices and bars: its delay, except for proxied feeds (real-time). */
  const shiftOf = (f: Feed) => (f.proxy ? 0 : f.delay.delaySec);

  const gaps = new GapTracker({
    clock,
    sources: gapSources,
    retained: () => [...syms.values()].filter((s) => s.owners.size > 0).map((s) => s.spec.symbol),
    emit: (gap) => {
      log.info(`[market] data gap ${new Date(gap.fromMs).toISOString()} → ${new Date(gap.toMs).toISOString()} (${Math.round((gap.toMs - gap.fromMs) / 1000)} s, ${gap.symbols.length} symbols)`);
      // Cached "latest" series may lack the missed bars.
      cache.deleteWhere((k) => k.endsWith('|live'));
      for (const l of gapL) safe('gap listener', () => l(gap));
    },
  });

  const suspend = new SuspendDetector(clock, (fromMs, toMs) => {
    log.warn(`[market] process was suspended for ${Math.round((toMs - fromMs) / 1000)} s`);
    for (const f of feeds.values()) f.liveSince = null;
    cache.deleteWhere((k) => k.endsWith('|live'));
    // After a real sleep the sockets are most likely half-open: start over.
    if (toMs - fromMs > 20_000) for (const p of providers.values()) p.reconnect('process resumed from suspend');
    gaps.suspended(fromMs, toMs);
  });

  // ───────────────────────────── delay persistence ─────────────────────────────

  const delayFile = opts.cacheDir ? path.join(opts.cacheDir, 'market-delays.json') : null;

  function loadDelays(): void {
    if (!delayFile) return;
    try {
      const saved = JSON.parse(fs.readFileSync(delayFile, 'utf8')) as Record<string, unknown>;
      for (const [key, sec] of Object.entries(saved)) {
        const f = feeds.get(key);
        if (f && typeof sec === 'number' && sec >= 60 && sec <= 1800) f.delay.preset(sec);
      }
    } catch {
      // first run / unreadable: detect from scratch
    }
  }

  function saveDelays(): void {
    if (!delayFile) return;
    const out: Record<string, number> = {};
    for (const f of feeds.values()) if (f.delay.delaySec > 0) out[f.key] = f.delay.delaySec;
    try {
      fs.mkdirSync(path.dirname(delayFile), { recursive: true });
      fs.writeFileSync(delayFile, JSON.stringify(out));
    } catch (e) {
      log.warn(`[market] could not save ${delayFile}: ${errorMessage(e)}`);
    }
  }

  loadDelays();

  function onDelayChange(f: Feed): void {
    const d = f.delay.delaySec;
    log.info(`[${f.provider.name}] ${f.ref.feed}: ${d > 0 ? `data delayed ${d / 60} min, time-shifting it to now` : 'data is real-time'}`);
    saveDelays();
    scheduleStatus();
  }

  // ───────────────────────────── prices → quotes ─────────────────────────────

  function onTick(f: Feed, t: FeedTick): void {
    const now = clock.now();
    if (t.refPrice != null && t.refPrice > 0) f.refPrice = t.refPrice;
    const hasLast = t.last != null && t.last > 0;
    const hasBook = t.bid != null && t.ask != null && t.bid > 0 && t.ask > 0;
    if (!hasLast && !hasBook) return;
    if (t.source === 'seed') {
      if (f.lastTs != null && t.ts <= f.lastTs) return;
      // A snapshot of an open market already tells the delay; use it until live samples arrive.
      if (!f.delay.known && isMarketOpen(f.ref.session, now) && isMarketOpen(f.ref.session, t.ts)) {
        const lag = now - t.ts;
        if (lag >= 30_000 && lag <= 30 * 60_000 && f.delay.preset(roundDelay(lag))) onDelayChange(f);
      }
    } else {
      // Prices stamped outside the session (e.g. weekend FX noise) are not tradable data.
      if (!isMarketOpen(f.ref.session, t.ts)) return;
      f.lastLiveAt = now;
      if (isMarketOpen(f.ref.session, now) && f.delay.addSample(now - t.ts, now)) onDelayChange(f);
    }
    if (hasLast) f.last = t.last!;
    if (hasBook) {
      f.bid = t.bid!;
      f.ask = t.ask!;
    }
    if (f.lastTs == null || t.ts > f.lastTs) f.lastTs = t.ts;
    // A proxied feed only anchors the price (ratio, delay, reference price); its proxy moves it.
    if (f.proxy) return;
    if (t.source === 'stream' && hasLast && !f.provider.nativeBars) {
      const bar = f.builder.tick(t.ts, t.last!, t.dayVolume);
      if (bar) storeBar(f, bar, true);
    }
    for (const sym of f.syms) updateQuote(sym, t, now);
    for (const d of f.dependents) proxyQuotes(d, now);
  }

  function updateQuote(sym: Sym, t: FeedTick, now: number): void {
    const f = sym.feed;
    const spec = sym.spec;
    let book: Book;
    if (spec.quoteModel === 'bidask') {
      if (f.bid == null || f.ask == null) return;
      book = synthesize(spec, { last: f.last ?? (f.bid + f.ask) / 2, bid: f.bid, ask: f.ask }, sym.rule);
    } else {
      const last = f.last ?? (f.bid != null && f.ask != null ? (f.bid + f.ask) / 2 : null);
      if (last == null) return;
      // For trade-price feeds only a book that arrived with this very tick is current.
      book = synthesize(spec, { last, bid: t.bid, ask: t.ask }, sym.rule);
    }
    emitQuote(sym, book, Math.min(now, (f.lastTs ?? now) + shiftOf(f) * 1000));
  }

  /** Live quotes of a proxied feed: the proxy's mid (or last) × the fitted ratio, while the market is open. */
  function proxyQuotes(d: Feed, now: number): void {
    const px = d.proxy!;
    const p = px.feed;
    const ref = p.bid != null && p.ask != null ? (p.bid + p.ask) / 2 : p.last;
    if (px.ratio == null || ref == null || !isMarketOpen(d.ref.session, now)) return;
    const ts = Math.min(now, p.lastTs ?? now);
    for (const sym of d.syms) emitQuote(sym, synthesize(sym.spec, { last: ref * px.ratio }, sym.rule), ts);
  }

  function emitQuote(sym: Sym, book: Book, tsIn: number): void {
    const f = sym.feed;
    const spec = sym.spec;
    const prev = sym.quote;
    const ts = prev && tsIn < prev.ts ? prev.ts : tsIn;
    const changePct = f.refPrice ? Math.round((book.last / f.refPrice - 1) * 1e6) / 1e6 : null;
    if (prev && prev.bid === book.bid && prev.ask === book.ask && prev.last === book.last) {
      // Same prices (e.g. only book sizes changed): refresh silently.
      sym.quote = { ...prev, ts, changePct };
      return;
    }
    const q: Quote = { symbol: spec.symbol, bid: book.bid, ask: book.ask, last: book.last, ts, changePct };
    sym.quote = q;
    if (!sym.owners.size) return;
    for (const l of quoteL) {
      try {
        l(q);
      } catch (e) {
        log.error(`[market] quote listener failed: ${errorMessage(e)}`);
      }
    }
  }

  // ───────────────────────────── live candles ─────────────────────────────

  function onBar(f: Feed, bar: Candle, live: boolean): void {
    if (!(bar.close > 0) || f.proxy) return;
    if (live && !isMarketOpen(f.ref.session, bar.time * 1000)) return;
    if (!f.provider.nativeBars) f.builder.set(bar);
    storeBar(f, bar, live);
    for (const d of f.dependents) {
      const r = d.proxy!.ratio;
      if (r != null && d.proxy!.backfilled && isMarketOpen(d.ref.session, bar.time * 1000)) storeBar(d, scaleBar(bar, r), live);
    }
  }

  /** A proxy bar at a proxied feed's price level (its volume is another market's: dropped). */
  function scaleBar(c: Candle, r: number): Candle {
    return { time: c.time, open: c.open * r, high: c.high * r, low: c.low * r, close: c.close * r, volume: 0 };
  }

  /** Re-fit the proxy ratio from the latest minutes both feeds have; the first fit also backfills the bars. */
  async function fitProxy(d: Feed): Promise<void> {
    const px = d.proxy!;
    if (px.fitting) return;
    px.fitting = true;
    px.fittedAt = clock.now();
    try {
      const now = clock.now();
      const pair = async (spanMs: number) => {
        const [real, proxy] = await Promise.all([d.provider.history1m(d.ref, now - spanMs, now), px.feed.provider.history1m(px.feed.ref, now - spanMs, now)]);
        const closes = new Map(proxy.map((c) => [c.time, c.close]));
        const ratios = real.filter((c) => c.close > 0 && (closes.get(c.time) ?? 0) > 0).map((c) => c.close / closes.get(c.time)!);
        return { real, proxy, ratios: ratios.slice(-PROXY_FIT_MINUTES) };
      };
      let m = await pair(90 * 60_000);
      // Right after a weekend / restart nothing recent may overlap yet: fall back to the last session.
      if (!m.ratios.length && px.ratio == null) m = await pair(4 * 86_400_000);
      if (m.ratios.length) {
        const before = px.ratio;
        px.ratio = median(m.ratios);
        if (before == null) log.info(`[market] ${d.ref.feed} runs live with ${px.feed.ref.feed} × ${px.ratio.toFixed(4)}`);
      }
      px.failures = 0;
      if (px.ratio != null && !px.backfilled) {
        const lastReal = m.real.length ? m.real[m.real.length - 1].time : -Infinity;
        for (const c of m.proxy) {
          if (c.time >= lastReal && c.time * 1000 >= now - PROXY_BACKFILL_MS && isMarketOpen(d.ref.session, c.time * 1000)) storeBar(d, scaleBar(c, px.ratio), false);
        }
        px.backfilled = true;
        cache.deleteWhere((k) => k.startsWith(`${d.key}|`));
        proxyQuotes(d, clock.now());
      }
    } catch (e) {
      const msg = `[market] ${d.ref.feed}: live proxy fit failed: ${errorMessage(e)}`;
      if (px.failures++ === 0) log.warn(msg);
      else log.debug(msg);
    } finally {
      px.fitting = false;
    }
  }

  function storeBar(f: Feed, bar: Candle, emit: boolean): void {
    const bars = f.bars;
    const last = bars[bars.length - 1];
    if (!last || bar.time > last.time) {
      bars.push(bar);
      if (bars.length > LIVE_BARS) bars.splice(0, bars.length - LIVE_BARS);
    } else if (bar.time === last.time) bars[bars.length - 1] = bar;
    else {
      const i = bars.findIndex((b) => b.time === bar.time);
      if (i < 0) return;
      bars[i] = bar;
    }
    // Charts can only update the newest bar: never emit an older one.
    if (!emit || bar.time < f.lastEmittedBar) return;
    f.lastEmittedBar = bar.time;
    const shift = shiftOf(f);
    for (const sym of f.syms) {
      if (!sym.owners.size) continue;
      const c = presentBar(bar, sym.spec, shift);
      for (const l of candleL) {
        try {
          l(sym.spec.symbol, c);
        } catch (e) {
          log.error(`[market] candle listener failed: ${errorMessage(e)}`);
        }
      }
    }
  }

  // ───────────────────────────── retain / release ─────────────────────────────

  function feedRetained(f: Feed): void {
    if (f.proxy) feedRetained(f.proxy.feed);
    f.retained++;
    if (f.lingerTimer != null) {
      clock.clearTimeout(f.lingerTimer);
      f.lingerTimer = null;
    }
    if (!f.subscribed) {
      f.subscribed = true;
      f.liveSince = null;
      if (running) f.provider.subscribe(f.ref);
      scheduleStatus();
    }
    maybeSeed(f);
  }

  function feedReleased(f: Feed): void {
    if (f.proxy) feedReleased(f.proxy.feed);
    f.retained = Math.max(0, f.retained - 1);
    if (f.retained > 0 || f.lingerTimer != null || !f.subscribed) return;
    f.lingerTimer = clock.setTimeout(() => {
      f.lingerTimer = null;
      if (f.retained > 0 || !f.subscribed) return;
      f.subscribed = false;
      f.liveSince = null;
      if (running) f.provider.unsubscribe(f.ref.feed);
      scheduleStatus();
    }, lingerMs);
  }

  /** Fetch a REST snapshot so a newly retained symbol has a price before its first live tick. */
  function maybeSeed(f: Feed): void {
    if (!running || f.seeding) return;
    const now = clock.now();
    if (now - f.lastLiveAt < 15_000 || now - f.seededAt < 20_000) return;
    f.seeding = true;
    f.seededAt = now;
    f.provider
      .seed(f.ref)
      .then(() => {
        f.seedFailures = 0;
      })
      .catch((e: unknown) => {
        const msg = `[${f.provider.name}] ${f.ref.feed}: price snapshot failed: ${errorMessage(e)}`;
        if (f.seedFailures++ === 0) log.warn(msg);
        else log.debug(msg);
      })
      .finally(() => {
        f.seeding = false;
      });
  }

  // ───────────────────────────── status & housekeeping ─────────────────────────────

  function computeStatus(): FeedStatus[] {
    const list = [...providers.values()].sort((a, b) => a.name.localeCompare(b.name));
    return list.map((p) => {
      const s = p.status();
      let delaySec = 0;
      const delayed: string[] = [];
      let proxied = false;
      for (const f of subscribedFeeds(p)) {
        if (f.proxy) proxied = true;
        if (shiftOf(f) <= 0) continue;
        delaySec = Math.max(delaySec, f.delay.delaySec);
        delayed.push(f.ref.feed);
      }
      let message = delaySec > 0 ? `${s.message} · ${delayed.length === 1 ? delayed[0] : `${delayed.length} symbols`} delayed ${Math.round(delaySec / 60)} min (time-shifted)` : s.message;
      if (proxied) message += ' · futures live via Binance';
      return { provider: p.name, state: s.state, delaySec, lastMessageAt: s.lastMessageAt, message };
    });
  }

  function refreshStatus(): void {
    const st = computeStatus();
    const sig = st.map((s) => `${s.provider}|${s.state}|${s.delaySec}|${s.message}`).join('\n');
    if (sig === lastStatusSig) return;
    lastStatusSig = sig;
    for (const l of feedL) safe('feed status listener', () => l(st));
  }

  function scheduleStatus(): void {
    if (!running || statusTimer != null) return;
    statusTimer = clock.setTimeout(() => {
      statusTimer = null;
      safe('status', refreshStatus);
    }, 50);
  }

  function housekeeping(): void {
    const now = clock.now();
    const connected = new Map<Provider, boolean>();
    for (const f of feeds.values()) {
      if (!f.subscribed) continue;
      if (f.liveSince == null) {
        let c = connected.get(f.provider);
        if (c == null) connected.set(f.provider, (c = f.provider.status().connected));
        if (c) f.liveSince = now;
      }
      if (f.last == null && f.bid == null) maybeSeed(f);
      const px = f.proxy;
      if (px && !px.fitting && isMarketOpen(f.ref.session, now) && now - px.fittedAt >= (px.ratio == null ? 10_000 : PROXY_FIT_EVERY_MS)) void fitProxy(f);
    }
    gaps.tick(now);
    refreshStatus();
  }

  // ───────────────────────────── candles API ─────────────────────────────

  async function cachedBars(key: string, ttlMs: number, load: () => Promise<Candle[]>): Promise<Candle[]> {
    const hit = cache.get(key, clock.now());
    if (hit?.fresh) return hit.value as Candle[];
    try {
      return await shared(barsInflight, key, async () => {
        const bars = await load();
        cache.set(key, bars, ttlMs, clock.now());
        return bars;
      });
    } catch (e) {
      if (hit) {
        log.warn(`[market] using stale candles (${errorMessage(e)})`);
        return hit.value as Candle[];
      }
      throw e;
    }
  }

  /** Latest bars of a feed/timeframe, reused for LIVE_TTL_MS while live bars keep it current. */
  async function latestSeries(f: Feed, tf: Timeframe, limit: number): Promise<Series> {
    const key = `${f.key}|${tf}|live`;
    const now = clock.now();
    const hit = cache.get(key, now);
    if (hit?.fresh) {
      const s = hit.value as Series;
      // Reusable when large enough and either live bars cover everything since the fetch or it is very recent.
      if (s.limit >= limit && (f.liveSince == null || f.liveSince <= s.fetchedAt || now - s.fetchedAt < 5000)) return s;
    }
    const want = Math.max(limit, DEFAULT_LIMIT);
    try {
      return await shared(seriesInflight, `${key}|${want}`, async () => {
        const fetchedAt = clock.now();
        const coveredSec = Math.floor(fetchedAt / 1000) - f.delay.delaySec;
        const bars = await f.provider.history(f.ref, tf, (coveredSec + TIMEFRAME_SECONDS[tf]) * 1000, want);
        const s: Series = { bars, fetchedAt, coveredSec, limit: want };
        cache.set(key, s, LIVE_TTL_MS[tf], clock.now());
        return s;
      });
    } catch (e) {
      if (hit) {
        log.warn(`[market] using stale ${f.ref.feed} ${tf} candles (${errorMessage(e)})`);
        return hit.value as Series;
      }
      throw e;
    }
  }

  function symOrThrow(symbol: string): Sym {
    const sym = syms.get(symbol);
    if (!sym) throw new Error(`Unknown symbol: ${symbol}`);
    return sym;
  }

  // ───────────────────────────── the hub ─────────────────────────────

  return {
    async start() {
      if (running) return;
      running = true;
      for (const p of providers.values()) p.start();
      for (const f of feeds.values()) {
        if (!f.subscribed) continue;
        f.provider.subscribe(f.ref);
        maybeSeed(f);
      }
      suspend.start();
      tickTimer = clock.setInterval(() => safe('housekeeping', housekeeping), 1000);
      refreshStatus();
    },

    async stop() {
      if (!running) return;
      running = false;
      suspend.stop();
      if (tickTimer != null) clock.clearInterval(tickTimer);
      if (statusTimer != null) clock.clearTimeout(statusTimer);
      tickTimer = statusTimer = null;
      for (const f of feeds.values()) {
        if (f.lingerTimer != null) clock.clearTimeout(f.lingerTimer);
        f.lingerTimer = null;
      }
      for (const p of providers.values()) p.stop();
    },

    retain(symbol, owner) {
      const sym = syms.get(symbol);
      if (!sym) {
        if (!unknownWarned.has(symbol)) log.warn(`[market] retain of unknown symbol ${symbol}`);
        unknownWarned.add(symbol);
        return;
      }
      if (sym.owners.has(owner)) return;
      sym.owners.add(owner);
      if (sym.owners.size === 1) feedRetained(sym.feed);
    },

    release(symbol, owner) {
      const sym = syms.get(symbol);
      if (!sym || !sym.owners.delete(owner)) return;
      if (!sym.owners.size) feedReleased(sym.feed);
    },

    releaseAll(owner) {
      for (const sym of syms.values()) {
        if (sym.owners.delete(owner) && !sym.owners.size) feedReleased(sym.feed);
      }
    },

    getQuote: (symbol) => syms.get(symbol)?.quote ?? null,

    getQuotes: () => [...syms.values()].flatMap((s) => (s.quote ? [s.quote] : [])),

    onQuote(cb) {
      quoteL.add(cb);
      return () => {
        quoteL.delete(cb);
      };
    },

    onCandle(cb) {
      candleL.add(cb);
      return () => {
        candleL.delete(cb);
      };
    },

    async getCandles(symbol: string, tf: Timeframe, o: { endSec?: number; limit?: number } = {}) {
      const sym = symOrThrow(symbol);
      if (!(tf in TIMEFRAME_SECONDS)) throw new Error(`Unknown timeframe: ${tf}`);
      const f = sym.feed;
      const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(o.limit ?? DEFAULT_LIMIT)));
      const nowSec = Math.floor(clock.now() / 1000);
      const endSec = o.endSec ?? nowSec;
      const shift = shiftOf(f);
      let bars: Candle[];
      if (endSec >= nowSec - 60) {
        // "Now": cached latest series, brought up to date with the live 1m bars (incl. the forming bar).
        const s = await latestSeries(f, tf, limit);
        const overlay = f.proxy ? f.proxy.backfilled : f.liveSince != null && f.liveSince <= s.fetchedAt;
        bars = overlay ? overlayLive(s.bars, f.bars, tf, s.coveredSec, f.ref.dayRule) : s.bars;
        if (endSec < nowSec) bars = bars.filter((b) => b.time < endSec - shift);
      } else {
        const endFeed = endSec - shift;
        bars = await cachedBars(`${f.key}|${tf}|${endFeed}|${limit}`, PAST_TTL_MS, () => f.provider.history(f.ref, tf, endFeed * 1000, limit));
      }
      return bars.slice(-limit).map((b) => presentBar(b, sym.spec, shift));
    },

    async getHistory1m(symbol, fromMs, toMs) {
      const sym = symOrThrow(symbol);
      if (!(toMs >= fromMs)) return [];
      const f = sym.feed;
      const shift = shiftOf(f);
      const from = Math.floor((fromMs - shift * 1000) / 60_000) * 60_000;
      const to = toMs - shift * 1000;
      let bars = await cachedBars(`${f.key}|h1m|${from}|${Math.floor(to / 60_000)}`, HISTORY_1M_TTL_MS, () => f.provider.history1m(f.ref, from, to));
      if (f.proxy) {
        // The delayed history ends ~10 min ago; the proxy's bars cover the rest.
        const lastReal = bars.length ? bars[bars.length - 1].time : -Infinity;
        bars = bars.concat(f.bars.filter((b) => b.time > lastReal));
      }
      return bars.filter((c) => c.time * 1000 + 60_000 > from && c.time * 1000 <= to).map((b) => presentBar(b, sym.spec, shift));
    },

    async getTrades(symbol, fromMs, toMs, maxPrints) {
      const sym = symOrThrow(symbol);
      const f = sym.feed;
      if (!f.provider.trades || !(toMs >= fromMs) || f.proxy) return null;
      const shiftMs = f.delay.delaySec * 1000;
      const prints = await f.provider.trades(f.ref, fromMs - shiftMs, toMs - shiftMs, maxPrints);
      return prints && prints.map((p) => ({ ts: p.ts + shiftMs, price: p.price }));
    },

    onGap(cb) {
      gapL.add(cb);
      return () => {
        gapL.delete(cb);
      };
    },

    getFeedStatus: () => computeStatus(),

    onFeedStatus(cb) {
      feedL.add(cb);
      return () => {
        feedL.delete(cb);
      };
    },
  };
}
