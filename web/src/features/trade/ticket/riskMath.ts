// Pure order-ticket math: entry reference, bracket prices, size-by-risk, $ risk/reward, fees, margin and
// the effect an order has on the existing position. No React, no store access — easy to reason about.

import type { InstrumentSpec, OrderType, Position, Quote, Side } from '@shared/types';
import {
  floorToStep,
  isOnStep,
  notional,
  offsetTicks,
  pnl,
  round2,
  roundPrice,
  roundQty,
  ticksBetween,
  tickValue,
} from '@shared/risk';

/** qty: units/contracts · value: $ position value (notional) · risk: $ lost at the stop, fees included. */
export type SizeMode = 'qty' | 'value' | 'risk';
/** price: absolute price · dist: distance in the instrument's distance unit (ticks / pips / points) · usd: $ at the level. */
export type BracketMode = 'price' | 'dist' | 'usd';
export type BracketKind = 'sl' | 'tp';

export interface BracketInput {
  on: boolean;
  mode: BracketMode;
  /** In the unit of `mode`. */
  value: number | null;
}

export interface TicketDraft {
  side: Side;
  type: OrderType;
  /** Limit / stop price. */
  price: number | null;
  sizeMode: SizeMode;
  qty: number | null;
  /** $ position value (size-by-value). */
  value: number | null;
  /** $ to lose at the stop incl. fees (size-by-risk). */
  risk: number | null;
  sl: BracketInput;
  tp: BracketInput;
}

// ───────────────────────────── Distance units ─────────────────────────────

export interface DistUnit {
  label: string;
  short: string;
  /** Ticks per 1 unit. */
  ticks: number;
  step: number;
  precision: number;
}

/** Futures think in ticks, forex in pips, everything else in price points. */
export function distUnit(spec: InstrumentSpec): DistUnit {
  if (spec.assetClass === 'futures') return { label: 'Ticks', short: 't', ticks: 1, step: 1, precision: 0 };
  if (spec.assetClass === 'forex') return { label: 'Pips', short: 'pip', ticks: 10, step: 0.1, precision: 1 };
  return { label: 'Points', short: 'pt', ticks: Math.round(1 / spec.tickSize), step: spec.tickSize, precision: spec.pricePrecision };
}

export function ticksToUnits(spec: InstrumentSpec, ticks: number): number {
  const u = distUnit(spec);
  return Number((ticks / u.ticks).toFixed(u.precision));
}

export function unitsToTicks(spec: InstrumentSpec, units: number): number {
  return Math.max(1, Math.round(units * distUnit(spec).ticks));
}

// ───────────────────────────── Order effect on the position ─────────────────────────────

/**
 * What an order does to the symbol's positions (taken together): open the first one, add another one next
 * to them (own bracket), reduce or close them (oldest first), or flip to the other side.
 */
export type EffectKind = 'open' | 'add' | 'reduce' | 'close' | 'flip';

export interface OrderEffect {
  kind: EffectKind;
  /** Signed position size after the fill. */
  after: number;
  /** Size that opens new exposure (0 for reduce/close). */
  opening: number;
}

export function orderEffect(posQty: number, side: Side, qty: number): OrderEffect {
  const dir = side === 'buy' ? 1 : -1;
  const after = Number((posQty + dir * qty).toFixed(10));
  if (posQty === 0) return { kind: 'open', after, opening: qty };
  if (Math.sign(posQty) === dir) return { kind: 'add', after, opening: qty };
  const abs = Math.abs(posQty);
  if (qty < abs - 1e-12) return { kind: 'reduce', after, opening: 0 };
  if (Math.abs(qty - abs) <= 1e-12) return { kind: 'close', after: 0, opening: 0 };
  return { kind: 'flip', after, opening: Number((qty - abs).toFixed(10)) };
}

export function isEntry(e: OrderEffect): boolean {
  return e.kind === 'open' || e.kind === 'add' || e.kind === 'flip';
}

// ───────────────────────────── Prices ─────────────────────────────

