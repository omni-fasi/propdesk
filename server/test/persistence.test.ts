import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setup, tempDir, ny, MIN, WED_10 } from './helpers.ts';

test('restart from the same data dir restores accounts, positions, orders, thresholds, locks, settings, wallet', async () => {
  const tmp = tempDir();
  try {
    const dbPath = join(tmp.dir, 'propdesk.db');
    const clock = { t: WED_10 };
    const h = await setup({ dbPath, clock, settings: { traderName: 'Phil', hourlyWage: 40, tilt: { enabled: true, maxConsecutiveLosses: 4, cooldownMinutes: 10, maxTradesPerDay: null, personalDailyLoss: null } } });
    const id = h.custom({ profitTarget: null, maxLoss: { amount: 2000, mode: 'trailing_eod', lockAt: 50_000 }, dailyLoss: { amount: 1000, action: 'lock' } }, 149);
    h.quote('MNQ', 25000, 25000.25, 25000.25);
    h.order(id, { symbol: 'MNQ', side: 'buy', qty: 2 });
    h.quote('MNQ', 25200, 25200.25, 25200);
    h.engine.closePosition({ accountId: id, symbol: 'MNQ' });
    h.at(ny(2026, 10, 22, 10)); // rollover moved the EOD threshold
    h.quote('MNQ', 25200, 25200.25, 25200.25);
    h.order(id, { symbol: 'MNQ', side: 'buy', qty: 1, sl: 25150, tp: 25300, tags: { mood: 'focused' } });
    h.order(id, { symbol: 'MNQ', side: 'sell', type: 'limit', price: 25280, qty: 1 }); // reduce-only exit survives locks
    h.engine.takeBreak(id, { minutes: 20 });
    h.engine.putNote('2026-10-22', { text: 'Patient day', accountId: null, mood: 'calm' });
    const before = h.engine.bootstrap();
    const daily = h.engine.listDaily({ accountId: id });
    assert.equal(before.accounts[0].maxLossThreshold, 48_796.52);
    assert.equal(before.orders.length, 1);
    h.close();

    const h2 = await setup({ dbPath, clock, market: h.market });
    const after = h2.engine.bootstrap();
    assert.deepEqual(after.accounts, before.accounts);
    assert.deepEqual(after.positions, before.positions);
    assert.deepEqual(after.orders, before.orders.filter((o) => o.status === 'working'));
    assert.deepEqual(after.openTrades, before.openTrades);
    assert.deepEqual(after.settings, before.settings);
    assert.deepEqual(after.wallet, before.wallet);
    assert.deepEqual(after.snapshots, before.snapshots.map((s) => ({ ...s, ts: clock.t })));
    assert.deepEqual(h2.engine.listDaily({ accountId: id }), daily);
    assert.equal(after.accounts[0].lock?.reason, 'break');
    assert.equal(h2.engine.listNotes('2026-10-22', '2026-10-22')[0].text, 'Patient day');
    assert.equal(after.settings.traderName, 'Phil');
    assert.equal(after.settings.tilt.maxConsecutiveLosses, 4);

    // the restored stop-loss still works
    h2.quote('MNQ', 25150, 25150.25, 25150);
    assert.equal(h2.engine.bootstrap().positions.length, 0);
    const [tr] = h2.engine.listTrades({ accountId: id, status: 'closed', limit: 1, offset: 0 });
    assert.equal(tr.exitReason, 'stop_loss');
    assert.equal(tr.tags.mood, 'focused');
    h2.close();
  } finally {
    tmp.cleanup();
  }
});

test('schema v3: days that were flagged locked only because of a break are flagged break', async () => {
  const tmp = tempDir();
  try {
    const dbPath = join(tmp.dir, 'propdesk.db');
    const clock = { t: WED_10 };
    const h = await setup({ dbPath, clock, settings: { tilt: { enabled: true, maxConsecutiveLosses: 0, cooldownMinutes: 15, maxTradesPerDay: 1, personalDailyLoss: null } } });
    const onlyBreak = h.practice();
    const both = h.practice();
    h.engine.takeBreak(onlyBreak, { minutes: 5 });
    h.engine.takeBreak(both, { minutes: 5 });
    h.advance(10 * MIN);
    h.quote('MNQ', 25000, 25000.25, 25000.25);
    h.order(both, { symbol: 'MNQ', side: 'buy' });
    h.engine.closePosition({ accountId: both, symbol: 'MNQ' }); // max trades per day → rule lock
    h.close();

    // what a v2 server stored (and no later tables)
    const db = new DatabaseSync(dbPath);
    db.exec(`UPDATE daily_stats SET flags = '["locked"]'`);
    db.exec('DROP TABLE drawings');
    db.exec('DROP TABLE book_rows');
    db.exec(`UPDATE meta SET value = '2' WHERE key = 'schema_version'`);
    db.close();

    const h2 = await setup({ dbPath, clock, market: h.market });
    assert.deepEqual(h2.engine.listDaily({ accountId: onlyBreak })[0].flags, ['break']);
    assert.deepEqual(h2.engine.listDaily({ accountId: both })[0].flags, ['locked', 'break']);
    h2.close();
  } finally {
    tmp.cleanup();
  }
});

test('schema v5: positions keyed by trade — an open position from v4 carries over and gets company', async () => {
  const tmp = tempDir();
  try {
    const dbPath = join(tmp.dir, 'propdesk.db');
    const clock = { t: WED_10 };
    const h = await setup({ dbPath, clock });
    const id = h.practice();
    h.quote('MNQ', 25000, 25000.25, 25000.25);
    h.order(id, { symbol: 'MNQ', side: 'buy', qty: 2, sl: 24980, tp: 25040 });
    const before = h.engine.bootstrap().positions;
    h.close();

    // What a v4 server stored: one row per (account, symbol).
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE positions_v4 (
        account_id TEXT NOT NULL, symbol TEXT NOT NULL, qty REAL NOT NULL, avg_price REAL NOT NULL, opened_at INTEGER NOT NULL,
        sl REAL, tp REAL, trade_id TEXT NOT NULL, mark_price REAL NOT NULL, open_pnl REAL NOT NULL, PRIMARY KEY (account_id, symbol)
      );
      INSERT INTO positions_v4 SELECT account_id, symbol, qty, avg_price, opened_at, sl, tp, trade_id, mark_price, open_pnl FROM positions;
      DROP TABLE positions;
      ALTER TABLE positions_v4 RENAME TO positions;
      DROP TABLE book_rows;
      UPDATE meta SET value = '4' WHERE key = 'schema_version';
    `);
    db.close();

    const h2 = await setup({ dbPath, clock, market: h.market });
    assert.deepEqual(h2.engine.bootstrap().positions, before);
    h2.order(id, { symbol: 'MNQ', side: 'buy', qty: 1, sl: 24990 });
    h2.close();
    const h3 = await setup({ dbPath, clock, market: h.market });
    const after = h3.engine.bootstrap().positions;
    assert.deepEqual(
      after.map((p) => [p.qty, p.sl]),
      [
        [2, 24980],
        [1, 24990],
      ],
    );
    h3.close();
  } finally {
    tmp.cleanup();
  }
});
