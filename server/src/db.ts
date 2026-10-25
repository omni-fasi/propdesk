// SQLite (node:sqlite) connection + versioned schema migrations.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ZonedTime } from '../../shared/types.ts';
import { tradingDayOf } from '../../shared/time.ts';

export type Db = DatabaseSync;

interface Migration {
  version: number;
  sql?: string;
  /** Data step, run after `sql` in the same transaction. */
  run?: (db: Db) => void;
}

// Append new migrations at the end; never edit an applied one.
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL
      );

      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        preset_id TEXT,
        phase INTEGER NOT NULL,
        phase_count INTEGER NOT NULL,
        rules TEXT NOT NULL,
        payout TEXT,
        fee REAL NOT NULL,
        created_at INTEGER NOT NULL,
        ended_at INTEGER,
        end_reason TEXT,
        parent_id TEXT,
        balance REAL NOT NULL,
        high_water_mark REAL NOT NULL,
        max_loss_threshold REAL,
        day_start_balance REAL NOT NULL,
        trading_day TEXT NOT NULL,
        trading_days INTEGER NOT NULL,
        lock TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        total_payouts REAL NOT NULL DEFAULT 0,
        last_payout_at INTEGER,
        state TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX accounts_parent ON accounts (parent_id);

      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        type TEXT NOT NULL,
        qty REAL NOT NULL,
        price REAL,
        status TEXT NOT NULL,
        role TEXT NOT NULL,
        reduce_only INTEGER NOT NULL,
        sl REAL,
        tp REAL,
        tags TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        filled_at INTEGER,
        fill_price REAL,
        reject_reason TEXT
      );
      CREATE INDEX orders_account_ts ON orders (account_id, created_at);
      CREATE INDEX orders_status ON orders (status);

      CREATE TABLE positions (
        account_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        qty REAL NOT NULL,
        avg_price REAL NOT NULL,
        opened_at INTEGER NOT NULL,
        sl REAL,
        tp REAL,
        trade_id TEXT NOT NULL,
        mark_price REAL NOT NULL,
        open_pnl REAL NOT NULL,
        PRIMARY KEY (account_id, symbol)
      );

      CREATE TABLE fills (
        id TEXT PRIMARY KEY,
        order_id TEXT,
        account_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        qty REAL NOT NULL,
        price REAL NOT NULL,
        fee REAL NOT NULL,
        realized_pnl REAL NOT NULL,
        liquidity TEXT NOT NULL,
        role TEXT NOT NULL,
        ts INTEGER NOT NULL,
        trading_day TEXT NOT NULL,
        trade_id TEXT NOT NULL
      );
      CREATE INDEX fills_account_ts ON fills (account_id, ts);
      CREATE INDEX fills_ts ON fills (ts);
      CREATE INDEX fills_trade ON fills (trade_id);

      CREATE TABLE trades (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        status TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        max_qty REAL NOT NULL,
        entry_qty REAL NOT NULL,
        exit_qty REAL NOT NULL,
        avg_entry REAL NOT NULL,
        avg_exit REAL,
        gross_pnl REAL NOT NULL,
        fees REAL NOT NULL,
        net_pnl REAL NOT NULL,
        initial_stop REAL,
        risk_amount REAL,
        r_multiple REAL,
        mae REAL NOT NULL,
        mfe REAL NOT NULL,
        exit_reason TEXT,
        trading_day TEXT NOT NULL,
        tags TEXT NOT NULL,
        review TEXT
      );
      CREATE INDEX trades_account_opened ON trades (account_id, opened_at);
      CREATE INDEX trades_account_day ON trades (account_id, trading_day);
      CREATE INDEX trades_status ON trades (status);

      CREATE TABLE daily_stats (
        account_id TEXT NOT NULL,
        day TEXT NOT NULL,
        start_balance REAL NOT NULL,
        end_balance REAL NOT NULL,
        gross_pnl REAL NOT NULL,
        fees REAL NOT NULL,
        net_pnl REAL NOT NULL,
        trades INTEGER NOT NULL,
        wins INTEGER NOT NULL,
        losses INTEGER NOT NULL,
        fills INTEGER NOT NULL,
        high_equity REAL NOT NULL,
        low_equity REAL NOT NULL,
        flags TEXT NOT NULL,
        PRIMARY KEY (account_id, day)
      );
      CREATE INDEX daily_day ON daily_stats (day);

      CREATE TABLE equity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        balance REAL NOT NULL,
        equity REAL NOT NULL
      );
      CREATE INDEX equity_account_ts ON equity (account_id, ts);

      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        data TEXT
      );
      CREATE INDEX events_ts ON events (ts);
      CREATE INDEX events_account_ts ON events (account_id, ts);

      CREATE TABLE wallet_tx (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        amount REAL NOT NULL,
        account_id TEXT,
        note TEXT,
        balance_after REAL NOT NULL
      );
      CREATE INDEX wallet_ts ON wallet_tx (ts);

      CREATE TABLE notes (
        day TEXT NOT NULL,
        account_id TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        mood TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (day, account_id)
      );
    `,
  },
  {
    version: 2,
    sql: `
      -- Trade replays: bid/ask samples recorded while positions are open (plus a pre/post roll).
      CREATE TABLE ticks (
        symbol TEXT NOT NULL,
        ts INTEGER NOT NULL,
        bid REAL NOT NULL,
        ask REAL NOT NULL,
        PRIMARY KEY (symbol, ts)
      ) WITHOUT ROWID;
      CREATE INDEX ticks_ts ON ticks (ts);

      -- Every stop-loss / take-profit a trade's position carried, from ts on.
      CREATE TABLE trade_brackets (
        trade_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        sl REAL,
        tp REAL,
        PRIMARY KEY (trade_id, ts)
      ) WITHOUT ROWID;
    `,
  },
  {
    version: 3,
    // Voluntary breaks get their own day flag ('break'); they used to be flagged 'locked' like rule locks.
    run: relabelBreakDays,
  },
  {
    version: 4,
    sql: `
      -- Chart drawings (trend lines, levels, boxes, position tools), per symbol.
      CREATE TABLE drawings (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        kind TEXT NOT NULL,
        points TEXT NOT NULL,
        tp REAL,
        sl REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX drawings_symbol ON drawings (symbol, created_at);
    `,
  },
  {
    version: 5,
    sql: `
      -- Several positions per (account, symbol): a position is identified by its trade.
      CREATE TABLE positions_v5 (
        trade_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        qty REAL NOT NULL,
        avg_price REAL NOT NULL,
        opened_at INTEGER NOT NULL,
        sl REAL,
        tp REAL,
        mark_price REAL NOT NULL,
        open_pnl REAL NOT NULL
      );
      INSERT INTO positions_v5 (trade_id, account_id, symbol, qty, avg_price, opened_at, sl, tp, mark_price, open_pnl)
        SELECT trade_id, account_id, symbol, qty, avg_price, opened_at, sl, tp, mark_price, open_pnl FROM positions ORDER BY opened_at, rowid;
      DROP TABLE positions;
      ALTER TABLE positions_v5 RENAME TO positions;
      CREATE INDEX positions_account ON positions (account_id, symbol);
    `,
  },
  {
    version: 6,
    sql: `
      -- Order book heatmap: average resting size per price bucket, one row per symbol and minute.
      CREATE TABLE book_rows (
        symbol TEXT NOT NULL,
        t INTEGER NOT NULL,
        step REAL NOT NULL,
        bids TEXT NOT NULL,
        asks TEXT NOT NULL,
        PRIMARY KEY (symbol, t)
      ) WITHOUT ROWID;
      CREATE INDEX book_rows_t ON book_rows (t);
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** Open (or create) the database at `path` (':memory:' for tests) and apply pending migrations. */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5000 });
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const current = row ? Number(row.value) : 0;
  if (current > SCHEMA_VERSION) {
    throw new Error(`Database schema v${current} is newer than this server (v${SCHEMA_VERSION}). Update PropDesk.`);
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (m.sql) db.exec(m.sql);
      m.run?.(db);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
        String(m.version),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** v3: days flagged 'locked' because of a break → 'break' ('locked' stays when a rule lock happened too). */
function relabelBreakDays(db: Db): void {
  const rollover = new Map<string, ZonedTime>();
  for (const r of db.prepare('SELECT id, rules FROM accounts').all()) rollover.set(String(r.id), JSON.parse(String(r.rules)).rollover);
  const breaks = new Set<string>();
  const ruleLocks = new Set<string>();
  for (const e of db.prepare("SELECT account_id, ts, data FROM events WHERE kind = 'locked'").all()) {
    const r = rollover.get(String(e.account_id));
    if (!r) continue;
    const reason = (JSON.parse(String(e.data ?? 'null')) as { reason?: string } | null)?.reason;
    const key = `${e.account_id}|${tradingDayOf(Number(e.ts), r)}`;
    if (reason === 'break') breaks.add(key);
    else if (reason === 'max_trades' || reason === 'personal_loss_limit') ruleLocks.add(key);
  }
  const update = db.prepare('UPDATE daily_stats SET flags = ? WHERE account_id = ? AND day = ?');
  for (const d of db.prepare(`SELECT account_id, day, flags FROM daily_stats WHERE flags LIKE '%"locked"%'`).all()) {
    const key = `${d.account_id}|${d.day}`;
    if (!breaks.has(key)) continue;
    const flags = JSON.parse(String(d.flags)) as string[];
    const next = ruleLocks.has(key) ? [...flags, 'break'] : flags.map((f) => (f === 'locked' ? 'break' : f));
    update.run(JSON.stringify(next), String(d.account_id), String(d.day));
  }
}
