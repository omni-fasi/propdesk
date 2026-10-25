// Contract between the hub and the data providers (Binance, Yahoo).
// Providers speak in provider symbols and provider ("feed") time; the hub maps feeds to app symbols,
// synthesizes quotes, applies the delay time-shift and caches candles.

import type { Candle, FeedProvider, FeedStatus, SessionKind, Timeframe, ZonedTime } from '../../../shared/types.ts';

export interface FeedRef {
  /** Provider symbol: 'NQ=F', 'BTCUSDT'. */
  feed: string;
  session: SessionKind;
  /** Trading-day boundary of the provider's daily bars. */
  dayRule: ZonedTime;
}

export interface FeedTick {
  feed: string;
  /** Provider time of the price (ms, not time-shifted). */
  ts: number;
  last?: number;
  bid?: number;
  ask?: number;
  /** Reference for changePct: previous close (Yahoo) or 24h open (Binance). */
  refPrice?: number;
  /** Cumulative session volume (Yahoo); live 1m volume is derived from its deltas. */
  dayVolume?: number;
  /**
   * stream / poll: live prices (used for delay detection and live candles).
   * seed: REST snapshot shown until live data arrives. A tick without prices only updates refPrice.
   */
  source: 'stream' | 'poll' | 'seed';
}

/** One exchange trade (aggregated by price/taker side where the exchange does so). */
export interface TradePrint {
  ts: number;
  price: number;
}

export interface ProviderSink {
  tick(t: FeedTick): void;
  /** A provider-built 1m bar (feed time). live=false: snapshot that only initializes state. */
  bar(feed: string, bar: Candle, live: boolean): void;
  /** Connection / polling state changed: re-evaluate the feed status. */
  changed(): void;
  /** Live data stopped flowing at `sinceMs` (socket closed or went silent). */
  down(sinceMs: number): void;
}

export interface ProviderStatus {
  state: FeedStatus['state'];
  message: string;
  lastMessageAt: number | null;
  /** Every connection needed by the current subscriptions is open. */
  connected: boolean;
  /** Since when `connected` has been true. */
  connectedSince: number | null;
}

export interface Provider {
  readonly name: FeedProvider;
  /** true: live 1m bars come from the provider (sink.bar); false: the hub builds them from ticks. */
  readonly nativeBars: boolean;
  start(): void;
  stop(): void;
  subscribe(ref: FeedRef): void;
  unsubscribe(feed: string): void;
  /** Fetch a REST snapshot and push it through the sink (tick source 'seed', bar live=false). */
  seed(ref: FeedRef): Promise<void>;
  /** Bars with time < endMs (feed time), oldest first, at most `limit`. May include the forming bar. */
  history(ref: FeedRef, tf: Timeframe, endMs: number, limit: number): Promise<Candle[]>;
  /** 1m bars overlapping [fromMs, toMs] (feed time), oldest first. */
  history1m(ref: FeedRef, fromMs: number, toMs: number): Promise<Candle[]>;
  /** Exchange trade prints in [fromMs, toMs] (feed time), oldest first; null when more than `maxPrints` (too long to fetch). Optional. */
  trades?(ref: FeedRef, fromMs: number, toMs: number, maxPrints: number): Promise<TradePrint[] | null>;
  status(): ProviderStatus;
  /** Re-establish connections (e.g. after the machine slept). */
  reconnect(reason: string): void;
}
