// Instrument catalog. Futures and forex stream from Yahoo; crypto, metals, energy and stock perpetuals from Binance USDⓈ-M futures.

import type { AssetClass, InstrumentSpec } from './types.ts';

type FutDef = [symbol: string, name: string, feed: string, tick: number, multiplier: number, perSide: number, mini: number, pp: number, group: string, description: string];

const futures: FutDef[] = [
  ['MNQ', 'Micro E-mini Nasdaq-100', 'NQ=F', 0.25, 2, 0.62, 0.1, 2, 'Index futures', '$0.50 per tick · $2 per point'],
  ['NQ', 'E-mini Nasdaq-100', 'NQ=F', 0.25, 20, 2.25, 1, 2, 'Index futures', '$5 per tick · $20 per point'],
  ['MES', 'Micro E-mini S&P 500', 'ES=F', 0.25, 5, 0.62, 0.1, 2, 'Index futures', '$1.25 per tick · $5 per point'],
  ['ES', 'E-mini S&P 500', 'ES=F', 0.25, 50, 2.25, 1, 2, 'Index futures', '$12.50 per tick · $50 per point'],
  ['M2K', 'Micro E-mini Russell 2000', 'RTY=F', 0.1, 5, 0.62, 0.1, 1, 'Index futures', '$0.50 per tick · $5 per point'],
  ['RTY', 'E-mini Russell 2000', 'RTY=F', 0.1, 50, 2.25, 1, 1, 'Index futures', '$5 per tick · $50 per point'],
  ['MCL', 'Micro WTI Crude Oil', 'CL=F', 0.01, 100, 0.75, 0.1, 2, 'Energy & metals futures', '$1 per tick · $100 per $1 move'],
  ['CL', 'WTI Crude Oil', 'CL=F', 0.01, 1000, 2.5, 1, 2, 'Energy & metals futures', '$10 per tick · $1,000 per $1 move'],
  ['MGC', 'Micro Gold', 'GC=F', 0.1, 10, 0.75, 0.1, 1, 'Energy & metals futures', '$1 per tick · $10 per $1 move'],
  ['GC', 'Gold', 'GC=F', 0.1, 100, 2.5, 1, 1, 'Energy & metals futures', '$10 per tick · $100 per $1 move'],
];

/**
 * Yahoo's CME prices are ~10 min late; these Binance perpetuals track the same markets in real time and
 * drive the futures live (the Dow has no perpetual that tracks it closely enough, so it is not offered).
 */
const LIVE_PROXY: Record<string, { feed: string; label: string }> = {
  'NQ=F': { feed: 'QQQUSDT', label: 'QQQ' },
  'ES=F': { feed: 'SPYUSDT', label: 'SPY' },
  'RTY=F': { feed: 'IWMUSDT', label: 'IWM' },
  'CL=F': { feed: 'CLUSDT', label: 'WTI oil' },
  'GC=F': { feed: 'XAUUSDT', label: 'gold' },
};

type PerpDef = [symbol: string, name: string, feed: string, cls: AssetClass, tick: number, step: number, pp: number, qp: number, unit: string, defaultQty: number, group: string];

