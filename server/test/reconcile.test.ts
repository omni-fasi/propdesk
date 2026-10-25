import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Candle } from '../../shared/types.ts';
import { INSTRUMENTS } from '../../shared/instruments.ts';
import { createFakeMarketHub } from '../src/market/fake.ts';
import { setup, expectCode, ny, tempDir, MIN, WED_10 } from './helpers.ts';

/** 1m bar starting `min` minutes after t0. */
const bar = (t0: number, min: number, open: number, high: number, low: number, close: number): Candle => ({
  time: Math.floor((t0 + min * MIN) / MIN) * 60,
  open,
  high,
  low,
  close,
  volume: 1,
});

test('replay is pessimistic: stop-loss before take-profit inside the same bar; one catch_up summary', async () => {
  const h = await setup({ t: Date.UTC(2026, 9, 21, 14) });
  const id = h.practice(100_000);
  h.quote('BTCUSD', 80000, 80000.1);
  h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: 0.1, sl: 79500, tp: 80500 });
  const t0 = h.clock.t;
  h.market.setHistory('BTCUSD', [bar(t0, 1, 80000, 80100, 79900, 80050), bar(t0, 2, 80050, 80600, 79400, 80200)]);
  h.clock.t = t0 + 10 * MIN;
  await h.engine.reconcile(t0, h.clock.t);
  assert.equal(h.engine.bootstrap().positions.length, 0);
  const fill = h.engine.listFills({ limit: 1 })[0];
  assert.equal(fill.role, 'stop_loss');
  assert.equal(fill.price, 79500);
  assert.equal(fill.ts, bar(t0, 2, 0, 0, 0, 0).time * 1000 + 30_000); // historical timestamp
  assert.equal(h.events('stop_hit').length, 0); // summarized instead
  const cu = h.events('catch_up');
  assert.equal(cu.length, 1);
  assert.match(cu[0].message, /^While you were away: stop-loss hit on BTCUSD at 79,500\.0 \(−\$57\.99\)$/);
  assert.ok(h.engine.bootstrap().events.some((e) => e.kind === 'catch_up'));
  h.close();
});

test('replay: a bar opening beyond the stop fills at the open; resting limits fill at their price', async () => {
  const h = await setup({ t: Date.UTC(2026, 9, 21, 14) });
  const id = h.practice(100_000);
  h.quote('BTCUSD', 80000, 80000.1);
  h.quote('ETHUSD', 3900, 3900.01);
  h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: 0.1, sl: 79500 });
  const lim = h.order(id, { symbol: 'ETHUSD', side: 'buy', type: 'limit', price: 3800, qty: 1, sl: 3700 });
  const t0 = h.clock.t;
  h.market.setHistory('BTCUSD', [bar(t0, 1, 79200, 79300, 79100, 79250)]);
  h.market.setHistory('ETHUSD', [bar(t0, 3, 3850, 3860, 3795, 3810)]);
  await h.engine.reconcile(t0, t0 + 10 * MIN);
  const fills = h.engine.listFills({ limit: 5 });
  const sl = fills.find((f) => f.symbol === 'BTCUSD')!;
  assert.equal(sl.price, 79200); // gapped below 79,500 → the open
  const eth = fills.find((f) => f.symbol === 'ETHUSD')!;
  assert.equal(eth.orderId, lim.id);
  assert.equal(eth.price, 3800);
  assert.equal(eth.liquidity, 'maker');
  const pos = h.engine.bootstrap().positions;
  assert.equal(pos.length, 1);
  assert.equal(pos[0].sl, 3700); // bracket from the entry order
  assert.match(h.events('catch_up')[0].message, /stop-loss hit on BTCUSD.*buy limit filled on ETHUSD at 3,800\.00/);
  h.close();
});

test('replay: max loss breach liquidates where equity crosses the threshold, bounded by the bar', async () => {
  const h = await setup();
  const id = h.custom({ maxLoss: { amount: 2000, mode: 'static', lockAt: null } });
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 5 }); // balance 49,996.90, $10 / point
  const t0 = h.clock.t;
  h.market.setHistory('MNQ', [bar(t0, 1, 24990, 25000, 24980, 24990), bar(t0, 2, 24950, 24960, 24700, 24750)]);
  await h.engine.reconcile(t0, t0 + 5 * MIN);
  const a = h.engine.getAccount(id)!;
  assert.equal(a.status, 'failed');
  const liq = h.engine.listFills({ accountId: id, limit: 1 })[0];
  assert.equal(liq.role, 'liquidation');
  assert.equal(liq.price, 24800.5); // 48,000 is crossed at 24,800.56 → rounded against the long
  assert.equal(a.balance, 47_996.3);
  assert.equal(h.events('breach').length, 1);
  assert.match(h.events('catch_up')[0].message, /max loss limit breached — account failed/);
  h.close();
});

