import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectCode, ny, type Harness } from './helpers.ts';

/** NQ gaps 60 points at once against 2 contracts (−$2,400): through max loss before any daily lock. */
function blowUp(h: Harness, id: string) {
  h.quote('NQ', 25000, 25000.25, 25000.25);
  h.order(id, { symbol: 'NQ', side: 'buy', qty: 2 });
  h.quote('NQ', 24940, 24940.25, 24940);
  assert.equal(h.engine.getAccount(id)!.status, 'failed');
}

test('wallet: fees, insufficient funds, deposits, month budget', async () => {
  const h = await setup({ wallet: 100, settings: { monthlyBudget: 300 } });
  expectCode(() => h.engine.createAccount({ kind: 'evaluation', presetId: 'fut-50k' }), 'insufficient_funds', /^Wallet balance \$100\.00 — this challenge costs \$149\.00$/);
  assert.equal(h.engine.listAccounts().length, 0);
  expectCode(() => h.engine.deposit({ amount: -5 }), 'invalid');
  h.engine.deposit({ amount: 100, note: 'top-up' });
  const acct = h.engine.createAccount({ kind: 'evaluation', presetId: 'fut-50k' });
  assert.equal(acct.name, 'Futures 50K');
  assert.equal(acct.fee, 149);
  const w = h.engine.wallet();
  assert.equal(w.summary.balance, 51);
  assert.equal(w.summary.deposited, 200);
  assert.equal(w.summary.feesPaid, 149);
  assert.equal(w.summary.monthSpent, 149);
  assert.equal(w.summary.monthBudget, 300);
  assert.equal(w.summary.net, -149);
  assert.equal(w.transactions[0].kind, 'challenge_fee');
  assert.equal(w.transactions[0].amount, -149);
  assert.equal(w.transactions[0].accountId, acct.id);
  assert.equal(h.engine.createAccount({ kind: 'practice' }).fee, 0); // practice is free
  assert.ok(h.seen.some((e) => e.type === 'wallet'));
  h.close();
});

test('retry a failed preset evaluation: reset fee, attempt numbering, parent chain', async () => {
  const h = await setup({ wallet: 1000 });
  const first = h.engine.createAccount({ kind: 'evaluation', presetId: 'fut-50k' }).id;
  expectCode(() => h.engine.retryAccount(first), 'conflict'); // still active
  blowUp(h, first);
  const second = h.engine.retryAccount(first);
  assert.equal(second.name, 'Futures 50K · Attempt 2');
  assert.equal(second.parentId, first);
  assert.equal(second.fee, 99);
  assert.equal(second.balance, 50_000);
  assert.equal(h.engine.wallet().transactions[0].kind, 'reset_fee');
  expectCode(() => h.engine.retryAccount(first), 'conflict', /already retried/);
  blowUp(h, second.id);
  assert.equal(h.engine.retryAccount(second.id).name, 'Futures 50K · Attempt 3');
  assert.equal(h.engine.wallet().summary.balance, 1000 - 149 - 99 - 99);
  h.close();
});

test('pass → activate funded → payouts (split to wallet, day start adjusted, eligibility rules)', async () => {
  const h = await setup({ wallet: 1000 });
  const evalId = h.engine.createAccount({ kind: 'evaluation', presetId: 'fut-50k' }).id;
  const round = (id: string, qty: number, exitBid: number) => {
    h.quote('MNQ', 25000, 25000.25, 25000.25);
    h.order(id, { symbol: 'MNQ', side: 'buy', qty });
    h.quote('MNQ', exitBid, exitBid + 0.25, exitBid);
    h.engine.closePosition({ accountId: id, symbol: 'MNQ' });
  };
  round(evalId, 5, 25155); // Wed +1,541.30
  h.at(ny(2026, 10, 22, 10));
  round(evalId, 5, 25155); // Thu +1,541.30 → target, 2 days, best day = 50 %
  assert.equal(h.engine.getAccount(evalId)!.status, 'passed');
  expectCode(() => h.engine.payoutEligibility('nope'), 'not_found');
  assert.match(h.engine.payoutEligibility(evalId).reasons[0], /only available on funded/);

  const funded = h.engine.activateFunded(evalId);
  assert.equal(funded.kind, 'funded');
  assert.equal(funded.name, 'Futures 50K · Funded');
  assert.equal(funded.parentId, evalId);
  assert.equal(funded.fee, 149);
  assert.equal(funded.rules.profitTarget, null);
  assert.equal(funded.payout?.profitSplit, 0.9);
  expectCode(() => h.engine.activateFunded(evalId), 'conflict', /already activated/);
  assert.equal(h.events('funded').length, 1);

  const days = [ny(2026, 10, 22, 11), ny(2026, 10, 23, 10), ny(2026, 10, 26, 10), ny(2026, 10, 27, 10), ny(2026, 10, 28, 10)];
  for (const [i, t] of days.entries()) {
    h.at(t);
    round(funded.id, 1, 25100); // +198.26 net
    const e = h.engine.payoutEligibility(funded.id);
    assert.equal(e.winningDays, i + 1);
    assert.equal(e.eligible, i === 4, e.reasons.join('; '));
  }
  const e = h.engine.payoutEligibility(funded.id);
  assert.equal(e.maxAmount, 495.65); // 50 % of $991.30
  expectCode(() => h.engine.requestPayout(funded.id, { amount: 100 }), 'invalid', /between \$250\.00 and \$495\.65/);
  const before = h.engine.snapshot(funded.id)!;
  const res = h.engine.requestPayout(funded.id, { amount: 400 });
  assert.equal(res.received, 360);
  assert.equal(res.account.balance, 50_591.3);
  assert.equal(res.account.totalPayouts, 400);
  const after = h.engine.snapshot(funded.id)!;
  assert.equal(after.dailyLossBuffer, before.dailyLossBuffer); // a payout is not a daily loss
  assert.equal(after.dayRealized, before.dayRealized);
  assert.equal(h.events('payout').length, 1);
  assert.ok(h.engine.listDaily({ accountId: funded.id }).at(-1)!.flags.includes('payout'));
  const again = h.engine.payoutEligibility(funded.id);
  assert.equal(again.eligible, false);
  assert.equal(again.winningDays, 0);
  expectCode(() => h.engine.requestPayout(funded.id, { amount: 300 }), 'rule_violation');
  const w = h.engine.wallet().summary;
  assert.equal(w.feesPaid, 298);
  assert.equal(w.payouts, 360);
  assert.equal(w.net, 62);
  assert.equal(w.balance, 1000 - 298 + 360);
  assert.equal(w.monthSpent, 298);
  h.close();
});
