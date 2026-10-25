// Pure trading math shared by the engine and the order ticket.

import type { AccountRules, CommissionModel, InstrumentSpec, Side } from './types.ts';

export function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = step.toString();
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}

/** x / step with binary floating-point dust removed (1.162345 / 0.00001 → 116234.5, not 116234.4999…). */
function steps(x: number, step: number): number {
  return Number((x / step).toPrecision(12));
}

/** Round to the nearest multiple of `step`, without floating-point dust. */
export function roundToStep(x: number, step: number): number {
  return Number((Math.round(steps(x, step)) * step).toFixed(decimalsOf(step)));
}

export function floorToStep(x: number, step: number): number {
  return Number((Math.floor(steps(x, step)) * step).toFixed(decimalsOf(step)));
}

export function ceilToStep(x: number, step: number): number {
  return Number((Math.ceil(steps(x, step)) * step).toFixed(decimalsOf(step)));
}

export function roundPrice(spec: InstrumentSpec, price: number): number {
  return roundToStep(price, spec.tickSize);
}

/** Valid order quantity: floored to qtyStep (never rounds a size up). */
export function roundQty(spec: InstrumentSpec, qty: number): number {
  return floorToStep(qty, spec.qtyStep);
}

export function isOnStep(x: number, step: number): boolean {
  return Math.abs(roundToStep(x, step) - x) < step * 1e-6;
}

export function sideSign(side: Side): 1 | -1 {
  return side === 'buy' ? 1 : -1;
}

export function oppositeSide(side: Side): Side {
  return side === 'buy' ? 'sell' : 'buy';
}

/** P&L in $ of `qty` (positive) held in `direction` from `entry` to `exit`. */
export function pnl(spec: InstrumentSpec, direction: 1 | -1, qty: number, entry: number, exit: number): number {
  return (exit - entry) * direction * qty * spec.multiplier;
}

export function notional(spec: InstrumentSpec, qty: number, price: number): number {
  return Math.abs(qty) * price * spec.multiplier;
}

export function commissionFor(model: CommissionModel, spec: InstrumentSpec, qty: number, price: number, liquidity: 'maker' | 'taker'): number {
  if (model.kind === 'per_contract') return round2(Math.abs(qty) * model.perSide);
  const rate = liquidity === 'maker' ? model.maker : model.taker;
  return round2(notional(spec, qty, price) * rate);
}

/** No commission at all: practice accounts with trading fees switched off. */
export const NO_COMMISSION: CommissionModel = { kind: 'per_contract', perSide: 0 };

/** The commission schedule an account pays on `spec`. */
export function accountCommission(rules: Pick<AccountRules, 'fees'>, spec: InstrumentSpec): CommissionModel {
  return rules.fees === 'off' ? NO_COMMISSION : spec.commission;
}

/** Estimated round-trip commission (entry taker + exit taker). */
export function roundTripCommission(spec: InstrumentSpec, qty: number, price: number): number {
  return round2(commissionFor(spec.commission, spec, qty, price, 'taker') * 2);
}

/** $ lost if price moves from entry to stop (always ≥ 0). */
export function riskAmount(spec: InstrumentSpec, qty: number, entry: number, stop: number): number {
  return Math.abs(entry - stop) * Math.abs(qty) * spec.multiplier;
}

/** Largest valid qty whose loss at `stop` is ≤ risk. 0 if even minQty is too large. */
export function qtyForRisk(spec: InstrumentSpec, risk: number, entry: number, stop: number): number {
  const perUnit = Math.abs(entry - stop) * spec.multiplier;
  if (perUnit <= 0 || risk <= 0) return 0;
  const q = floorToStep(risk / perUnit, spec.qtyStep);
  return q >= spec.minQty ? q : 0;
}

export function ticksBetween(spec: InstrumentSpec, a: number, b: number): number {
  return Math.round(Math.abs(a - b) / spec.tickSize);
}

/** $ value of one tick for `qty`. */
export function tickValue(spec: InstrumentSpec, qty = 1): number {
  return spec.tickSize * spec.multiplier * Math.abs(qty);
}

/** Price `ticks` away from `base` in the given direction (+1 up, -1 down), on the tick grid. */
export function offsetTicks(spec: InstrumentSpec, base: number, ticks: number, direction: 1 | -1): number {
  return roundPrice(spec, base + direction * ticks * spec.tickSize);
}

/** Futures contracts counted toward maxContracts. */
export function contractsEquivalent(spec: InstrumentSpec, qty: number): number {
  return spec.miniEquivalent == null ? 0 : Math.abs(qty) * spec.miniEquivalent;
}

/**
 * Stop-loss / take-profit sanity for a position or entry in `direction` around `ref` (entry or current mark).
 * Returns an error message or null.
 */
export function validateBracket(direction: 1 | -1, ref: number, sl: number | null | undefined, tp: number | null | undefined): string | null {
  if (sl != null) {
    if (!Number.isFinite(sl) || sl <= 0) return 'Stop-loss price is invalid';
    if (direction === 1 && sl >= ref) return 'Stop-loss of a long must be below the price';
    if (direction === -1 && sl <= ref) return 'Stop-loss of a short must be above the price';
  }
  if (tp != null) {
    if (!Number.isFinite(tp) || tp <= 0) return 'Take-profit price is invalid';
    if (direction === 1 && tp <= ref) return 'Take-profit of a long must be above the price';
    if (direction === -1 && tp >= ref) return 'Take-profit of a short must be below the price';
  }
  return null;
}