/** Entry reference: market = ask (buy) / bid (sell); limit/stop = the entered price. */
export function entryRef(type: OrderType, side: Side, price: number | null, quote: Quote | undefined): number | null {
  if (type !== 'market') return price != null && price > 0 ? price : null;
  if (!quote) return null;
  const p = side === 'buy' ? quote.ask : quote.bid;
  return Number.isFinite(p) && p > 0 ? p : null;
}

/** Resting limits pay the maker rate; market, stop and marketable limit orders pay taker. */
export function entryLiquidity(type: OrderType, side: Side, price: number | null, quote: Quote | undefined): 'maker' | 'taker' {
  if (type !== 'limit') return 'taker';
  if (quote && price != null) {
    const marketable = side === 'buy' ? price >= quote.ask : price <= quote.bid;
    if (marketable) return 'taker';
  }
  return 'maker';
}

/** Commission without rounding (per-unit math must not round to cents). */
export function rawFee(spec: InstrumentSpec, qty: number, price: number, liquidity: 'maker' | 'taker'): number {
  const m = spec.commission;
  if (m.kind === 'per_contract') return Math.abs(qty) * m.perSide;
  return Math.abs(qty) * price * spec.multiplier * (liquidity === 'maker' ? m.maker : m.taker);
}

/** Largest valid size whose stop-out loses ≤ risk, counting the entry fee and the (taker) stop fee. */
export function qtyForNetRisk(spec: InstrumentSpec, risk: number, entry: number, stop: number, entryLiq: 'maker' | 'taker'): number {
  const perUnit = Math.abs(entry - stop) * spec.multiplier + rawFee(spec, 1, entry, entryLiq) + rawFee(spec, 1, stop, 'taker');
  if (!(perUnit > 0) || !(risk > 0)) return 0;
  const q = floorToStep(risk / perUnit, spec.qtyStep);
  return q >= spec.minQty ? q : 0;
}

/** Largest valid size whose position value is ≤ value. */
export function qtyForValue(spec: InstrumentSpec, value: number, entry: number): number {
  if (!(entry > 0) || !(value > 0)) return 0;
  const q = roundQty(spec, value / (entry * spec.multiplier));
  return q >= spec.minQty ? q : 0;
}

/** SL sits against the trade, TP with it. */
function awayDir(kind: BracketKind, side: Side): 1 | -1 {
  const dir = side === 'buy' ? 1 : -1;
  return (kind === 'sl' ? -dir : dir) as 1 | -1;
}

export function bracketPrice(spec: InstrumentSpec, kind: BracketKind, input: BracketInput, side: Side, entry: number | null, qty: number): number | null {
  if (!input.on || input.value == null || !Number.isFinite(input.value) || input.value <= 0) return null;
  if (input.mode === 'price') return roundPrice(spec, input.value);
  if (entry == null) return null;
  const away = awayDir(kind, side);
  if (input.mode === 'dist') return offsetTicks(spec, entry, unitsToTicks(spec, input.value), away);
  const tv = tickValue(spec, qty);
  if (!(tv > 0)) return null;
  const ticks = Math.max(1, Math.round(input.value / tv));
  return offsetTicks(spec, entry, ticks, away);
}

/** Express a bracket price in `mode` units (used when switching modes and when dragging draft lines). */
export function bracketValueFromPrice(spec: InstrumentSpec, mode: BracketMode, price: number, entry: number | null, qty: number): number | null {
  if (mode === 'price') return roundPrice(spec, price);
  if (entry == null) return null;
  const ticks = ticksBetween(spec, entry, price);
  if (ticks <= 0) return null;
  if (mode === 'dist') return ticksToUnits(spec, ticks);
  return round2(ticks * tickValue(spec, qty || spec.minQty));
}

/** Ticks between entry and a bracket price (for persisting per-symbol defaults). */
export function bracketTicks(spec: InstrumentSpec, price: number | null, entry: number | null): number | null {
  if (price == null || entry == null) return null;
  const t = ticksBetween(spec, entry, price);
  return t > 0 ? t : null;
}

