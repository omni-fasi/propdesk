import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectCode, ny, NY } from './helpers.ts';

test('market closed / no price / asset class / unknown account', async () => {
  const h = await setup({ t: ny(2026, 10, 24, 10) }); // Saturday
  const id = h.practice();
  expectCode(() => h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: 0.01 }), 'no_price', /No price for BTCUSD/);
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  expectCode(() => h.order(id, { symbol: 'MNQ', side: 'buy' }), 'market_closed', /^Market closed — opens Sun 6:00 PM ET$/);
  h.quote('BTCUSD', 80000, 80000.1);
  assert.equal(h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: 0.01 }).status, 'filled'); // 24/7
  h.at(ny(2026, 10, 21, 17, 30)); // CME daily break
  expectCode(() => h.order(id, { symbol: 'MNQ', side: 'buy' }), 'market_closed', /opens Wed 6:00 PM ET/);
  const fut = h.custom({ allowedClasses: ['futures'] });
  expectCode(() => h.order(fut, { symbol: 'BTCUSD', side: 'buy', qty: 0.01 }), 'rule_violation', /Crypto can't be traded/);
  expectCode(() => h.order('nope', { symbol: 'BTCUSD', side: 'buy' }), 'not_found');
  expectCode(() => h.order(id, { symbol: 'XXX', side: 'buy' }), 'invalid', /Unknown symbol/);
  h.close();
});

test('maxContracts counts micros as 0.1; working orders that no longer fit are rejected asynchronously', async () => {
  const h = await setup();
  const id = h.custom({ maxContracts: 5 });
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  h.quote('NQ', 25000, 25000.25, 25000.25);
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 50 });
  assert.equal(h.engine.snapshot(id)!.contracts, 5);
  expectCode(() => h.order(id, { symbol: 'MNQ', side: 'buy', qty: 1 }), 'rule_violation', /^Max position size is 5 contracts \(50 micros\)$/);
  expectCode(() => h.order(id, { symbol: 'NQ', side: 'buy', qty: 1 }), 'rule_violation');
  h.order(id, { symbol: 'MNQ', side: 'sell', qty: 10 }); // reducing is always allowed
  const stop = h.order(id, { symbol: 'MNQ', side: 'buy', type: 'stop', price: 25010, qty: 10 }); // fits now (5.0)
  h.order(id, { symbol: 'NQ', side: 'buy', qty: 1 }); // 4.0 + 1.0
  assert.equal(h.events('order_rejected').length, 0); // synchronous rejections create no events
  h.quote('MNQ', 25010, 25010.25, 25010.25); // stop triggers → would be 6.0
  const o = h.store.getOrder(stop.id)!;
  assert.equal(o.status, 'rejected');
  assert.match(o.rejectReason ?? '', /Max position size/);
  assert.equal(h.events('order_rejected').length, 1);
  h.close();
});

test('margin: Σ notional / leverage must stay within equity', async () => {
  const h = await setup();
  const id = h.practice(); // crypto 10×
  h.quote('BTCUSD', 80000, 80000.1);
  expectCode(() => h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: 7 }), 'insufficient_margin', /10× leverage on Crypto lets you hold up to \$500,000 of BTCUSD/);
  h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: 6 });
  assert.equal(h.engine.snapshot(id)!.marginUsed, 48_000);
  expectCode(() => h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: 1 }), 'insufficient_margin');
  assert.equal(h.order(id, { symbol: 'BTCUSD', side: 'sell', qty: 2 }).status, 'filled');
  // futures on a practice account are limited by contracts, not notional margin
  h.quote('NQ', 25000, 25000.25, 25000.25);
  assert.equal(h.order(id, { symbol: 'NQ', side: 'buy', qty: 1 }).status, 'filled');
  h.close();
});