const perps: PerpDef[] = [
  ['BTCUSD', 'Bitcoin', 'BTCUSDT', 'crypto', 0.1, 0.001, 1, 3, 'BTC', 0.01, 'Crypto'],
  ['ETHUSD', 'Ethereum', 'ETHUSDT', 'crypto', 0.01, 0.001, 2, 3, 'ETH', 0.1, 'Crypto'],
  ['SOLUSD', 'Solana', 'SOLUSDT', 'crypto', 0.01, 0.01, 2, 2, 'SOL', 1, 'Crypto'],
  ['XRPUSD', 'XRP', 'XRPUSDT', 'crypto', 0.0001, 0.1, 4, 1, 'XRP', 100, 'Crypto'],
  ['DOGEUSD', 'Dogecoin', 'DOGEUSDT', 'crypto', 0.00001, 1, 5, 0, 'DOGE', 1000, 'Crypto'],
  ['BNBUSD', 'BNB', 'BNBUSDT', 'crypto', 0.01, 0.01, 2, 2, 'BNB', 1, 'Crypto'],
  ['XAUUSD', 'Gold spot', 'XAUUSDT', 'metals', 0.01, 0.001, 2, 3, 'oz', 1, 'Metals & energy'],
  ['XAGUSD', 'Silver spot', 'XAGUSDT', 'metals', 0.01, 0.001, 2, 3, 'oz', 50, 'Metals & energy'],
  ['USOIL', 'WTI Crude Oil spot', 'CLUSDT', 'energy', 0.01, 0.01, 2, 2, 'bbl', 100, 'Metals & energy'],
  ['QQQ', 'Invesco QQQ (Nasdaq-100 ETF)', 'QQQUSDT', 'stocks', 0.01, 0.01, 2, 2, 'shares', 10, 'Stocks & ETFs'],
  ['SPY', 'SPDR S&P 500 ETF', 'SPYUSDT', 'stocks', 0.01, 0.01, 2, 2, 'shares', 10, 'Stocks & ETFs'],
  ['NVDA', 'NVIDIA', 'NVDAUSDT', 'stocks', 0.01, 0.01, 2, 2, 'shares', 10, 'Stocks & ETFs'],
  ['TSLA', 'Tesla', 'TSLAUSDT', 'stocks', 0.01, 0.01, 2, 2, 'shares', 10, 'Stocks & ETFs'],
  ['AAPL', 'Apple', 'AAPLUSDT', 'stocks', 0.01, 0.01, 2, 2, 'shares', 10, 'Stocks & ETFs'],
  ['AMZN', 'Amazon', 'AMZNUSDT', 'stocks', 0.01, 0.01, 2, 2, 'shares', 10, 'Stocks & ETFs'],
  ['META', 'Meta Platforms', 'METAUSDT', 'stocks', 0.01, 0.01, 2, 2, 'shares', 10, 'Stocks & ETFs'],
  ['MSFT', 'Microsoft', 'MSFTUSDT', 'stocks', 0.01, 0.01, 2, 2, 'shares', 10, 'Stocks & ETFs'],
  ['GOOGL', 'Alphabet', 'GOOGLUSDT', 'stocks', 0.01, 0.01, 2, 2, 'shares', 10, 'Stocks & ETFs'],
];

const fx: Array<[symbol: string, name: string, feed: string]> = [
  ['EURUSD', 'Euro / US Dollar', 'EURUSD=X'],
  ['GBPUSD', 'British Pound / US Dollar', 'GBPUSD=X'],
  ['AUDUSD', 'Australian Dollar / US Dollar', 'AUDUSD=X'],
  ['NZDUSD', 'New Zealand Dollar / US Dollar', 'NZDUSD=X'],
];

export const INSTRUMENTS: InstrumentSpec[] = [
  ...futures.map(([symbol, name, feed, tick, multiplier, perSide, mini, pp, group, description]): InstrumentSpec => ({
    symbol,
    name,
    assetClass: 'futures',
    group,
    provider: 'yahoo',
    feedSymbol: feed,
    liveProxy: LIVE_PROXY[feed],
    session: 'cme',
    quoteModel: 'last',
    syntheticSpreadTicks: 1,
    tickSize: tick,
    multiplier,
    qtyStep: 1,
    minQty: 1,
    qtyUnit: 'contracts',
    unitLabel: 'contracts',
    pricePrecision: pp,
    qtyPrecision: 0,
    commission: { kind: 'per_contract', perSide },
    miniEquivalent: mini,
    defaultQty: 1,
    description: `CME ${name}. ${description}.`,
  })),
  ...perps.map(([symbol, name, feed, cls, tick, step, pp, qp, unit, defaultQty, group]): InstrumentSpec => ({
    symbol,
    name,
    assetClass: cls,
    group,
    provider: 'binance',
    feedSymbol: feed,
    session: '24x7',
    quoteModel: 'bidask',
    syntheticSpreadTicks: 0,
    tickSize: tick,
    multiplier: 1,
    qtyStep: step,
    minQty: step,
    qtyUnit: cls === 'stocks' ? 'shares' : 'units',
    unitLabel: unit,
    pricePrecision: pp,
    qtyPrecision: qp,
    commission: { kind: 'percent', maker: 0.0002, taker: 0.0005 },
    miniEquivalent: null,
    defaultQty,
    description: `${name} perpetual, live order book. P&L is $1 per 1.00 move per ${unit === 'shares' ? 'share' : unit}.`,
  })),
  ...fx.map(([symbol, name, feed]): InstrumentSpec => ({
    symbol,
    name,
    assetClass: 'forex',
    group: 'Forex',
    provider: 'yahoo',
    feedSymbol: feed,
    session: 'fx',
    quoteModel: 'last',
    syntheticSpreadTicks: 6,
    tickSize: 0.00001,
    multiplier: 100_000,
    qtyStep: 0.01,
    minQty: 0.01,
    qtyUnit: 'lots',
    unitLabel: 'lots',
    pricePrecision: 5,
    qtyPrecision: 2,
    commission: { kind: 'per_contract', perSide: 3 },
    miniEquivalent: null,
    defaultQty: 1,
    description: `${name}. 1 lot = 100,000 units · $10 per pip per lot.`,
  })),
];

