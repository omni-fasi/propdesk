// Order trigger rules per quote model (pure). See SPEC §4 "Order types & fills".

import type { InstrumentSpec, Quote, Side } from '../../../shared/types.ts';

/** A resting limit fills after `last` has sat exactly at the limit price this long ('last' model). */
export const TOUCH_FILL_MS = 3000;

/** Tolerance for comparing prices that should already be on the tick grid. */
function eps(spec: InstrumentSpec): number {
  return spec.tickSize * 1e-6;
}

/** Where a market order on `side` executes: buy at the ask, sell at the bid. */
export function marketPrice(side: Side, q: Quote): number {
  return side === 'buy' ? q.ask : q.bid;
}

/** Mark of a position: longs at the bid, shorts at the ask (what closing would get). */
export function markFor(qty: number, q: Quote): number {
  return qty > 0 ? q.bid : q.ask;
}

/** Side of the order that closes a position. */
export function exitSide(qty: number): Side {
  return qty > 0 ? 'sell' : 'buy';
}

/** Stop-market trigger. bidask: buy when ask ≥ stop, sell when bid ≤ stop. last: on the trade price. */
export function stopTriggered(spec: InstrumentSpec, side: Side, stop: number, q: Quote): boolean {
  const e = eps(spec);
  const px = spec.quoteModel === 'bidask' ? (side === 'buy' ? q.ask : q.bid) : q.last;
  return side === 'buy' ? px >= stop - e : px <= stop + e;
}

/**
 * Resting limit state. 'fill': executes now at the limit price (maker).
 * 'touch': 'last' model only — the trade price sits exactly at the limit (fills after TOUCH_FILL_MS).
 * bidask: buy when ask ≤ limit, sell when bid ≥ limit. last: trade-through (buy when last < limit).
 */
export function limitState(spec: InstrumentSpec, side: Side, limit: number, q: Quote): 'fill' | 'touch' | null {
  const e = eps(spec);
  if (spec.quoteModel === 'bidask') {
    if (side === 'buy') return q.ask <= limit + e ? 'fill' : null;
    return q.bid >= limit - e ? 'fill' : null;
  }
  if (Math.abs(q.last - limit) <= e) return 'touch';
  if (side === 'buy') return q.last < limit ? 'fill' : null;
  return q.last > limit ? 'fill' : null;
}

/** A limit that would execute immediately on placement (buy limit ≥ ask, sell limit ≤ bid): taker fill at the touch. */
export function limitMarketable(spec: InstrumentSpec, side: Side, limit: number, q: Quote): boolean {
  const e = eps(spec);
  return side === 'buy' ? limit >= q.ask - e : limit <= q.bid + e;
}

/** Reference price a stop is compared against (for "must be above/below the market" messages). */
export function stopReference(spec: InstrumentSpec, side: Side, q: Quote): number {
  return spec.quoteModel === 'bidask' ? (side === 'buy' ? q.ask : q.bid) : q.last;
}
