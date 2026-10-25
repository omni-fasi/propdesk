// Chart drawings: validation of client input. Drawings are the trader's own marks on a chart; they touch no
// account state.

import type { Drawing, DrawingPoint } from '../../../shared/types.ts';
import { DRAWING_KINDS } from '../../../shared/types.ts';
import { DRAWING_POINTS } from '../../../shared/drawings.ts';
import { INSTRUMENT_MAP } from '../../../shared/instruments.ts';
import { fail } from './errors.ts';
import { asObj, num, oneOf, str } from './validation.ts';

/** Most drawings one symbol may hold. */
export const MAX_DRAWINGS_PER_SYMBOL = 500;

/** Unix seconds, 2000-01-01 … 2100-01-01. */
const MIN_TIME = 946_684_800;
const MAX_TIME = 4_102_444_800;
const MAX_PRICE = 1e9;

function point(v: unknown, what: string): DrawingPoint {
  const p = asObj(v, what);
  return {
    time: num(p.time, `${what} time`, { min: MIN_TIME, max: MAX_TIME }),
    price: num(p.price, `${what} price`, { min: 0, gt: true, max: MAX_PRICE }),
  };
}

/** A drawing from a PUT body (id from the URL). Keeps the original createdAt and symbol. */
export function parseDrawing(id: unknown, input: unknown, now: number, existing: Drawing | null): Drawing {
  const r = asObj(input, 'Drawing');
  const drawingId = str(id, 'Drawing id', 64);
  const symbol = str(r.symbol, 'Symbol', 32);
  if (!(symbol in INSTRUMENT_MAP)) fail('invalid', `Unknown symbol ${symbol}`);
  if (existing && existing.symbol !== symbol) fail('invalid', 'A drawing cannot move to another symbol');
  const kind = oneOf(r.kind, DRAWING_KINDS, 'Drawing kind');
  const n = DRAWING_POINTS[kind];
  if (!Array.isArray(r.points) || r.points.length !== n) fail('invalid', `A ${kind} drawing needs ${n} point${n === 1 ? '' : 's'}`);
  const points = r.points.map((p, i) => point(p, `Point ${i + 1}`));
  let tp: number | null = null;
  let sl: number | null = null;
  if (kind === 'long' || kind === 'short') {
    tp = num(r.tp, 'Take-profit', { min: 0, gt: true, max: MAX_PRICE });
    sl = num(r.sl, 'Stop-loss', { min: 0, gt: true, max: MAX_PRICE });
    const entry = points[0].price;
    const dir = kind === 'long' ? 1 : -1;
    if ((tp - entry) * dir <= 0 || (entry - sl) * dir <= 0) {
      fail('invalid', kind === 'long' ? 'A long needs its target above and its stop below the entry' : 'A short needs its target below and its stop above the entry');
    }
    if (points[1].time <= points[0].time) fail('invalid', 'The right edge must be after the entry');
  }
  return { id: drawingId, symbol, kind, points, tp, sl, createdAt: existing?.createdAt ?? now, updatedAt: now };
}
