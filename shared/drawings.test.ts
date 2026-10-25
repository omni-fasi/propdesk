import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampLevels, distToSegment, inBox, logicalToTime, positionLevels, timeToLogical } from './drawings.ts';

// 1-minute bars at 0, 60, 120, then a gap (market closed) until 600, then 660.
const bars = [0, 60, 120, 600, 660].map((time) => ({ time }));

test('timeToLogical / logicalToTime: bar times are whole indexes and round-trip', () => {
  bars.forEach((b, i) => {
    assert.equal(timeToLogical(bars, 60, b.time), i);
    assert.equal(logicalToTime(bars, 60, i), b.time);
  });
  assert.equal(timeToLogical(bars, 60, 90), 1.5); // inside a bar
  assert.equal(logicalToTime(bars, 60, 1.5), 90);
});

test('timeToLogical: a gap lands on the next bar; outside the bars it extrapolates by the timeframe', () => {
  assert.equal(timeToLogical(bars, 60, 300), 3); // market closed between 180 and 600
  assert.equal(timeToLogical(bars, 60, 780), 6); // two bars after the last one (future)
  assert.equal(logicalToTime(bars, 60, 6), 780);
  assert.equal(timeToLogical(bars, 60, -120), -2); // before the loaded history
  assert.equal(logicalToTime(bars, 60, -2), -120);
});

test('timeToLogical: a time from a smaller timeframe falls inside the bar of a bigger one', () => {
  const hourly = [0, 3600, 7200].map((time) => ({ time }));
  assert.equal(timeToLogical(hourly, 3600, 3600 + 900), 1.25); // 15 min into the second hour
});

test('hit-test helpers', () => {
  assert.equal(distToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
  assert.equal(distToSegment({ x: 14, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5); // past the end → distance to it
  assert.ok(inBox({ x: 11, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 10 }, 2));
  assert.ok(!inBox({ x: 13, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 10 }, 2));
});

test('position tool: distances and reward / risk for longs and shorts', () => {
  const pts = [
    { time: 0, price: 100 },
    { time: 600, price: 100 },
  ];
  assert.deepEqual(positionLevels({ kind: 'long', points: pts, tp: 106, sl: 98 }), { dir: 1, entry: 100, tp: 106, sl: 98, reward: 6, risk: 2, ratio: 3 });
  assert.deepEqual(positionLevels({ kind: 'short', points: pts, tp: 95, sl: 102 }), { dir: -1, entry: 100, tp: 95, sl: 102, reward: 5, risk: 2, ratio: 2.5 });
  assert.equal(positionLevels({ kind: 'trendline', points: pts, tp: null, sl: null }), null);
});

test('clampLevels keeps target and stop a tick on their side of the entry', () => {
  assert.deepEqual(clampLevels('long', 100, 99, 101, 0.25), { tp: 100.25, sl: 99.75 });
  assert.deepEqual(clampLevels('short', 100, 99, 101, 0.25), { tp: 99, sl: 101 });
  assert.deepEqual(clampLevels('short', 100, 100, 100, 0.25), { tp: 99.75, sl: 100.25 });
});