test("rollover: day closes, day start resets; all missed rollovers are processed; 'local' resolves at creation", async () => {
  const h = await setup();
  const id = h.custom({ profitTarget: null, maxLoss: { amount: 2000, mode: 'trailing_eod', lockAt: 50_000 } });
  const local = h.engine.createAccount({ kind: 'evaluation', rules: { ...h.engine.getAccount(id)!.rules, rollover: { hour: 0, minute: 0, tz: 'local' } } });
  assert.equal(local.rules.rollover.tz, 'America/Toronto');
  assert.equal(h.engine.getAccount(h.practice())!.rules.rollover.tz, 'America/Toronto');
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 1 });
  h.quote('MNQ', 25100, 25100.25, 25100);
  h.engine.closePosition({ accountId: id, symbol: 'MNQ' });
  const bal = h.engine.snapshot(id)!.balance;
  h.at(ny(2026, 10, 26, 10)); // Monday: Wed→Thu→Fri→Sat→Sun→Mon rollovers in one go
  const a = h.engine.getAccount(id)!;
  assert.equal(a.tradingDay, '2026-10-26');
  assert.equal(a.dayStartBalance, bal);
  assert.equal(a.highWaterMark, bal);
  assert.equal(a.maxLossThreshold, Math.round((bal - 2000) * 100) / 100);
  const rolls = h.events('day_rollover').filter((e) => e.accountId === id);
  assert.equal(rolls.length, 1); // only the day that traded
  assert.match(rolls[0].title, /Wed, Oct 21/);
  const [day] = h.engine.listDaily({ accountId: id });
  assert.equal(day.day, '2026-10-21');
  assert.equal(day.endBalance, bal);
  assert.equal(h.engine.snapshot(id)!.dayRealized, 0);
  h.close();
});

test('flatBy: warning 5 min before, futures flattened and orders cancelled, no new futures until next day', async () => {
  const h = await setup({ t: ny(2026, 10, 21, 15) });
  const id = h.custom({ profitTarget: null, flatBy: { hour: 16, minute: 10, tz: NY } });
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 2 });
  const lim = h.order(id, { symbol: 'MNQ', side: 'buy', type: 'limit', price: 24900, qty: 1 });
  h.at(ny(2026, 10, 21, 16, 5));
  const warn = h.events('warning').find((e) => e.title === 'Auto-flatten in 5 minutes');
  assert.ok(warn);
  assert.match(warn.message, /4:10 PM ET/);
  // the quote is now stale (> 60 s): auto-flatten waits for a fresh price
  h.at(ny(2026, 10, 21, 16, 10));
  assert.equal(h.engine.bootstrap().positions.length, 1);
  h.clock.t += 5_000;
  h.quote('MNQ', 25020, 25020.25, 25020);
  h.advance(1_000);
  assert.equal(h.engine.bootstrap().positions.length, 0);
  assert.equal(h.store.getOrder(lim.id)?.status, 'cancelled');
  const [tr] = h.engine.listTrades({ accountId: id, status: 'closed', limit: 1, offset: 0 });
  assert.equal(tr.exitReason, 'auto_flatten');
  assert.equal(tr.avgExit, 25020);
  assert.equal(h.events('auto_flatten').length, 1);
  h.at(ny(2026, 10, 21, 16, 20));
  h.quote('MNQ', 25020, 25020.25, 25020);
  expectCode(() => h.order(id, { symbol: 'MNQ', side: 'buy' }), 'rule_violation', /Flat-by time 4:10 PM ET has passed/);
  h.at(ny(2026, 10, 21, 18, 5));
  h.quote('MNQ', 25020, 25020.25, 25020);
  assert.equal(h.order(id, { symbol: 'MNQ', side: 'buy' }).status, 'filled');
  h.close();
});

test('noWeekendHolding: everything is flattened Friday 16:55 ET and entries stay blocked over the weekend', async () => {
  const h = await setup({ t: ny(2026, 10, 23, 10) });
  const id = h.custom({ profitTarget: null, noWeekendHolding: true });
  h.quote('BTCUSD', 80000, 80000.1);
  h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: 0.1 });
  h.at(ny(2026, 10, 23, 16, 54));
  h.quote('BTCUSD', 80100, 80100.1);
  h.at(ny(2026, 10, 23, 16, 55));
  assert.equal(h.engine.bootstrap().positions.length, 0);
  h.at(ny(2026, 10, 24, 12));
  h.quote('BTCUSD', 80100, 80100.1);
  expectCode(() => h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: 0.1 }), 'rule_violation', /weekend/);
  h.at(ny(2026, 10, 25, 18, 30));
  h.quote('BTCUSD', 80100, 80100.1);
  assert.equal(h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: 0.1 }).status, 'filled');
  h.close();
});
