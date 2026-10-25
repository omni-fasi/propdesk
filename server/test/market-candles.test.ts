import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../../shared/types.ts';
import { zonedTimeToUtc } from '../../shared/time.ts';
import { aggregate, bucketStart, LiveBarBuilder, overlayLive, presentBar, shared, TtlCache } from '../src/market/candles.ts';
import { getInstrument } from '../../shared/instruments.ts';

const bar = (time: number, o: number, h: number, l: number, c: number, v = 1): Candle => ({ time, open: o, high: h, low: l, close: c, volume: v });
const T = Date.UTC(2026, 9, 21, 14, 0) / 1000; // Wed 14:00 UTC, on every intraday grid
const CME_DAY = { hour: 17, minute: 0, tz: 'America/New_York' };
const LONDON_DAY = { hour: 0, minute: 0, tz: 'Europe/London' };

test('bucketStart aligns intraday bars to the UTC grid and daily bars to the trading day', () => {
  assert.equal(bucketStart('1m', T + 59), T);
  assert.equal(bucketStart('5m', T + 299), T);
  assert.equal(bucketStart('15m', T + 901), T + 900);
  assert.equal(bucketStart('1h', T + 3599), T);
  assert.equal(bucketStart('4h', T + 3600), Date.UTC(2026, 9, 21, 12) / 1000);
  assert.equal(bucketStart('1d', T), Date.UTC(2026, 9, 21) / 1000);
  // CME trade date: Thursday 18:30 ET belongs to Friday's daily bar, Friday 16:59 ET too.
  const thu1830 = zonedTimeToUtc(2026, 10, 22, 18, 30, 'America/New_York') / 1000;
  const fri1659 = zonedTimeToUtc(2026, 10, 23, 16, 59, 'America/New_York') / 1000;
  assert.equal(bucketStart('1d', thu1830, CME_DAY), Date.UTC(2026, 9, 23) / 1000);
  assert.equal(bucketStart('1d', fri1659, CME_DAY), Date.UTC(2026, 9, 23) / 1000);
  // FX: London calendar day — 23:30 UTC in BST is already the next day.
  assert.equal(bucketStart('1d', Date.UTC(2026, 9, 22, 23, 30) / 1000, LONDON_DAY), Date.UTC(2026, 9, 23) / 1000);
});

test('aggregates 1m bars into 5m and 1h bars', () => {
  const ones = Array.from({ length: 10 }, (_, i) => bar(T + i * 60, 100 + i, 100.5 + i, 99.5 + i, 100.2 + i, i + 1));
  const fives = aggregate(ones, '5m');
  assert.deepEqual(fives, [bar(T, 100, 104.5, 99.5, 104.2, 1 + 2 + 3 + 4 + 5), bar(T + 300, 105, 109.5, 104.5, 109.2, 6 + 7 + 8 + 9 + 10)]);
  const hour = aggregate(ones, '1h');
  assert.equal(hour.length, 1);
  assert.deepEqual(hour[0], bar(T, 100, 109.5, 99.5, 109.2, 55));
});

test('aggregates 1h bars into UTC-aligned 4h bars (Yahoo has no 4h interval)', () => {
  const start = Date.UTC(2026, 9, 21, 10) / 1000; // 10:00 → buckets 08:00 (2 h) and 12:00 (4 h) and 16:00 (1 h)
  const hours = Array.from({ length: 7 }, (_, i) => bar(start + i * 3600, 10 + i, 11 + i, 9 + i, 10.5 + i, 100));
  const out = aggregate(hours, '4h');
  assert.deepEqual(
    out.map((c) => [new Date(c.time * 1000).toISOString().slice(11, 16), c.open, c.high, c.low, c.close, c.volume]),
    [
      ['08:00', 10, 12, 9, 11.5, 200],
      ['12:00', 12, 16, 11, 15.5, 400],
      ['16:00', 16, 17, 15, 16.5, 100],
    ],
  );
});