export const INSTRUMENT_MAP: Record<string, InstrumentSpec> = Object.fromEntries(INSTRUMENTS.map((i) => [i.symbol, i]));

export function getInstrument(symbol: string): InstrumentSpec | undefined {
  return INSTRUMENT_MAP[symbol];
}

export const DEFAULT_WATCHLIST = ['MNQ', 'MES', 'NQ', 'ES', 'MGC', 'BTCUSD', 'ETHUSD', 'SOLUSD', 'XAUUSD', 'EURUSD', 'NVDA', 'QQQ'];

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  futures: 'Futures',
  crypto: 'Crypto',
  metals: 'Metals',
  energy: 'Energy',
  stocks: 'Stocks & ETFs',
  forex: 'Forex',
};

const TV_FUTURES: Record<string, string> = {
  MNQ: 'CME_MINI:MNQ1!',
  NQ: 'CME_MINI:NQ1!',
  MES: 'CME_MINI:MES1!',
  ES: 'CME_MINI:ES1!',
  M2K: 'CME_MINI:M2K1!',
  RTY: 'CME_MINI:RTY1!',
  MCL: 'NYMEX:MCL1!',
  CL: 'NYMEX:CL1!',
  MGC: 'COMEX:MGC1!',
  GC: 'COMEX:GC1!',
};

export interface PriceSource {
  /** Short label for the chart header ("Binance perpetual"). */
  label: string;
  /** The same market on TradingView, when it lists it. */
  tradingView: string | null;
  /** Why another site can show a different price. */
  note: string;
}

/** Where an instrument's price comes from, and what to compare it with elsewhere. */
export function priceSource(spec: InstrumentSpec): PriceSource {
  if (spec.provider === 'binance') {
    return {
      label: 'Binance perpetual',
      tradingView: spec.assetClass === 'crypto' ? `BINANCE:${spec.feedSymbol}.P` : null,
      note: `Live price of Binance's ${spec.feedSymbol} perpetual futures. Spot markets (Coinbase, Binance spot) trade a few cents to a few dollars apart, so their price differs a little.`,
    };
  }
  if (spec.assetClass === 'futures') {
    return {
      label: spec.liveProxy ? 'CME · live' : 'CME via Yahoo',
      tradingView: TV_FUTURES[spec.symbol] ?? null,
      note: spec.liveProxy
        ? `Free CME data arrives about 10 minutes late, so the price moves live with Binance's ${spec.liveProxy.label} perpetual (it tracks this market in real time) and is re-anchored to the real CME price every minute. It usually sits within a few ticks of the real-time CME price.`
        : "Yahoo's free CME data usually arrives about 10 minutes late. PropDesk measures the delay and replays the prices as if live, so a real-time chart runs that much ahead.",
    };
  }
  return {
    label: 'Forex via Yahoo',
    tradingView: `FX:${spec.symbol}`,
    note: 'Forex has no single exchange: every provider quotes slightly different prices, a few pips apart.',
  };
}