// ───────────────────────────── Full calculation ─────────────────────────────

export interface TicketCalc {
  entry: number | null;
  qty: number;
  /** Size-by-risk produced 0 (risk too small for the minimum size). */
  riskTooSmall: boolean;
  /** Size-by-value produced 0 (value below one minimum size). */
  valueTooSmall: boolean;
  sl: number | null;
  tp: number | null;
  slTicks: number | null;
  tpTicks: number | null;
  effect: OrderEffect;
  /** NET $ the account loses if the stop is hit: price move + entry fee + stop fee (whole resulting position). */
  risk: number | null;
  /** NET $ gained at the target: price move − entry fee − target fee. */
  reward: number | null;
  /** Price move only, before fees. */
  grossRisk: number | null;
  grossReward: number | null;
  /** Commission paid if the stop / the target is hit (entry + exit). */
  feesAtStop: number | null;
  feesAtTarget: number | null;
  /** Net reward : net risk. */
  rr: number | null;
  /** Estimated commissions to enter and exit at market (no bracket case). */
  fees: number;
  notional: number;
  /** Bracket problems and invalid input — these block submission. */
  errors: string[];
}

/** `position`: the account's positions in the symbol taken together (combinePositions), or null. */
export function calcTicket(t: TicketDraft, spec: InstrumentSpec, quote: Quote | undefined, position: Position | null): TicketCalc {
  const errors: string[] = [];
  const entry = entryRef(t.type, t.side, t.price, quote);
  const posQty = position?.qty ?? 0;

  // Stop first: size-by-risk needs its distance ($-mode SL is not offered with size-by-risk).
  const qtyInput = t.qty != null && Number.isFinite(t.qty) ? t.qty : 0;
  const slForSizing = bracketPrice(spec, 'sl', t.sl, t.side, entry, qtyInput);

  const entryLiq = entryLiquidity(t.type, t.side, t.price, quote);
  let qty = 0;
  let riskTooSmall = false;
  let valueTooSmall = false;
  if (t.sizeMode === 'risk') {
    if (entry != null && slForSizing != null && t.risk != null && t.risk > 0) {
      qty = qtyForNetRisk(spec, t.risk, entry, slForSizing, entryLiq);
      riskTooSmall = qty === 0;
    }
  } else if (t.sizeMode === 'value') {
    if (entry != null && t.value != null && t.value > 0) {
      qty = qtyForValue(spec, t.value, entry);
      valueTooSmall = qty === 0;
    }
  } else {
    qty = qtyInput > 0 ? roundQty(spec, qtyInput) : 0;
    if (qtyInput > 0 && !isOnStep(qtyInput, spec.qtyStep)) errors.push(`Quantity must be a multiple of ${spec.qtyStep}`);
  }
  if (qty > 0 && qty < spec.minQty) errors.push(`Minimum size is ${spec.minQty} ${spec.unitLabel}`);

  const effect = orderEffect(posQty, t.side, qty);
  const bracketApplies = effect.kind !== 'reduce' && effect.kind !== 'close';

  const sl = bracketApplies ? (t.sizeMode === 'risk' ? slForSizing : bracketPrice(spec, 'sl', t.sl, t.side, entry, qty)) : null;
  const tp = bracketApplies ? bracketPrice(spec, 'tp', t.tp, t.side, entry, qty) : null;

  if (entry != null && bracketApplies) {
    const dir = t.side === 'buy' ? 1 : -1;
    if (sl != null) {
      if (dir === 1 && sl >= entry) errors.push('Stop-loss of a buy must be below the entry');
      if (dir === -1 && sl <= entry) errors.push('Stop-loss of a sell must be above the entry');
    }
    if (tp != null) {
      if (dir === 1 && tp <= entry) errors.push('Take-profit of a buy must be above the entry');
      if (dir === -1 && tp >= entry) errors.push('Take-profit of a sell must be below the entry');
    }
  }

  // $ at the levels for the position this order opens: it gets its own bracket and the other positions keep
  // theirs, so only its own size counts. Fees: the entry pays on the opening size, an exit at SL (stop →
  // taker) or TP (limit → maker) on the same size.
  const px = entry ?? quote?.last ?? 0;
  const openQty = bracketApplies ? effect.opening : qty;
  const exitQty = openQty;
  const entryFee = px > 0 && openQty > 0 ? rawFee(spec, openQty, px, entryLiq) : 0;
  const fees = px > 0 && openQty > 0 ? round2(entryFee + rawFee(spec, exitQty, px, 'taker')) : 0;

  let risk: number | null = null;
  let reward: number | null = null;
  let grossRisk: number | null = null;
  let grossReward: number | null = null;
  let feesAtStop: number | null = null;
  let feesAtTarget: number | null = null;
  if (entry != null && qty > 0 && bracketApplies) {
    const dir = t.side === 'buy' ? 1 : -1;
    const move = (to: number) => pnl(spec, dir, effect.opening, entry, to);
    if (sl != null) {
      grossRisk = round2(Math.max(0, -move(sl)));
      feesAtStop = round2(entryFee + rawFee(spec, exitQty, sl, 'taker'));
      risk = round2(grossRisk + feesAtStop);
    }
    if (tp != null) {
      grossReward = round2(move(tp));
      feesAtTarget = round2(entryFee + rawFee(spec, exitQty, tp, 'maker'));
      reward = round2(grossReward - feesAtTarget);
    }
  }

  return {
    entry,
    qty,
    riskTooSmall,
    valueTooSmall,
    sl,
    tp,
    slTicks: bracketTicks(spec, sl, entry),
    tpTicks: bracketTicks(spec, tp, entry),
    effect,
    risk,
    reward,
    grossRisk,
    grossReward,
    feesAtStop,
    feesAtTarget,
    rr: risk != null && reward != null && risk > 0 ? reward / risk : null,
    fees,
    notional: px > 0 ? notional(spec, qty, px) : 0,
    errors,
  };
}