test('replay: rollovers inside the gap are applied at their timestamps', async () => {
  const h = await setup({ t: ny(2026, 10, 21, 16) });
  const id = h.custom({ profitTarget: null });
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 1, sl: 24900 });
  const balWed = h.engine.snapshot(id)!.balance;
  const t0 = h.clock.t;
  const thu9 = ny(2026, 10, 22, 9);
  h.market.setHistory('MNQ', [bar(t0, 30, 25010, 25020, 25000, 25015), bar(thu9, 0, 24950, 24960, 24880, 24890)]);
  h.clock.t = ny(2026, 10, 22, 10);
  await h.engine.reconcile(t0, h.clock.t);
  const fill = h.engine.listFills({ accountId: id, limit: 1 })[0];
  assert.equal(fill.price, 24900);
  assert.equal(fill.tradingDay, '2026-10-22');
  const a = h.engine.getAccount(id)!;
  assert.equal(a.tradingDay, '2026-10-22');
  assert.equal(a.dayStartBalance, balWed); // set at Wed 17:00, before the stop
  const days = h.engine.listDaily({ accountId: id });
  assert.deepEqual(days.map((d) => d.day), ['2026-10-21', '2026-10-22']);
  assert.equal(days[0].endBalance, balWed);
  assert.equal(h.events('day_rollover').length, 1);
  h.close();
});

test('replay: intraday high-water mark learns from bar closes only', async () => {
  const h = await setup();
  const id = h.custom({ profitTarget: null, maxLoss: { amount: 2000, mode: 'trailing_intraday', lockAt: null } });
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 1 });
  const t0 = h.clock.t;
  h.market.setHistory('MNQ', [bar(t0, 1, 25000, 25500, 24990, 25100)]); // spiked +500 but closed +100
  await h.engine.reconcile(t0, t0 + 3 * MIN);
  const a = h.engine.getAccount(id)!;
  assert.equal(a.highWaterMark, 50_198.88); // 49,999.38 + (25,100 − 25,000.25) × 2
  assert.equal(a.maxLossThreshold, 48_198.88);
  h.close();
});

test('onGap: commands are busy while catching up; without history the first live quote after the gap decides', async () => {
  const h = await setup({ t: Date.UTC(2026, 9, 21, 14) });
  const id = h.practice(100_000);
  h.quote('BTCUSD', 80000, 80000.1);
  h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: 0.1, sl: 79500 });
  const t0 = h.clock.t;
  h.clock.t += 10 * MIN;
  h.market.emitGap({ fromMs: t0, toMs: h.clock.t, symbols: ['BTCUSD'] });
  assert.equal(h.engine.isCatchingUp(), true);
  expectCode(() => h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: 0.1 }), 'busy');
  h.quote('BTCUSD', 79000, 79000.1); // arrives during the replay: buffered
  assert.equal(h.engine.bootstrap().positions.length, 1);
  await h.engine.whenIdle();
  assert.equal(h.engine.isCatchingUp(), false);
  assert.equal(h.engine.bootstrap().positions.length, 0);
  assert.equal(h.engine.listFills({ limit: 1 })[0].price, 79000); // gap fill at the live bid
  h.close();
});

test('startup replays the downtime since last_processed_ts', async () => {
  const tmp = tempDir();
  try {
    const dbPath = join(tmp.dir, 'propdesk.db');
    const clock = { t: Date.UTC(2026, 9, 21, 14) };
    const h = await setup({ dbPath, clock });
    const id = h.practice(100_000);
    h.quote('BTCUSD', 80000, 80000.1);
    h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: 0.1, sl: 79500 });
    h.advance(1000);
    const t0 = clock.t;
    h.close(); // persists last_processed_ts = t0

    clock.t = t0 + 30 * MIN; // "laptop was asleep"
    const market = createFakeMarketHub({ instruments: INSTRUMENTS, now: () => clock.t });
    market.setHistory('BTCUSD', [bar(t0, 4, 80000, 80050, 79950, 80000), bar(t0, 5, 79900, 79950, 79400, 79450)]);
    const h2 = await setup({ dbPath, clock, market });
    assert.equal(h2.engine.bootstrap().positions.length, 0);
    const fill = h2.engine.listFills({ limit: 1 })[0];
    assert.equal(fill.price, 79500);
    assert.ok(fill.ts < clock.t && fill.ts > t0);
    assert.ok(h2.engine.bootstrap().events.some((e) => e.kind === 'catch_up' && e.accountId === id));
    h2.close();
  } finally {
    tmp.cleanup();
  }
});

test('gaps shorter than 5 s are ignored', async () => {
  const h = await setup({ t: WED_10 });
  const id = h.practice(100_000);
  h.quote('BTCUSD', 80000, 80000.1);
  h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: 0.1, sl: 79500 });
  h.market.setHistory('BTCUSD', [bar(WED_10, 0, 80000, 80000, 79000, 79000)]);
  await h.engine.reconcile(WED_10, WED_10 + 4_000);
  assert.equal(h.engine.bootstrap().positions.length, 1);
  h.close();
});
