// In-memory MarketHub for tests and offline development.
// Tests drive it with push(); `randomWalk: true` makes it tick by itself (PROPDESK_FAKE_MARKET=1).

import type { Candle, FeedStatus, InstrumentSpec, Quote, Timeframe } from '../../../shared/types.ts';
import { TIMEFRAME_SECONDS } from '../../../shared/types.ts';
import { roundPrice } from '../../../shared/risk.ts';
import type { MarketGap, MarketHub } from './types.ts';

const BASE_PRICES: Record<string, number> = {
  'NQ=F': 25000, 'ES=F': 6800, 'YM=F': 46000, 'RTY=F': 2450, 'CL=F': 62, 'GC=F': 4100,
  BTCUSDT: 80700, ETHUSDT: 3900, SOLUSDT: 190, XRPUSDT: 2.4, DOGEUSDT: 0.19, BNBUSDT: 1100,
  XAUUSDT: 4100, XAGUSDT: 48, CLUSDT: 62, QQQUSDT: 610, SPYUSDT: 680, NVDAUSDT: 185, TSLAUSDT: 440,
  AAPLUSDT: 260, AMZNUSDT: 225, METAUSDT: 730, MSFTUSDT: 520, GOOGLUSDT: 255,
  'EURUSD=X': 1.162, 'GBPUSD=X': 1.334, 'AUDUSD=X': 0.651, 'NZDUSD=X': 0.574,
};

type Listener<T extends unknown[]> = (...args: T) => void;

export interface FakeMarketHub extends MarketHub {
  /** Set the current price of an app symbol and emit a quote (and a 1m candle update). */
  push(symbol: string, q: { bid?: number; ask?: number; last?: number; ts?: number }): Quote;
  /** Provide history for getHistory1m / getCandles. */
  setHistory(symbol: string, candles: Candle[]): void;
  emitGap(gap: MarketGap): void;
  retained(): string[];
}

export function createFakeMarketHub(opts: { instruments: InstrumentSpec[]; randomWalk?: boolean; now?: () => number }): FakeMarketHub {
  const now = opts.now ?? Date.now;
  const specs = new Map(opts.instruments.map((i) => [i.symbol, i]));
  const quotes = new Map<string, Quote>();
  const history = new Map<string, Candle[]>();
  const live = new Map<string, Candle>();
  const owners = new Map<string, Set<string>>();
  const quoteL = new Set<Listener<[Quote]>>();
  const candleL = new Set<Listener<[string, Candle]>>();
  const gapL = new Set<Listener<[MarketGap]>>();
  const feedL = new Set<Listener<[FeedStatus[]]>>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const feeds: FeedStatus[] = [
    { provider: 'binance', state: 'live', delaySec: 0, lastMessageAt: null, message: 'simulated' },
    { provider: 'yahoo', state: 'live', delaySec: 0, lastMessageAt: null, message: 'simulated' },
  ];

  function updateCandle(symbol: string, price: number, ts: number) {
    const t = Math.floor(ts / 60000) * 60;
    let c = live.get(symbol);
    if (!c || c.time !== t) c = { time: t, open: price, high: price, low: price, close: price, volume: 0 };
    c = { ...c, high: Math.max(c.high, price), low: Math.min(c.low, price), close: price, volume: c.volume + 1 };
    live.set(symbol, c);
    for (const l of candleL) l(symbol, c);
  }

  function push(symbol: string, q: { bid?: number; ask?: number; last?: number; ts?: number }): Quote {
    const spec = specs.get(symbol);
    const prev = quotes.get(symbol);
    const last = q.last ?? (q.bid != null && q.ask != null ? (q.bid + q.ask) / 2 : prev?.last ?? 100);
    const tick = spec?.tickSize ?? 0.01;
    const bid = q.bid ?? (spec ? roundPrice(spec, last - tick / 2 - 1e-12) : last);
    const ask = q.ask ?? (spec ? roundPrice(spec, last + tick / 2 + 1e-12) : last);
    const quote: Quote = { symbol, bid, ask, last, ts: q.ts ?? now(), changePct: null };
    quotes.set(symbol, quote);
    for (const f of feeds) f.lastMessageAt = quote.ts;
    for (const l of quoteL) l(quote);
    updateCandle(symbol, last, quote.ts);
    return quote;
  }

  function walk() {
    for (const symbol of owners.keys()) {
      const spec = specs.get(symbol);
      if (!spec) continue;
      const prev = quotes.get(symbol)?.last ?? BASE_PRICES[spec.feedSymbol] ?? 100;
      const next = roundPrice(spec, prev * (1 + (Math.random() - 0.5) * 0.0008));
      const half = Math.max(1, spec.syntheticSpreadTicks || 1) * spec.tickSize;
      push(symbol, { last: next, bid: roundPrice(spec, next - half / 2), ask: roundPrice(spec, next + half / 2) });
    }
  }

  return {
    async start() {
      if (opts.randomWalk && !timer) timer = setInterval(walk, 400);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    retain(symbol, owner) {
      let s = owners.get(symbol);
      if (!s) owners.set(symbol, (s = new Set()));
      s.add(owner);
    },
    release(symbol, owner) {
      const s = owners.get(symbol);
      if (!s) return;
      s.delete(owner);
      if (s.size === 0) owners.delete(symbol);
    },
    releaseAll(owner) {
      for (const [symbol, s] of owners) {
        s.delete(owner);
        if (s.size === 0) owners.delete(symbol);
      }
    },
    getQuote: (symbol) => quotes.get(symbol) ?? null,
    getQuotes: () => [...quotes.values()],
    onQuote(cb) {
      quoteL.add(cb);
      return () => quoteL.delete(cb);
    },
    onCandle(cb) {
      candleL.add(cb);
      return () => candleL.delete(cb);
    },
    async getCandles(symbol: string, tf: Timeframe, o?: { endSec?: number; limit?: number }) {
      const end = o?.endSec ?? Math.floor(now() / 1000);
      const limit = Math.min(o?.limit ?? 500, 1500);
      const h = history.get(symbol);
      if (h) return h.filter((c) => c.time < end).slice(-limit);
      const step = TIMEFRAME_SECONDS[tf];
      const spec = specs.get(symbol);
      let p = quotes.get(symbol)?.last ?? BASE_PRICES[spec?.feedSymbol ?? ''] ?? 100;
      const out: Candle[] = [];
      const lastBar = Math.floor((end - 1) / step) * step;
      for (let i = limit - 1; i >= 0; i--) {
        const open = p;
        const close = p * (1 + (Math.random() - 0.5) * 0.004);
        const high = Math.max(open, close) * (1 + Math.random() * 0.001);
        const low = Math.min(open, close) * (1 - Math.random() * 0.001);
        out.unshift({ time: lastBar - i * step, open, high, low, close, volume: Math.round(Math.random() * 1000) });
        p = close;
      }
      return out;
    },
    async getHistory1m(symbol, fromMs, toMs) {
      const h = history.get(symbol) ?? [];
      return h.filter((c) => c.time * 1000 + 60_000 > fromMs && c.time * 1000 <= toMs);
    },
    onGap(cb) {
      gapL.add(cb);
      return () => gapL.delete(cb);
    },
    getFeedStatus: () => feeds.map((f) => ({ ...f })),
    onFeedStatus(cb) {
      feedL.add(cb);
      return () => feedL.delete(cb);
    },
    push,
    setHistory(symbol, candles) {
      history.set(symbol, candles);
    },
    emitGap(gap) {
      for (const l of gapL) l(gap);
    },
    retained: () => [...owners.keys()],
  };
}
