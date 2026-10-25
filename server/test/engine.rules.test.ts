import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectCode, ny, c2, HOUR } from './helpers.ts';

test('static max loss: breach liquidates at market, cancels orders, fails the account', async () => {
  const h = await setup();
  const id = h.custom({ maxLoss: { amount: 2000, mode: 'static', lockAt: null } }, 100);
  assert.equal(h.engine.snapshot(id)!.maxLossThreshold, 48_000);
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 5 }); // $10 / point
  const resting = h.order(id, { symbol: 'MNQ', side: 'buy', type: 'limit', price: 24000, qty: 1 });
  assert.ok(h.market.retained().includes('MNQ'));
  h.quote('MNQ', 24850, 24850.25, 24850);
  let s = h.engine.snapshot(id)!;
  assert.equal(s.status, 'active');
  assert.equal(s.maxLossBuffer, c2(s.equity - 48_000));
  h.quote('MNQ', 24800, 24800.25, 24800); // equity 47,994.40 ≤ 48,000
  s = h.engine.snapshot(id)!;
  assert.equal(s.status, 'failed');
  const a = h.engine.getAccount(id)!;
  assert.equal(a.endReason, 'Max loss limit breached');
  assert.equal(h.engine.bootstrap().positions.length, 0);
  assert.equal(h.store.getOrder(resting.id)?.status, 'cancelled');
  const liq = h.engine.listFills({ accountId: id, limit: 1 })[0];
  assert.equal(liq.role, 'liquidation');
  assert.equal(liq.price, 24800);
  const [tr] = h.engine.listTrades({ accountId: id, status: 'closed', limit: 1, offset: 0 });
  assert.equal(tr.exitReason, 'breach');
  assert.equal(h.events('breach').length, 1);
  assert.match(h.events('breach')[0].message, /\$100\.00 fee is gone/);
  assert.ok(h.engine.listDaily({ accountId: id })[0].flags.includes('breach'));
  assert.ok(!h.market.retained().includes('MNQ'));
  expectCode(() => h.order(id, { symbol: 'MNQ', side: 'buy' }), 'account_closed');
  h.close();
});

test('trailing intraday: follows peak equity incl. open profit, never decreases, locks at lockAt', async () => {
  const h = await setup();
  const id = h.custom({ maxLoss: { amount: 2000, mode: 'trailing_intraday', lockAt: 50_100 } });
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 1 }); // balance 49,999.38
  assert.equal(h.engine.snapshot(id)!.maxLossThreshold, 48_000);
  h.quote('MNQ', 25500, 25500.25, 25500); // equity 50,998.88
  assert.equal(h.engine.snapshot(id)!.maxLossThreshold, 48_998.88);
  h.quote('MNQ', 25200, 25200.25, 25200);
  assert.equal(h.engine.snapshot(id)!.maxLossThreshold, 48_998.88); // never moves down
  h.quote('MNQ', 26200, 26200.25, 26200); // hwm 52,398.88 → capped at lockAt
  assert.equal(h.engine.snapshot(id)!.maxLossThreshold, 50_100);
  h.quote('MNQ', 27000, 27000.25, 27000);
  assert.equal(h.engine.snapshot(id)!.maxLossThreshold, 50_100);
  assert.equal(h.engine.getAccount(id)!.highWaterMark, 53_998.88);
  h.quote('MNQ', 25050, 25050.25, 25050); // equity 50,098.88 ≤ 50,100 → open profit given back = breach
  assert.equal(h.engine.snapshot(id)!.status, 'failed');
  h.close();
});

test('trailing EOD: threshold only moves at rollover from the end-of-day balance, locks at lockAt', async () => {
  const h = await setup();
  const id = h.custom({ profitTarget: null, maxLoss: { amount: 2000, mode: 'trailing_eod', lockAt: 50_000 } });
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 1 });
  h.quote('MNQ', 25500, 25500.25, 25500);
  assert.equal(h.engine.snapshot(id)!.maxLossThreshold, 48_000); // intraday it does not move
  h.engine.closePosition({ accountId: id, symbol: 'MNQ' }); // +999.50 − 1.24
  const bal = h.engine.snapshot(id)!.balance;
  assert.equal(bal, 50_998.26);
  assert.equal(h.engine.snapshot(id)!.maxLossThreshold, 48_000);
  h.at(ny(2026, 10, 21, 17, 0)); // rollover
  let s = h.engine.snapshot(id)!;
  assert.equal(s.tradingDay, '2026-10-22');
  assert.equal(s.maxLossThreshold, 48_998.26);
  // a losing day does not lower it
  h.at(ny(2026, 10, 22, 10));
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 1 });
  h.quote('MNQ', 24800, 24800.25, 24800);
  h.engine.closePosition({ accountId: id, symbol: 'MNQ' });
  h.at(ny(2026, 10, 22, 17, 0));
  assert.equal(h.engine.snapshot(id)!.maxLossThreshold, 48_998.26);
  // a big day lifts the high-water mark past lockAt + amount → threshold locks at 50,000
  h.at(ny(2026, 10, 23, 10));
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 2 });
  h.quote('MNQ', 25700, 25700.25, 25700);
  h.engine.closePosition({ accountId: id, symbol: 'MNQ' });
  h.at(ny(2026, 10, 23, 17, 0));
  s = h.engine.snapshot(id)!;
  assert.equal(s.maxLossThreshold, 50_000);
  assert.equal(h.engine.getAccount(id)!.highWaterMark, s.balance);
  h.close();
});

