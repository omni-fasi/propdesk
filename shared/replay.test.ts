import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candle, Fill, TickSample } from './types.ts';
import { bracketAt, defaultResolution, defaultSpeed, indexAtOrBefore, openPnlAt, openPnlRange, positionAt, replayBars, replayPath } from './replay.ts';

const bar = (min: number, o: number, h: number, l: number, c: number): Candle => ({ time: min * 60, open: o, high: h, low: l, close: c, volume: 0 });
const fill = (ts: number, side: 'buy' | 'sell', qty: number, price: number, realizedPnl = 0, fee = 0): Fill =>
  ({ ts, side, qty, price, realizedPnl, fee }) as Fill;

test('replayPath: samples, bar paths over uncovered stretches, a point at every fill', () => {
  const bars = [bar(0, 10, 12, 9, 11), bar(1, 11, 11, 8, 9), bar(2, 9, 10, 9, 10), bar(3, 10, 10, 10, 10)];
  // Only bars: open → low → high → close for the up bar, high first for the down bar.
  assert.deepEqual(
    replayPath([], bars.slice(0, 2), 0, 119_999).map((x) => [x[0], x[1]]),
    [[0, 10], [15_000, 9], [35_000, 12], [55_000, 11], [60_000, 11], [75_000, 11], [95_000, 8], [115_000, 9]],
  );
  // Samples from 0:30 to 1:00, then a 2-minute gap: filled from the bars between them.
  const ticks: TickSample[] = [[30_000, 10.4, 10.6], [60_000, 10.9, 11.1], [200_000, 9.9, 10.1]];
  const p = replayPath(ticks, bars, 30_000, 200_000, [45_000]);
  assert.deepEqual(p.map((x) => x[0]), [30_000, 45_000, 60_000, 75_000, 95_000, 115_000, 120_000, 135_000, 155_000, 175_000, 180_000, 195_000, 200_000]);
  assert.deepEqual(p[1], [45_000, 10.4, 10.6]); // the fill point repeats the price in force
  assert.equal(indexAtOrBefore(p, 59_999), 1);
  assert.equal(indexAtOrBefore(p, 29_999), -1);
});

test('replayBars: mid prices, each bar opens at the previous close, the last one is forming', () => {
  const path: TickSample[] = [[0, 9, 11], [2_000, 11, 13], [6_000, 7, 9], [7_000, 9, 9], [12_000, 1, 1]];
  assert.deepEqual(replayBars(path, 5, 7_000), [
    { time: 0, open: 10, high: 12, low: 10, close: 12, volume: 0 },
    { time: 5, open: 12, high: 12, low: 8, close: 9, volume: 0 },
  ]);
});

test('positionAt / open P&L: adds, partial exits, fees; longs marked at the bid, shorts at the ask', () => {
  const fills = [fill(1, 'buy', 2, 100, 0, 1), fill(2, 'buy', 2, 102, 0, 1), fill(3, 'sell', 3, 105, 12, 1.5), fill(4, 'sell', 1, 99, -2, 0.5)];
  assert.deepEqual(positionAt(fills, 0), { qty: 0, avg: 0, realized: 0, fees: 0, fills: 0 });
  assert.deepEqual(positionAt(fills, 2), { qty: 4, avg: 101, realized: 0, fees: 2, fills: 2 });
  assert.deepEqual(positionAt(fills, 3), { qty: 1, avg: 101, realized: 12, fees: 3.5, fills: 3 });
  assert.deepEqual(positionAt(fills, 4), { qty: 0, avg: 0, realized: 10, fees: 4, fills: 4 });
  assert.equal(openPnlAt({ multiplier: 2 }, { qty: 4, avg: 101 }, [5, 100, 100.5]), -8);
  assert.equal(openPnlAt({ multiplier: 2 }, { qty: -4, avg: 101 }, [5, 100, 100.5]), 4);
  const path: TickSample[] = [[1, 100, 100], [2, 97, 97], [3, 103, 103], [5, 90, 90]];
  assert.deepEqual(openPnlRange(path, [fill(1, 'buy', 1, 100), fill(4, 'sell', 1, 103, 3)], { multiplier: 1 }, 10), { worst: -3, best: 3 });
});

test('brackets and defaults', () => {
  const b = [{ ts: 10, sl: 1, tp: 5 }, { ts: 20, sl: 2, tp: 5 }];
  assert.equal(bracketAt(b, 5), null);
  assert.deepEqual(bracketAt(b, 25), { ts: 20, sl: 2, tp: 5 });
  assert.equal(defaultSpeed(5 * 60_000), 5);
  assert.equal(defaultSpeed(52 * 60_000), 60);
  assert.equal(defaultSpeed(10 * 3_600_000), 120);
  assert.equal(defaultResolution(5 * 60_000, false), 5);
  assert.equal(defaultResolution(52 * 60_000, false), 30);
  assert.equal(defaultResolution(5 * 60_000, true), 60);
});