/** Default limit / stop price from the book: passive limit, stop a few ticks through the market. */
export function defaultOrderPrice(spec: InstrumentSpec, type: OrderType, side: Side, quote: Quote | undefined): number | null {
  if (!quote || type === 'market') return null;
  if (type === 'limit') return side === 'buy' ? quote.bid : quote.ask;
  const through = Math.max(4, spec.syntheticSpreadTicks * 2);
  return side === 'buy' ? offsetTicks(spec, quote.ask, through, 1) : offsetTicks(spec, quote.bid, through, -1);
}

/** Notes about a limit / stop price relative to the book (shown under the price field). */
export function priceNote(spec: InstrumentSpec, type: OrderType, side: Side, price: number | null, quote: Quote | undefined): { tone: 'muted' | 'warn'; text: string } | null {
  if (type === 'market' || price == null || !quote) return null;
  const ref = side === 'buy' ? quote.ask : quote.bid;
  const ticks = ticksBetween(spec, price, ref);
  const u = distUnit(spec);
  const dist = u.ticks === 1 ? `${ticks} tick${ticks === 1 ? '' : 's'}` : `${ticksToUnits(spec, ticks)} ${u.label.toLowerCase()}`;
  const where = price > ref ? 'above' : 'below';
  const book = side === 'buy' ? 'ask' : 'bid';
  if (type === 'limit') {
    const marketable = side === 'buy' ? price >= quote.ask : price <= quote.bid;
    if (marketable) return { tone: 'warn', text: `Marketable — fills now at the ${book} (taker fee)` };
    return { tone: 'muted', text: `${dist} ${where} the ${book} · fills at your price (maker)` };
  }
  const triggered = side === 'buy' ? price <= quote.ask : price >= quote.bid;
  if (triggered) return { tone: 'warn', text: `Stop is through the market — it triggers immediately` };
  return { tone: 'muted', text: `${dist} ${where} the ${book} · fills at market when touched` };
}