test("daily loss 'fail' fails the account; 'lock' liquidates and locks until the next trading day", async () => {
  const h = await setup();
  const failId = h.custom({ dailyLoss: { amount: 500, action: 'fail' } });
  const lockId = h.custom({ dailyLoss: { amount: 500, action: 'lock' } });
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  h.order(failId, { symbol: 'MNQ', side: 'buy', qty: 1 });
  h.order(lockId, { symbol: 'MNQ', side: 'buy', qty: 1 });
  const lockOrder = h.order(lockId, { symbol: 'MNQ', side: 'buy', type: 'limit', price: 24000, qty: 1 });
  assert.equal(h.engine.snapshot(lockId)!.dailyLossThreshold, 49_500);
  h.quote('MNQ', 24750, 24750.25, 24750); // −500.50 open
  const f = h.engine.snapshot(failId)!;
  assert.equal(f.status, 'failed');
  assert.equal(h.engine.getAccount(failId)!.endReason, 'Daily loss limit breached');
  const l = h.engine.snapshot(lockId)!;
  assert.equal(l.status, 'active');
  assert.equal(l.lock?.reason, 'daily_loss');
  assert.equal(l.lock?.until, null);
  assert.equal(h.engine.bootstrap().positions.filter((p) => p.accountId === lockId).length, 0);
  assert.equal(h.store.getOrder(lockOrder.id)?.status, 'cancelled');
  const [tr] = h.engine.listTrades({ accountId: lockId, status: 'closed', limit: 1, offset: 0 });
  assert.equal(tr.exitReason, 'daily_loss');
  assert.ok(h.engine.listDaily({ accountId: lockId })[0].flags.includes('daily_loss'));
  assert.equal(h.events('locked').filter((e) => e.accountId === lockId)[0].severity, 'danger');
  expectCode(() => h.order(lockId, { symbol: 'MNQ', side: 'buy' }), 'locked', /Daily loss limit/);
  // the lock lifts at rollover
  h.at(ny(2026, 10, 21, 18, 5));
  assert.equal(h.engine.snapshot(lockId)!.lock, null);
  assert.ok(h.events('unlocked').some((e) => e.accountId === lockId));
  h.quote('MNQ', 24750, 24750.25, 24750);
  assert.equal(h.order(lockId, { symbol: 'MNQ', side: 'buy' }).status, 'filled');
  h.close();
});

test('buffer warnings at 50 % and 25 %, once per level per day', async () => {
  const h = await setup();
  const id = h.custom({ maxLoss: { amount: 1000, mode: 'static', lockAt: null }, dailyLoss: { amount: 800, action: 'lock' } });
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 1 });
  h.quote('MNQ', 24800, 24800.25, 24800); // −400.50: daily buffer 49.9 % left, max 59.9 %
  let w = h.events('warning');
  assert.equal(w.length, 1);
  assert.equal(w[0].data?.kind, 'daily');
  assert.equal(w[0].data?.level, 50);
  h.quote('MNQ', 24790, 24790.25, 24790);
  h.quote('MNQ', 24810, 24810.25, 24810);
  h.quote('MNQ', 24790, 24790.25, 24790);
  assert.equal(h.events('warning').length, 1); // not repeated
  h.quote('MNQ', 24740, 24740.25, 24740); // max buffer 48 % left
  w = h.events('warning');
  assert.equal(w.length, 2);
  assert.equal(w[1].data?.kind, 'max');
  h.quote('MNQ', 24680, 24680.25, 24680); // daily 19.9 %: jumps straight to the 25 % warning
  w = h.events('warning');
  assert.equal(w.length, 3);
  assert.equal(w[2].data?.level, 25);
  assert.equal(w[2].severity, 'danger');
  h.close();
});

