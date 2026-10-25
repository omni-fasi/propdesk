// Contract between the market-data layer (server/src/market/**) and the rest of the server.

import type { Candle, FeedStatus, InstrumentSpec, Quote, Timeframe } from '../../../shared/types.ts';

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export interface MarketGap {
  /** Last time data was known to be flowing. */
  fromMs: number;
  /** When data resumed. */
  toMs: number;
  /** App symbols that were retained during the gap. */
  symbols: string[];
}

export interface MarketHub {
  /** Connect providers. Resolves after connections are initiated (does not wait for data). */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Ref-counted interest in live data for an app symbol. `owner` is any string ('engine', 'ws:<id>'). Idempotent per owner. */
  retain(symbol: string, owner: string): void;
  release(symbol: string, owner: string): void;
  /** Drop every symbol held by `owner` (e.g. a websocket client disconnected). */
  releaseAll(owner: string): void;
  /** Latest quote for an app symbol (null until the first price arrives). Works for any symbol seen since start. */
  getQuote(symbol: string): Quote | null;
  getQuotes(): Quote[];
  /** Every quote update of every retained symbol, in arrival order, unthrottled. */
  onQuote(cb: (q: Quote) => void): () => void;
  /** Live 1m candle updates per app symbol (the forming bar, repeatedly; then the next bar). */
  onCandle(cb: (symbol: string, candle: Candle) => void): () => void;
  /** Historical candles, oldest first, ending before endSec (exclusive; default now). limit default 500, max 1500. */
  getCandles(symbol: string, tf: Timeframe, opts?: { endSec?: number; limit?: number }): Promise<Candle[]>;
  /** 1m candles covering [fromMs, toMs], oldest first — used to reconcile orders/rules over a gap. */
  getHistory1m(symbol: string, fromMs: number, toMs: number): Promise<Candle[]>;
  /** Fired after data resumes following a suspend / disconnect longer than ~5 s. */
  onGap(cb: (gap: MarketGap) => void): () => void;
  getFeedStatus(): FeedStatus[];
  onFeedStatus(cb: (feeds: FeedStatus[]) => void): () => void;
}

export interface MarketHubOptions {
  instruments: InstrumentSpec[];
  log: Logger;
  /** Directory for optional on-disk caches. */
  cacheDir?: string;
}
