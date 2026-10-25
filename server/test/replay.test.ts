import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Trade } from '../../shared/types.ts';
import { TickRecorder } from '../src/replay/recorder.ts';
import { buildReplay, inferBrackets, replayWindow, samplePrints } from '../src/replay/build.ts';
import { setup, MIN } from './helpers.ts';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

test('recorder: keeps a pre-roll in memory, writes it when a position opens, stops after the post-roll', async () => {
  const h = await setup();
  const rec = new TickRecorder({ market: h.market, store: h.store, now: () => h.clock.t, activeSymbols: () => h.engine.positionSymbols(), log: silent, preRollMs: MIN, postRollMs: 30_000 });
  const t0 = h.clock.t;
  const step = (bid: number) => {
    h.clock.t += 1000;
    h.quote('BTCUSD', bid, bid + 0.1);
    rec.sample();
  };
  for (let i = 0; i < 90; i++) step(80_000 + i); // 90 s of prices, no position
  rec.flush();
  assert.equal(h.store.queryTicks('BTCUSD', 0, Infinity).length, 0); // nothing written without a position

  const id = h.practice();
  h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: 0.1 });
  step(80_100);
  rec.flush();
  let ticks = h.store.queryTicks('BTCUSD', 0, Infinity);
  assert.equal(ticks.length, 62); // the last minute of pre-roll (61 samples, both ends included) + the new sample
  assert.ok(ticks[0][0] >= t0 + 30_000 - 1);

  h.quote('BTCUSD', 80_100, 80_100.1); // same price again: not a new sample
  rec.sample();
  for (let i = 0; i < 5; i++) step(80_200 + i);
  h.order(id, { symbol: 'BTCUSD', side: 'sell', qty: 0.1 });
  for (let i = 0; i < 45; i++) step(80_300 + i); // 30 s post-roll, then idle
  rec.flush();
  ticks = h.store.queryTicks('BTCUSD', 0, Infinity);
  assert.equal(ticks.length, 62 + 5 + 31); // + 31 s of post-roll (both ends included)
  assert.deepEqual(ticks[62], [ticks[62][0], 80_200, 80_200.1]);
  rec.stop();
  h.close();
});

test('brackets: every stop / target a position carried is recorded once, with its time', async () => {
  const h = await setup();
  const id = h.practice();
  h.quote('BTCUSD', 80_000, 80_000.1);
  h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: 0.1, sl: 79_000, tp: 82_000 });
  const tradeId = h.engine.bootstrap().positions[0].tradeId;
  const t1 = h.clock.t;
  h.advance(MIN);
  h.engine.setBracket({ accountId: id, symbol: 'BTCUSD', sl: 79_500 });
  h.engine.setBracket({ accountId: id, symbol: 'BTCUSD', sl: 79_500 }); // unchanged: not recorded again
  h.advance(MIN);
  h.engine.setBracket({ accountId: id, symbol: 'BTCUSD', tp: null });
  assert.deepEqual(h.engine.tradeBrackets(tradeId), [
    { ts: t1, sl: 79_000, tp: 82_000 },
    { ts: t1 + MIN, sl: 79_500, tp: 82_000 },
    { ts: t1 + 2 * MIN, sl: 79_500, tp: null },
  ]);
  h.close();
});

test('replay: recorded ticks when they cover the trade, else 1-minute bars; window and fills', async () => {
  const h = await setup();
  const rec = new TickRecorder({ market: h.market, store: h.store, now: () => h.clock.t, activeSymbols: () => h.engine.positionSymbols(), log: silent });
  const id = h.practice();
  const tick = (bid: number) => {
    h.clock.t += 1000;
    h.quote('BTCUSD', bid, bid + 0.1);
    rec.sample();
  };
  for (let i = 0; i < 30; i++) tick(80_000 + i);
  h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: 0.1, sl: 79_000 });
  for (let i = 0; i < 120; i++) tick(80_030 + i);
  h.order(id, { symbol: 'BTCUSD', side: 'sell', qty: 0.1 });
  for (let i = 0; i < 10; i++) tick(80_150 - i);
  rec.flush();
  const [trade] = h.engine.listTrades({ status: 'closed', limit: 1, offset: 0 });
  const r = await buildReplay({ engine: h.engine, market: h.market, log: silent }, trade.id);
  assert.equal(r.source, 'recorded');
  assert.equal(r.from, trade.openedAt - 3 * MIN);
  assert.equal(r.to, h.clock.t); // close + 1 min is still in the future
  assert.deepEqual(r.fills.map((f) => f.side), ['buy', 'sell']);
  assert.deepEqual(r.brackets, [{ ts: trade.openedAt, sl: 79_000, tp: null }]);
  assert.equal(r.bracketsRecorded, true);
  assert.ok(r.ticks.length >= 150 && r.ticks.every((x) => x[0] >= r.from && x[0] <= r.to));

  // Another symbol's trade with nothing recorded and no trade history at the fake hub: bars only.
  h.quote('ETHUSD', 3000, 3000.1);
  h.order(id, { symbol: 'ETHUSD', side: 'buy', qty: 1 });
  h.advance(MIN);
  h.order(id, { symbol: 'ETHUSD', side: 'sell', qty: 1 });
  const [eth] = h.engine.listTrades({ status: 'closed', symbol: 'ETHUSD', limit: 1, offset: 0 });
  const r2 = await buildReplay({ engine: h.engine, market: h.market, log: silent }, eth.id);
  assert.equal(r2.source, 'bars');
  assert.deepEqual(r2.ticks, []);
  rec.stop();
  h.close();
});

test('replay helpers: window, print sampling, inferred brackets', () => {
  const base = { openedAt: 1_000_000, closedAt: 1_000_000 + 30_000, initialStop: 99, exitReason: 'take_profit' } as Trade;
  assert.deepEqual(replayWindow(base, Infinity), { from: base.openedAt - 3 * MIN, to: base.closedAt! + MIN });
  const long = { ...base, closedAt: base.openedAt + 4 * 60 * MIN };
  assert.deepEqual(replayWindow(long, Infinity), { from: long.openedAt - 10 * MIN, to: long.closedAt! + 5 * MIN });

  assert.deepEqual(
    samplePrints([
      { ts: 1000, price: 10 },
      { ts: 1100, price: 11 }, // same 250 ms period: the last price wins
      { ts: 1300, price: 11 }, // unchanged: skipped
      { ts: 1600, price: 12 },
    ]),
    [
      [1000, 11, 11],
      [1500, 12, 12],
    ],
  );

  const tpFill = { role: 'take_profit', price: 101.5 } as never;
  assert.deepEqual(inferBrackets(base, [tpFill]), [{ ts: base.openedAt, sl: 99, tp: 101.5 }]);
  assert.deepEqual(inferBrackets({ ...base, initialStop: null, exitReason: 'manual' }, []), []);
});
