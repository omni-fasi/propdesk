import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectCode, ny, MIN } from './helpers.ts';

const tilt = (t: Record<string, unknown>) => ({ tilt: { enabled: true, maxConsecutiveLosses: 0, cooldownMinutes: 15, maxTradesPerDay: null, personalDailyLoss: null, ...t } });

test('tilt guard: N losses in a row → cooldown lock; the scheduler lifts it when it expires', async () => {
  const h = await setup({ settings: tilt({ maxConsecutiveLosses: 3 }) });
  const id = h.practice();
  const loser = () => {
    h.quote('MNQ', 25000, 25000.25, 25000.25);
    h.order(id, { symbol: 'MNQ', side: 'buy' });
    h.quote('MNQ', 24995, 24995.25, 24995);
    h.engine.closePosition({ accountId: id, symbol: 'MNQ' });
  };
  loser();
  loser();
  assert.equal(h.engine.snapshot(id)!.consecutiveLosses, 2);
  assert.equal(h.engine.snapshot(id)!.lock, null);
  loser();
  const s = h.engine.snapshot(id)!;
  assert.equal(s.consecutiveLosses, 3);
  assert.equal(s.lock?.reason, 'tilt_cooldown');
  assert.equal(s.lock?.until, h.clock.t + 15 * MIN);
  const ev = h.events('locked')[0];
  assert.equal(ev.severity, 'warning');
  assert.equal(ev.message, '3 losses in a row — 15 minute cooldown');
  assert.ok(h.seen.some((e) => e.type === 'account' && e.account.lock?.reason === 'tilt_cooldown'));
  assert.ok(h.engine.listDaily({ accountId: id })[0].flags.includes('tilt'));
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  expectCode(() => h.order(id, { symbol: 'MNQ', side: 'buy' }), 'locked', /3 losses in a row/);
  h.advance(14 * MIN);
  assert.equal(h.engine.snapshot(id)!.lock?.reason, 'tilt_cooldown');
  h.advance(MIN);
  assert.equal(h.engine.snapshot(id)!.lock, null);
  assert.equal(h.events('unlocked').length, 1);
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  assert.equal(h.order(id, { symbol: 'MNQ', side: 'buy' }).status, 'filled');
  h.close();
});

test('max trades per day locks until the next trading day', async () => {
  const h = await setup({ settings: tilt({ maxTradesPerDay: 2 }) });
  const id = h.custom({ profitTarget: null });
  for (let i = 0; i < 2; i++) {
    h.quote('MNQ', 25000, 25000.25, 25000.25);
    h.order(id, { symbol: 'MNQ', side: 'buy' });
    h.quote('MNQ', 25010, 25010.25, 25010);
    h.engine.closePosition({ accountId: id, symbol: 'MNQ' });
  }
  const s = h.engine.snapshot(id)!;
  assert.equal(s.dayTrades, 2);
  assert.equal(s.lock?.reason, 'max_trades');
  assert.equal(s.lock?.until, null);
  assert.ok(h.engine.listDaily({ accountId: id })[0].flags.includes('locked'));
  expectCode(() => h.order(id, { symbol: 'MNQ', side: 'buy' }), 'locked', /next trading day/);
  h.at(ny(2026, 10, 21, 18, 1));
  assert.equal(h.engine.snapshot(id)!.lock, null);
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  assert.equal(h.order(id, { symbol: 'MNQ', side: 'buy' }).status, 'filled');
  h.close();
});

test('personal daily stop: flatten everything and lock for the day', async () => {
  const h = await setup({ settings: tilt({ personalDailyLoss: 100 }) });
  const id = h.practice();
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  h.order(id, { symbol: 'MNQ', side: 'buy' });
  h.quote('MNQ', 24960, 24960.25, 24960); // −80.50 open −0.62 fee
  assert.equal(h.engine.snapshot(id)!.lock, null);
  h.quote('MNQ', 24950, 24950.25, 24950); // −101.12 day
  const s = h.engine.snapshot(id)!;
  assert.equal(s.lock?.reason, 'personal_loss_limit');
  assert.equal(h.engine.bootstrap().positions.length, 0);
  const [tr] = h.engine.listTrades({ status: 'closed', limit: 1, offset: 0 });
  assert.equal(tr.exitReason, 'daily_loss');
  assert.equal(h.engine.listFills({ limit: 1 })[0].role, 'liquidation');
  h.close();
});

