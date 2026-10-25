// Assembles a trade replay: the trade, its fills, its stop / target history and the price path — PropDesk's
// own recorded bid/ask when it was recording, else the exchange's trade prints (Binance), else 1-minute bars.

import type { ReplaySource, TradeReplay } from '../../../shared/api.ts';
import type { BracketChange, Candle, Fill, TickSample, Trade } from '../../../shared/types.ts';
import type { Engine } from '../engine/engine.ts';
import type { Logger, MarketHub } from '../market/types.ts';

const MIN = 60_000;
const SAMPLE_MS = 250;
/** Exchange prints are fetched for windows up to this long (Binance serves 1,000 prints per call). */
const MAX_EXCHANGE_WINDOW_MS = 2 * 60 * MIN;
const MAX_PRINTS = 60_000;
/** Recorded samples must reach this close to the entry and the exit to count as covering the trade. */
const COVER_SLACK_MS = MIN;
const CACHE_MS = 10 * MIN;
const CACHE_SIZE = 8;

export interface ReplayDeps {
  engine: Engine;
  market: MarketHub;
  log: Logger;
}

/** A few minutes of context before the entry and after the exit (more for longer trades). */
export function replayWindow(trade: Trade, now: number): { from: number; to: number } {
  const close = trade.closedAt ?? now;
  const hold = Math.max(0, close - trade.openedAt);
  const pre = Math.min(10 * MIN, Math.max(3 * MIN, hold));
  const post = Math.min(5 * MIN, Math.max(MIN, hold / 4));
  return { from: trade.openedAt - pre, to: Math.min(now, close + post) };
}

/** Exchange prints → at most one sample per 250 ms (the period's last price), only when the price moved. */
export function samplePrints(prints: Array<{ ts: number; price: number }>, stepMs = SAMPLE_MS): TickSample[] {
  const out: TickSample[] = [];
  for (const p of prints) {
    const t = Math.floor(p.ts / stepMs) * stepMs;
    const last = out[out.length - 1];
    if (last && last[0] === t) {
      last[1] = p.price;
      last[2] = p.price;
    } else if (!last || last[1] !== p.price) {
      out.push([t, p.price, p.price]);
    }
  }
  return out;
}

/**
 * Trades from before bracket recording: the initial stop from the entry, and the target when the trade
 * ended there (a take-profit fills at its price). A stop moved later can't be placed in time.
 */
export function inferBrackets(trade: Trade, fills: Fill[]): BracketChange[] {
  const tpFill = trade.exitReason === 'take_profit' ? fills.findLast((f) => f.role === 'take_profit') : undefined;
  const sl = trade.initialStop;
  const tp = tpFill?.price ?? null;
  return sl == null && tp == null ? [] : [{ ts: trade.openedAt, sl, tp }];
}

function covers(ticks: TickSample[], open: number, close: number): boolean {
  return ticks.length > 0 && ticks[0][0] <= open + COVER_SLACK_MS && ticks[ticks.length - 1][0] >= close - COVER_SLACK_MS;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const cache = new Map<string, { at: number; replay: TradeReplay }>();

export async function buildReplay(d: ReplayDeps, id: string): Promise<TradeReplay> {
  const trade = d.engine.getTrade(id);
  const now = d.engine.now();
  const key = `${id}|${trade.closedAt}`;
  const hit = trade.closedAt != null ? cache.get(key) : undefined;
  if (hit && now - hit.at < CACHE_MS) return { ...hit.replay, trade };

  const { from, to } = replayWindow(trade, now);
  const close = trade.closedAt ?? now;
  const fills = d.engine.tradeFills(trade);
  const recordedBrackets = d.engine.tradeBrackets(trade.id);
  const bars: Candle[] = await d.market.getHistory1m(trade.symbol, from, to).catch((e: unknown) => {
    d.log.warn('replay: %s bars failed: %s', trade.symbol, errText(e));
    return [];
  });

  let source: ReplaySource = 'bars';
  let ticks = d.engine.recordedTicks(trade.symbol, from, to);
  if (covers(ticks, trade.openedAt, close)) {
    source = 'recorded';
  } else {
    ticks = [];
    if (d.market.getTrades && to - from <= MAX_EXCHANGE_WINDOW_MS) {
      try {
        const prints = await d.market.getTrades(trade.symbol, from, to, MAX_PRINTS);
        if (prints?.length) {
          ticks = samplePrints(prints);
          source = 'exchange';
        }
      } catch (e) {
        d.log.warn('replay: %s trade prints failed: %s', trade.symbol, errText(e));
      }
    }
  }

  const replay: TradeReplay = {
    trade,
    fills,
    brackets: recordedBrackets.length ? recordedBrackets : inferBrackets(trade, fills),
    bracketsRecorded: recordedBrackets.length > 0,
    from,
    to,
    source,
    ticks,
    bars,
  };
  if (trade.closedAt != null) {
    cache.set(key, { at: now, replay });
    for (const k of cache.keys()) if (cache.size > CACHE_SIZE) cache.delete(k);
  }
  return replay;
}
