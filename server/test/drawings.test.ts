import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectCode, MIN } from './helpers.ts';

const T = 1_792_800_000; // unix seconds

test('drawings: create, list per symbol (oldest first), replace keeping createdAt, delete, clear', async () => {
  const h = await setup();
  const line = h.engine.putDrawing('d1', { symbol: 'SOLUSD', kind: 'hline', points: [{ time: T, price: 102.5 }], tp: null, sl: null });
  assert.equal(line.createdAt, h.clock.t);
  h.advance(MIN);
  h.engine.putDrawing('d2', { symbol: 'SOLUSD', kind: 'trendline', points: [{ time: T, price: 100 }, { time: T + 600, price: 104 }], tp: null, sl: null });
  h.engine.putDrawing('d3', { symbol: 'BTCUSD', kind: 'rect', points: [{ time: T, price: 60_000 }, { time: T + 3600, price: 61_000 }], tp: null, sl: null });
  assert.deepEqual(h.engine.listDrawings('SOLUSD').map((d) => d.id), ['d1', 'd2']);

  h.advance(MIN);
  const moved = h.engine.putDrawing('d1', { symbol: 'SOLUSD', kind: 'hline', points: [{ time: T, price: 103 }], tp: null, sl: null });
  assert.equal(moved.points[0].price, 103);
  assert.equal(moved.createdAt, line.createdAt);
  assert.equal(moved.updatedAt, h.clock.t);
  assert.deepEqual(h.engine.listDrawings('SOLUSD')[0], moved);

  assert.deepEqual(h.engine.deleteDrawing('d1'), { ok: true });
  assert.deepEqual(h.engine.deleteDrawing('d1'), { ok: true }); // already gone: still fine
  assert.deepEqual(h.engine.clearDrawings('SOLUSD'), { deleted: 1 });
  assert.equal(h.engine.listDrawings('SOLUSD').length, 0);
  assert.equal(h.engine.listDrawings('BTCUSD').length, 1);
  h.close();
});

test('drawings: position tools keep target and stop on the right sides of the entry', async () => {
  const h = await setup();
  const long = h.engine.putDrawing('p1', { symbol: 'MNQ', kind: 'long', points: [{ time: T, price: 25000 }, { time: T + 1800, price: 25000 }], tp: 25040, sl: 24980 });
  assert.equal(long.tp, 25040);
  assert.equal(long.sl, 24980);
  const short = { symbol: 'MNQ', kind: 'short' as const, points: [{ time: T, price: 25000 }, { time: T + 1800, price: 25000 }], tp: 25040, sl: 24980 };
  expectCode(() => h.engine.putDrawing('p2', short), 'invalid', /short needs its target below/);
  expectCode(() => h.engine.putDrawing('p2', { ...short, kind: 'long', points: [{ time: T, price: 25000 }, { time: T, price: 25000 }] }), 'invalid', /right edge/);
  // other kinds never store levels
  assert.equal(h.engine.putDrawing('l1', { symbol: 'MNQ', kind: 'hray', points: [{ time: T, price: 25000 }], tp: 1, sl: 2 }).tp, null);
  h.close();
});

test('drawings: invalid input is refused', async () => {
  const h = await setup();
  const base = { symbol: 'SOLUSD', kind: 'trendline' as const, points: [{ time: T, price: 100 }, { time: T + 60, price: 101 }], tp: null, sl: null };
  expectCode(() => h.engine.putDrawing('x', { ...base, symbol: 'NOPE' }), 'invalid', /Unknown symbol/);
  expectCode(() => h.engine.putDrawing('x', { ...base, kind: 'circle' as never }), 'invalid');
  expectCode(() => h.engine.putDrawing('x', { ...base, points: [{ time: T, price: 100 }] }), 'invalid', /needs 2 points/);
  expectCode(() => h.engine.putDrawing('x', { ...base, points: [{ time: T, price: -1 }, { time: T, price: 1 }] }), 'invalid');
  expectCode(() => h.engine.putDrawing('x', { ...base, points: [{ time: T * 1000, price: 100 }, { time: T, price: 1 }] }), 'invalid'); // ms, not s
  h.engine.putDrawing('x', base);
  expectCode(() => h.engine.putDrawing('x', { ...base, symbol: 'BTCUSD' }), 'invalid', /another symbol/);
  h.close();
});