test('locked accounts may close / reduce / cancel / tighten, but not add risk; entry orders are cancelled', async () => {
  const h = await setup();
  const id = h.practice();
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 3, sl: 24990 });
  const entry = h.order(id, { symbol: 'MNQ', side: 'buy', type: 'limit', price: 24900, qty: 1 });
  const exit = h.order(id, { symbol: 'MNQ', side: 'sell', type: 'limit', price: 25100, qty: 1 });
  const acct = h.engine.takeBreak(id, { minutes: 30 });
  assert.equal(acct.lock?.reason, 'break');
  assert.equal(acct.lock?.until, h.clock.t + 30 * MIN);
  assert.equal(h.events('locked').length, 1);
  assert.deepEqual(h.engine.listDaily({ accountId: id })[0].flags, ['break']); // a break, not a rule lock
  assert.equal(h.store.getOrder(entry.id)?.status, 'cancelled');
  assert.equal(h.store.getOrder(exit.id)?.status, 'working');
  // a shorter break cannot shorten the lock
  assert.equal(h.engine.takeBreak(id, { minutes: 5 }).lock?.until, h.clock.t + 30 * MIN);
  expectCode(() => h.order(id, { symbol: 'MNQ', side: 'buy' }), 'locked', /break/);
  expectCode(() => h.order(id, { symbol: 'MNQ', side: 'sell', qty: 5 }), 'locked'); // would flip
  expectCode(() => h.engine.reversePosition({ accountId: id, symbol: 'MNQ' }), 'locked');
  expectCode(() => h.engine.setBracket({ accountId: id, symbol: 'MNQ', sl: 24980 }), 'locked', /tighten/);
  assert.equal(h.engine.setBracket({ accountId: id, symbol: 'MNQ', sl: 24995 })[0].sl, 24995);
  assert.equal(h.engine.setBracket({ accountId: id, symbol: 'MNQ', tp: 25050 })[0].tp, 25050);
  assert.equal(h.order(id, { symbol: 'MNQ', side: 'sell', qty: 1 }).role, 'exit');
  assert.equal(h.engine.cancelOrder(exit.id).status, 'cancelled');
  h.engine.flattenAccount(id);
  assert.equal(h.engine.bootstrap().positions.length, 0);
  h.advance(30 * MIN);
  assert.equal(h.engine.snapshot(id)!.lock, null);
  h.close();
});

test('settings.requireStopLoss is enforced by the server', async () => {
  const h = await setup({ settings: { requireStopLoss: true } });
  const id = h.practice();
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  expectCode(() => h.order(id, { symbol: 'MNQ', side: 'buy' }), 'stop_required');
  expectCode(() => h.order(id, { symbol: 'MNQ', side: 'buy', type: 'limit', price: 24990 }), 'stop_required');
  h.order(id, { symbol: 'MNQ', side: 'buy', sl: 24980 });
  // Every entry opens a position of its own, so a second one needs its own stop too.
  expectCode(() => h.order(id, { symbol: 'MNQ', side: 'buy' }), 'stop_required');
  h.order(id, { symbol: 'MNQ', side: 'buy', sl: 24985 });
  assert.equal(h.engine.bootstrap().positions.length, 2);
  expectCode(() => h.engine.reversePosition({ accountId: id, symbol: 'MNQ' }), 'stop_required');
  expectCode(() => h.engine.setBracket({ accountId: id, symbol: 'MNQ', sl: null }), 'stop_required');
  assert.equal(h.order(id, { symbol: 'MNQ', side: 'sell' }).status, 'filled'); // exits never need a stop
  h.close();
});

test('positions closed by one order count as one result for the losing streak', async () => {
  const h = await setup({ settings: { tilt: { enabled: true, maxConsecutiveLosses: 2, cooldownMinutes: 10, maxTradesPerDay: null, personalDailyLoss: null } } });
  const id = h.practice();
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  h.order(id, { symbol: 'MNQ', side: 'buy' });
  h.order(id, { symbol: 'MNQ', side: 'buy' });
  h.quote('MNQ', 24990, 24990.25, 24990);
  h.engine.closePosition({ accountId: id, symbol: 'MNQ' }); // two losing positions, one decision
  let s = h.engine.snapshot(id)!;
  assert.equal(s.dayTrades, 2);
  assert.equal(s.consecutiveLosses, 1);
  assert.equal(s.lock, null);
  h.order(id, { symbol: 'MNQ', side: 'buy' });
  h.quote('MNQ', 24980, 24980.25, 24980);
  h.engine.closePosition({ accountId: id, symbol: 'MNQ' }); // second loss in a row → cooldown
  s = h.engine.snapshot(id)!;
  assert.equal(s.consecutiveLosses, 2);
  assert.equal(s.lock?.reason, 'tilt_cooldown');
  h.close();
});