test('pass blockers, consistency and min trading days; pass cancels working orders', async () => {
  const h = await setup();
  const id = h.custom({ profitTarget: 1000, minTradingDays: 2, consistencyPct: 0.5 });
  const dayTrade = (exitBid: number) => {
    h.quote('MNQ', 25000, 25000.25, 25000.25);
    h.order(id, { symbol: 'MNQ', side: 'buy', qty: 1 });
    h.quote('MNQ', exitBid, exitBid + 0.25, exitBid);
  };
  dayTrade(25300); // +599.50 gross open
  let s = h.engine.snapshot(id)!;
  assert.deepEqual(s.passBlockers, ['Trade 1 more day (2 required)']);
  h.engine.closePosition({ accountId: id, symbol: 'MNQ' }); // +598.26 net
  s = h.engine.snapshot(id)!;
  assert.equal(s.profit, 598.26);
  assert.equal(s.bestDay, 598.26);
  assert.equal(s.consistencyOk, false);
  assert.deepEqual(s.passBlockers, ['Trade 1 more day (2 required)', 'Best day is 100% of profit — max 50%. Keep trading to dilute it.']);
  h.at(ny(2026, 10, 22, 10));
  dayTrade(25300);
  const resting = h.order(id, { symbol: 'MNQ', side: 'buy', type: 'limit', price: 24000, qty: 1 });
  s = h.engine.snapshot(id)!;
  assert.equal(s.tradingDays, 2);
  assert.equal(s.passBlockers[0], 'Close your open positions to lock in the pass');
  h.engine.closePosition({ accountId: id, symbol: 'MNQ' });
  s = h.engine.snapshot(id)!;
  assert.equal(s.status, 'passed');
  assert.equal(s.profit, 1196.52);
  assert.equal(h.engine.getAccount(id)!.endReason, 'Profit target reached');
  assert.equal(h.store.getOrder(resting.id)?.status, 'cancelled');
  const passed = h.events('passed');
  assert.equal(passed.length, 1);
  assert.match(passed[0].message, /Activate your funded account/);
  assert.ok(h.engine.listDaily({ accountId: id }).at(-1)!.flags.includes('passed'));
  h.close();
});

test('multi-phase preset: passing phase 1 creates phase 2 automatically (no fee, parentId)', async () => {
  const h = await setup({ t: Date.UTC(2026, 9, 21, 14) });
  const id = h.engine.createAccount({ kind: 'evaluation', presetId: 'cfd-2step-50k' }).id;
  const a = h.engine.getAccount(id)!;
  assert.equal(a.name, '2-Step 50K · Phase 1');
  assert.equal(a.rules.rollover.tz, 'America/Toronto'); // 'local' resolved at creation
  assert.equal(a.rules.profitTarget, 5000);
  for (let day = 0; day < 4; day++) {
    h.at(Date.UTC(2026, 9, 21 + day, 14));
    h.quote('BTCUSD', 80000, 80000.1);
    h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: day < 3 ? 0.001 : 1 });
    if (day === 3) h.quote('BTCUSD', 85200, 85200.1);
    h.engine.closePosition({ accountId: id, symbol: 'BTCUSD' });
  }
  const s = h.engine.snapshot(id)!;
  assert.equal(s.tradingDays, 4);
  assert.equal(s.status, 'passed');
  const next = h.engine.listAccounts().find((x) => x.parentId === id)!;
  assert.equal(next.name, '2-Step 50K · Phase 2');
  assert.equal(next.phase, 2);
  assert.equal(next.fee, 0);
  assert.equal(next.rules.profitTarget, 2500);
  assert.equal(next.balance, 50_000);
  assert.equal(h.events('phase_passed').length, 1);
  assert.equal(h.engine.wallet().summary.feesPaid, 345); // only the phase-1 fee
  expectCode(() => h.engine.activateFunded(id), 'conflict'); // not the final phase
  h.close();
});

test('time limit: evaluation fails when not passed within maxCalendarDays', async () => {
  const h = await setup();
  const id = h.custom({ maxCalendarDays: 2 });
  h.advance(47 * HOUR);
  assert.equal(h.engine.snapshot(id)!.status, 'active');
  h.advance(HOUR);
  assert.equal(h.engine.snapshot(id)!.status, 'failed');
  assert.equal(h.engine.getAccount(id)!.endReason, 'Time limit expired');
  h.close();
});