test('overlayLive brings a cached series up to date without double-counting volume', () => {
  const hist = [bar(T, 10, 11, 9, 10.5, 50), bar(T + 300, 10.5, 10.8, 10.4, 10.6, 20)]; // 5m, fetched at T+330 s
  const covered = T + 330;
  const live = [
    bar(T + 240, 1, 99, 0.1, 1, 999), // before the fetch: ignored
    bar(T + 300, 10.5, 10.9, 10.4, 10.7, 15), // minute of the fetch: extends high/close, volume not added
    bar(T + 360, 10.7, 10.75, 10.3, 10.35, 7), // after: everything merged
    bar(T + 600, 10.35, 10.4, 10.2, 10.25, 3), // new 5m bucket
  ];
  const out = overlayLive(hist, live, '5m', covered);
  assert.deepEqual(out, [bar(T, 10, 11, 9, 10.5, 50), bar(T + 300, 10.5, 10.9, 10.3, 10.35, 27), bar(T + 600, 10.35, 10.4, 10.2, 10.25, 3)]);
  // 1m: the forming bar is merged (open kept, max volume), later minutes appended.
  const one = overlayLive([bar(T + 300, 10.5, 10.6, 10.4, 10.55, 10)], [bar(T + 300, 10.45, 10.9, 10.45, 10.8, 12), bar(T + 360, 10.8, 10.8, 10.7, 10.7, 1)], '1m', T + 330);
  assert.deepEqual(one, [bar(T + 300, 10.5, 10.9, 10.4, 10.8, 12), bar(T + 360, 10.8, 10.8, 10.7, 10.7, 1)]);
  assert.equal(hist.length, 2, 'input not mutated');
});

test('LiveBarBuilder: OHLC from ticks, volume from dayVolume deltas, never negative', () => {
  const b = new LiveBarBuilder();
  const ms = T * 1000;
  assert.deepEqual(b.tick(ms + 1000, 100, 5000), bar(T, 100, 100, 100, 100, 0)); // first tick only sets the baseline
  b.tick(ms + 2000, 101, 5003);
  b.tick(ms + 3000, 99.5, 5010);
  assert.deepEqual(b.bar, bar(T, 100, 101, 99.5, 99.5, 10));
  // Session counter reset: re-baseline, no negative volume.
  assert.equal(b.tick(ms + 4000, 99.75, 12)!.volume, 10);
  assert.equal(b.tick(ms + 5000, 99.75, 20)!.volume, 18);
  // Next minute starts a new bar; a late tick for an older minute is ignored.
  assert.deepEqual(b.tick(ms + 61_000, 99, 25), bar(T + 60, 99, 99, 99, 99, 5));
  assert.equal(b.tick(ms + 59_000, 50, 26), null);
  // An authoritative bar (REST poll) replaces the forming one.
  b.set(bar(T + 60, 98.5, 99.25, 98.5, 99, 40));
  assert.deepEqual(b.tick(ms + 62_000, 99.5, 30), bar(T + 60, 98.5, 99.5, 98.5, 99.5, 44));
});

test('presentBar shifts by the feed delay and rounds to the instrument tick', () => {
  const mnq = getInstrument('MNQ')!;
  assert.deepEqual(presentBar(bar(T, 25000.13, 25001.37, 24999.9, 25000.6, 3.0000001), mnq, 600), bar(T + 600, 25000.25, 25001.25, 25000, 25000.5, 3));
});

test('TtlCache expires entries (still readable as stale) and evicts least recently used', () => {
  const c = new TtlCache<number>(2);
  c.set('a', 1, 1000, 0);
  c.set('b', 2, 1000, 0);
  assert.deepEqual(c.get('a', 500), { value: 1, fresh: true });
  c.set('c', 3, 1000, 600); // evicts b (a was used more recently)
  assert.equal(c.get('b', 600), undefined);
  assert.deepEqual(c.get('a', 1500), { value: 1, fresh: false });
  assert.equal(c.size, 2);
});

test('shared() lets concurrent identical requests use one in-flight promise', async () => {
  const inflight = new Map<string, Promise<number>>();
  let calls = 0;
  const run = () => shared(inflight, 'k', async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return 42;
  });
  assert.deepEqual(await Promise.all([run(), run(), run()]), [42, 42, 42]);
  assert.equal(calls, 1);
  assert.equal(inflight.size, 0);
  await run();
  assert.equal(calls, 2);
});
