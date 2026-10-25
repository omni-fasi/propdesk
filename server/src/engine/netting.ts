// Position math (pure): how one execution applies to a symbol's open positions, fee split, averages.

import type { Side } from '../../../shared/types.ts';
import { round2, roundToStep, sideSign } from '../../../shared/risk.ts';

export interface Allocation {
  /** Closing parts, oldest position first: index into the given positions and the qty taken from it. */
  closes: Array<{ index: number; qty: number }>;
  /** Part that opens a new position (≥ 0). */
  open: number;
}

/**
 * A fill of `qty` (positive) on `side` against a symbol's positions (signed qty, oldest first). Positions on
 * the other side are closed first-in first-out; whatever is left opens a new position on `side` — never
 * merged into an existing one.
 */
export function allocateFill(positions: ReadonlyArray<{ qty: number }>, side: Side, qty: number, step: number): Allocation {
  const dir = sideSign(side);
  const closes: Allocation['closes'] = [];
  let left = qty;
  positions.forEach((p, index) => {
    if (left <= 0 || Math.sign(p.qty) === dir) return;
    const take = Math.min(left, Math.abs(p.qty));
    closes.push({ index, qty: take });
    left = roundToStep(left - take, step);
  });
  return { closes, open: Math.max(0, left) };
}

/** A fill's commission split over its parts in proportion to their qty, in cents, adding up to `fee` exactly. */
export function splitFee(fee: number, parts: readonly number[]): number[] {
  const total = parts.reduce((s, q) => s + q, 0);
  let rest = fee;
  return parts.map((q, i) => {
    if (i === parts.length - 1) return round2(rest);
    const f = total > 0 ? round2((fee * q) / total) : 0;
    rest = round2(rest - f);
    return f;
  });
}

/** Trim floating-point dust from a computed price (keeps sub-tick precision for averages). */
export function cleanPrice(x: number): number {
  return Number(x.toFixed(10));
}

/** Quantity-weighted average of two legs. */
export function weightedAvg(avgA: number, qtyA: number, priceB: number, qtyB: number): number {
  const total = qtyA + qtyB;
  return total > 0 ? cleanPrice((avgA * qtyA + priceB * qtyB) / total) : priceB;
}
