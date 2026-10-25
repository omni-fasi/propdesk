// Top-of-book synthesis for instruments whose feed only carries trade prices (quoteModel 'last').

import type { InstrumentSpec } from '../../../shared/types.ts';
import { roundPrice, roundToStep } from '../../../shared/risk.ts';

export interface Book {
  bid: number;
  ask: number;
  last: number;
}

/** Tick-rule memory per app symbol: which side the last trade printed on, and its price. */
export interface TickRuleState {
  side: 'bid' | 'ask';
  last: number | null;
}

export function newTickRuleState(): TickRuleState {
  return { side: 'bid', last: null };
}

/** A feed-provided top of book is usable when it is positive, not crossed, has a real spread and sits near the last trade. */
export function plausibleBook(spec: InstrumentSpec, last: number, bid?: number | null, ask?: number | null): boolean {
  if (bid == null || ask == null || !(bid > 0) || !(ask > bid)) return false;
  const spread = ask - bid;
  if (spread > Math.max(spec.tickSize * 50, last * 0.005)) return false;
  return last >= bid - spread && last <= ask + spread;
}

/**
 * Quote for one app symbol from the feed's prices, rounded to the instrument's tick.
 * - bidask: the book as is (last falls back to the mid upstream).
 * - last + real book in the feed: use it.
 * - last, forex: symmetric N-tick spread around the last price.
 * - last, others (futures): tick rule — an uptick hit the ask (ask = last, bid = last − N ticks), a downtick
 *   hit the bid (bid = last, ask = last + N ticks), an unchanged price keeps the previous side.
 */
export function synthesize(spec: InstrumentSpec, input: { last: number; bid?: number | null; ask?: number | null }, state: TickRuleState): Book {
  const last = roundPrice(spec, input.last);
  if (spec.quoteModel === 'bidask') {
    const bid = input.bid != null ? roundPrice(spec, input.bid) : last;
    const ask = input.ask != null ? roundPrice(spec, input.ask) : last;
    return { bid, ask: Math.max(ask, bid), last };
  }
  const tick = spec.tickSize;
  if (plausibleBook(spec, input.last, input.bid, input.ask)) {
    const bid = roundPrice(spec, input.bid!);
    const ask = Math.max(roundPrice(spec, input.ask!), roundToStep(bid + tick, tick));
    if (state.last != null && last !== state.last) state.side = last > state.last ? 'ask' : 'bid';
    state.last = last;
    return { bid, ask, last };
  }
  const n = Math.max(1, Math.round(spec.syntheticSpreadTicks || 1));
  if (spec.assetClass === 'forex') {
    const bid = roundToStep(last - Math.floor(n / 2) * tick, tick);
    return { bid, ask: roundToStep(bid + n * tick, tick), last };
  }
  if (state.last != null && last !== state.last) state.side = last > state.last ? 'ask' : 'bid';
  state.last = last;
  return state.side === 'ask'
    ? { bid: roundToStep(last - n * tick, tick), ask: last, last }
    : { bid: last, ask: roundToStep(last + n * tick, tick), last };
}
