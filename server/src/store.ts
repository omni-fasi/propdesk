// Repository over the SQLite schema: row <-> domain mapping, prepared statements, transactions.
// All writes are synchronous; the engine wraps each logical operation in store.tx().

import type { StatementSync } from 'node:sqlite';
import type {
  Account,
  AccountEvent,
  BookLevel,
  BookRow,
  BracketChange,
  DailyStat,
  DayNote,
  Drawing,
  EquityPoint,
  Fill,
  Order,
  Position,
  TickSample,
  Trade,
  TradeTags,
  WalletTx,
} from '../../shared/types.ts';
import { openDatabase, type Db } from './db.ts';

type Row = Record<string, unknown>;

const n = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
const nn = (v: unknown): number | null => (v == null ? null : n(v));
const s = (v: unknown): string => (v == null ? '' : String(v));
const ns = (v: unknown): string | null => (v == null ? null : String(v));

function json<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || v === '') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
const toJson = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

/** Accumulates `AND`-ed SQL conditions with their bound arguments. */
class Where {
  readonly parts: string[] = [];
  readonly args: Array<string | number> = [];
  add(cond: string, arg: string | number | null | undefined): this {
    if (arg != null && arg !== '') {
      this.parts.push(cond);
      this.args.push(arg);
    }
    return this;
  }
  toString(): string {
    return this.parts.length ? `WHERE ${this.parts.join(' AND ')}` : '';
  }
}

/** Engine-internal per-account state persisted next to the account row. */
export interface AccountState {
  /** Losing trades in a row on `streakDay`. */
  consecutiveLosses: number;
  streakDay: string;
  /** Warning levels already announced on `warnedDay` ('max50', 'max25', 'daily50', 'daily25'). */
  warnedDay: string;
  warned: string[];
  /** Trading day on which the daily loss / personal daily stop already fired (fires once per day). */
  dailyHitDay: string;
  personalHitDay: string;
}

export const EMPTY_TAGS: TradeTags = { mood: null, setup: null, confidence: null, plan: null };

export interface TradeQuery {
  accountId?: string | null;
  from?: number | null;
  to?: number | null;
  symbol?: string | null;
  status?: 'open' | 'closed' | 'all';
  limit: number;
  offset: number;
}

export class Store {
  readonly db: Db;
  private stmts = new Map<string, StatementSync>();

  constructor(path: string) {
    this.db = openDatabase(path);
  }

  close(): void {
    this.stmts.clear();
    if (this.db.isOpen) this.db.close();
  }

  private q(sql: string): StatementSync {
    let st = this.stmts.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.stmts.set(sql, st);
    }
    return st;
  }

  /** Run fn in a transaction (nested calls join the outer one). */
  tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ───────────────────────────── replay: ticks & brackets ─────────────────────────────

  insertTicks(rows: Array<[symbol: string, tick: TickSample]>): void {
    const st = this.q('INSERT OR IGNORE INTO ticks (symbol, ts, bid, ask) VALUES (?, ?, ?, ?)');
    for (const [symbol, [ts, bid, ask]] of rows) st.run(symbol, ts, bid, ask);
  }

  /** Samples of `symbol` with from ≤ ts ≤ to, oldest first. */
  queryTicks(symbol: string, from: number, to: number): TickSample[] {
    return this.q('SELECT ts, bid, ask FROM ticks WHERE symbol = ? AND ts BETWEEN ? AND ? ORDER BY ts')
      .all(symbol, from, to)
      .map((r): TickSample => [n(r.ts), n(r.bid), n(r.ask)]);
  }

  deleteTicksBefore(ts: number): number {
    return n(this.q('DELETE FROM ticks WHERE ts < ?').run(ts).changes);
  }

  insertBracket(tradeId: string, b: BracketChange): void {
    this.q('INSERT OR REPLACE INTO trade_brackets (trade_id, ts, sl, tp) VALUES (?, ?, ?, ?)').run(tradeId, b.ts, b.sl, b.tp);
  }

  queryBrackets(tradeId: string): BracketChange[] {
    return this.q('SELECT ts, sl, tp FROM trade_brackets WHERE trade_id = ? ORDER BY ts')
      .all(tradeId)
      .map((r) => ({ ts: n(r.ts), sl: nn(r.sl), tp: nn(r.tp) }));
  }

  // ───────────────────────────── meta & settings ─────────────────────────────

  getMeta(key: string): string | null {
    const r = this.q('SELECT value FROM meta WHERE key = ?').get(key);
    return r ? s(r.value) : null;
  }

  setMeta(key: string, value: string): void {
    this.q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  loadSettings(): unknown {
    const r = this.q('SELECT json FROM settings WHERE id = 1').get();
    return r ? json<unknown>(r.json, null) : null;
  }

  saveSettings(settings: unknown): void {
    this.q('INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json').run(JSON.stringify(settings));
  }

  // ───────────────────────────── accounts ─────────────────────────────

  listAccounts(): Array<{ account: Account; state: Partial<AccountState> }> {
    return this.q('SELECT * FROM accounts ORDER BY created_at, rowid')
      .all()
      .map((r) => ({ account: rowToAccount(r), state: json<Partial<AccountState>>(r.state, {}) }));
  }

  upsertAccount(a: Account, state: AccountState): void {
    this.q(
      `INSERT INTO accounts (id, name, kind, status, preset_id, phase, phase_count, rules, payout, fee, created_at, ended_at, end_reason,
         parent_id, balance, high_water_mark, max_loss_threshold, day_start_balance, trading_day, trading_days, lock, archived,
         total_payouts, last_payout_at, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, status = excluded.status, preset_id = excluded.preset_id,
         phase = excluded.phase, phase_count = excluded.phase_count, rules = excluded.rules, payout = excluded.payout, fee = excluded.fee,
         ended_at = excluded.ended_at, end_reason = excluded.end_reason, parent_id = excluded.parent_id, balance = excluded.balance,
         high_water_mark = excluded.high_water_mark, max_loss_threshold = excluded.max_loss_threshold,
         day_start_balance = excluded.day_start_balance, trading_day = excluded.trading_day, trading_days = excluded.trading_days,
         lock = excluded.lock, archived = excluded.archived, total_payouts = excluded.total_payouts,
         last_payout_at = excluded.last_payout_at, state = excluded.state`,
    ).run(
      a.id,
      a.name,
      a.kind,
      a.status,
      a.presetId,
      a.phase,
      a.phaseCount,
      JSON.stringify(a.rules),
      toJson(a.payout),
      a.fee,
      a.createdAt,
      a.endedAt,
      a.endReason,
      a.parentId,
      a.balance,
      a.highWaterMark,
      a.maxLossThreshold,
      a.dayStartBalance,
      a.tradingDay,
      a.tradingDays,
      toJson(a.lock),
      a.archived ? 1 : 0,
      a.totalPayouts,
      a.lastPayoutAt,
      JSON.stringify(state),
    );
  }

  // ───────────────────────────── orders & positions ─────────────────────────────

  listWorkingOrders(): Order[] {
    return this.q("SELECT * FROM orders WHERE status = 'working' ORDER BY created_at, rowid").all().map(rowToOrder);
  }

  getOrder(id: string): Order | null {
    const r = this.q('SELECT * FROM orders WHERE id = ?').get(id);
    return r ? rowToOrder(r) : null;
  }

  upsertOrder(o: Order): void {
    this.q(
      `INSERT INTO orders (id, account_id, symbol, side, type, qty, price, status, role, reduce_only, sl, tp, tags, created_at, updated_at,
         filled_at, fill_price, reject_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET qty = excluded.qty, price = excluded.price, status = excluded.status, role = excluded.role,
         reduce_only = excluded.reduce_only, sl = excluded.sl, tp = excluded.tp, tags = excluded.tags, updated_at = excluded.updated_at,
         filled_at = excluded.filled_at, fill_price = excluded.fill_price, reject_reason = excluded.reject_reason`,
    ).run(
      o.id,
      o.accountId,
      o.symbol,
      o.side,
      o.type,
      o.qty,
      o.price,
      o.status,
      o.role,
      o.reduceOnly ? 1 : 0,
      o.sl,
      o.tp,
      toJson(o.tags),
      o.createdAt,
      o.updatedAt,
      o.filledAt,
      o.fillPrice,
      o.rejectReason,
    );
  }

  listPositions(): Position[] {
    return this.q('SELECT * FROM positions ORDER BY opened_at, rowid').all().map(rowToPosition);
  }

  upsertPosition(p: Position): void {
    this.q(
      `INSERT INTO positions (account_id, symbol, qty, avg_price, opened_at, sl, tp, trade_id, mark_price, open_pnl)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(trade_id) DO UPDATE SET qty = excluded.qty, avg_price = excluded.avg_price, opened_at = excluded.opened_at,
         sl = excluded.sl, tp = excluded.tp, mark_price = excluded.mark_price, open_pnl = excluded.open_pnl`,
    ).run(p.accountId, p.symbol, p.qty, p.avgPrice, p.openedAt, p.sl, p.tp, p.tradeId, p.markPrice, p.openPnl);
  }

  deletePosition(tradeId: string): void {
    this.q('DELETE FROM positions WHERE trade_id = ?').run(tradeId);
  }

  // ───────────────────────────── order book heatmap ─────────────────────────────

  insertBookRow(symbol: string, r: BookRow): void {
    this.q('INSERT OR REPLACE INTO book_rows (symbol, t, step, bids, asks) VALUES (?, ?, ?, ?, ?)').run(symbol, r.t, r.step, JSON.stringify(r.bids), JSON.stringify(r.asks));
  }

  /** Rows with from ≤ t ≤ to (seconds), oldest first; the newest `limit` when there are more. */
  queryBookRows(symbol: string, from: number, to: number, limit: number): BookRow[] {
    return this.q('SELECT * FROM (SELECT * FROM book_rows WHERE symbol = ? AND t >= ? AND t <= ? ORDER BY t DESC LIMIT ?) ORDER BY t')
      .all(symbol, from, to, limit)
      .map((r) => ({ t: n(r.t), step: n(r.step), bids: JSON.parse(s(r.bids)) as BookLevel[], asks: JSON.parse(s(r.asks)) as BookLevel[] }));
  }

  /** Delete rows older than `before` (seconds). Returns how many. */
  pruneBookRows(before: number): number {
    return Number(this.q('DELETE FROM book_rows WHERE t < ?').run(before).changes);
  }

  // ───────────────────────────── fills ─────────────────────────────

  insertFill(f: Fill): void {
    this.q(
      `INSERT INTO fills (id, order_id, account_id, symbol, side, qty, price, fee, realized_pnl, liquidity, role, ts, trading_day, trade_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(f.id, f.orderId, f.accountId, f.symbol, f.side, f.qty, f.price, f.fee, f.realizedPnl, f.liquidity, f.role, f.ts, f.tradingDay, f.tradeId);
  }

  queryFills(opts: { accountId?: string | null; from?: number | null; to?: number | null; limit: number }): Fill[] {
    const w = new Where().add('account_id = ?', opts.accountId).add('ts >= ?', opts.from).add('ts <= ?', opts.to);
    return this.q(`SELECT * FROM fills ${w} ORDER BY ts DESC, rowid DESC LIMIT ?`)
      .all(...w.args, opts.limit)
      .map(rowToFill);
  }

  // ───────────────────────────── trades ─────────────────────────────

  upsertTrade(t: Trade): void {
    this.q(
      `INSERT INTO trades (id, account_id, symbol, direction, status, opened_at, closed_at, max_qty, entry_qty, exit_qty, avg_entry, avg_exit,
         gross_pnl, fees, net_pnl, initial_stop, risk_amount, r_multiple, mae, mfe, exit_reason, trading_day, tags, review)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, closed_at = excluded.closed_at, max_qty = excluded.max_qty,
         entry_qty = excluded.entry_qty, exit_qty = excluded.exit_qty, avg_entry = excluded.avg_entry, avg_exit = excluded.avg_exit,
         gross_pnl = excluded.gross_pnl, fees = excluded.fees, net_pnl = excluded.net_pnl, initial_stop = excluded.initial_stop,
         risk_amount = excluded.risk_amount, r_multiple = excluded.r_multiple, mae = excluded.mae, mfe = excluded.mfe,
         exit_reason = excluded.exit_reason, trading_day = excluded.trading_day, tags = excluded.tags, review = excluded.review`,
    ).run(
      t.id,
      t.accountId,
      t.symbol,
      t.direction,
      t.status,
      t.openedAt,
      t.closedAt,
      t.maxQty,
      t.entryQty,
      t.exitQty,
      t.avgEntry,
      t.avgExit,
      t.grossPnl,
      t.fees,
      t.netPnl,
      t.initialStop,
      t.riskAmount,
      t.rMultiple,
      t.mae,
      t.mfe,
      t.exitReason,
      t.tradingDay,
      JSON.stringify(t.tags),
      toJson(t.review),
    );
  }

  getTrade(id: string): Trade | null {
    const r = this.q('SELECT * FROM trades WHERE id = ?').get(id);
    return r ? rowToTrade(r) : null;
  }

  listOpenTrades(): Trade[] {
    return this.q("SELECT * FROM trades WHERE status = 'open' ORDER BY opened_at, rowid").all().map(rowToTrade);
  }

  queryTrades(o: TradeQuery): Trade[] {
    // Closed trades match on their close time, open ones on their open time.
    const w = new Where()
      .add('account_id = ?', o.accountId)
      .add('symbol = ?', o.symbol)
      .add('status = ?', o.status === 'all' ? null : o.status)
      .add('COALESCE(closed_at, opened_at) >= ?', o.from)
      .add('COALESCE(closed_at, opened_at) <= ?', o.to);
    return this.q(`SELECT * FROM trades ${w} ORDER BY COALESCE(closed_at, opened_at) DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...w.args, o.limit, o.offset)
      .map(rowToTrade);
  }

  // ───────────────────────────── daily stats & equity ─────────────────────────────

  upsertDaily(d: DailyStat): void {
    this.q(
      `INSERT INTO daily_stats (account_id, day, start_balance, end_balance, gross_pnl, fees, net_pnl, trades, wins, losses, fills,
         high_equity, low_equity, flags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, day) DO UPDATE SET start_balance = excluded.start_balance, end_balance = excluded.end_balance,
         gross_pnl = excluded.gross_pnl, fees = excluded.fees, net_pnl = excluded.net_pnl, trades = excluded.trades, wins = excluded.wins,
         losses = excluded.losses, fills = excluded.fills, high_equity = excluded.high_equity, low_equity = excluded.low_equity,
         flags = excluded.flags`,
    ).run(
      d.accountId,
      d.day,
      d.startBalance,
      d.endBalance,
      d.grossPnl,
      d.fees,
      d.netPnl,
      d.trades,
      d.wins,
      d.losses,
      d.fills,
      d.highEquity,
      d.lowEquity,
      JSON.stringify(d.flags),
    );
  }

  getDaily(accountId: string, day: string): DailyStat | null {
    const r = this.q('SELECT * FROM daily_stats WHERE account_id = ? AND day = ?').get(accountId, day);
    return r ? rowToDaily(r) : null;
  }

  queryDaily(opts: { accountId?: string | null; from?: string | null; to?: string | null }): DailyStat[] {
    const w = new Where().add('account_id = ?', opts.accountId).add('day >= ?', opts.from).add('day <= ?', opts.to);
    return this.q(`SELECT * FROM daily_stats ${w} ORDER BY day, rowid`)
      .all(...w.args)
      .map(rowToDaily);
  }

  /** Best (max) daily net P&L of an account over days strictly before `beforeDay` (or all days). */
  bestDailyNet(accountId: string, beforeDay?: string): number | null {
    const r = beforeDay
      ? this.q('SELECT MAX(net_pnl) AS m FROM daily_stats WHERE account_id = ? AND day < ?').get(accountId, beforeDay)
      : this.q('SELECT MAX(net_pnl) AS m FROM daily_stats WHERE account_id = ?').get(accountId);
    return r ? nn(r.m) : null;
  }

  insertEquity(accountId: string, p: EquityPoint): void {
    this.q('INSERT INTO equity (account_id, ts, balance, equity) VALUES (?, ?, ?, ?)').run(accountId, p.ts, p.balance, p.equity);
  }

  queryEquity(accountId: string, from?: number | null, to?: number | null): EquityPoint[] {
    return this.q('SELECT ts, balance, equity FROM equity WHERE account_id = ? AND ts >= ? AND ts <= ? ORDER BY ts, id')
      .all(accountId, from ?? 0, to ?? Number.MAX_SAFE_INTEGER)
      .map((r) => ({ ts: n(r.ts), balance: n(r.balance), equity: n(r.equity) }));
  }

  // ───────────────────────────── events ─────────────────────────────

  insertEvent(e: AccountEvent): void {
    this.q('INSERT INTO events (id, account_id, ts, kind, severity, title, message, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      e.id,
      e.accountId,
      e.ts,
      e.kind,
      e.severity,
      e.title,
      e.message,
      toJson(e.data),
    );
  }

  queryEvents(opts: { accountId?: string | null; limit: number; from?: number | null; before?: number | null }): AccountEvent[] {
    const w = new Where().add('account_id = ?', opts.accountId).add('ts >= ?', opts.from).add('ts < ?', opts.before);
    return this.q(`SELECT * FROM events ${w} ORDER BY ts DESC, rowid DESC LIMIT ?`)
      .all(...w.args, opts.limit)
      .map(rowToEvent);
  }

  // ───────────────────────────── wallet ─────────────────────────────

  insertWalletTx(t: WalletTx): void {
    this.q('INSERT INTO wallet_tx (id, ts, kind, amount, account_id, note, balance_after) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      t.id,
      t.ts,
      t.kind,
      t.amount,
      t.accountId,
      t.note,
      t.balanceAfter,
    );
  }

  /** Newest first. */
  listWalletTx(): WalletTx[] {
    return this.q('SELECT * FROM wallet_tx ORDER BY ts DESC, rowid DESC').all().map(rowToWalletTx);
  }

  walletBalance(): number {
    const r = this.q('SELECT balance_after FROM wallet_tx ORDER BY ts DESC, rowid DESC LIMIT 1').get();
    return r ? n(r.balance_after) : 0;
  }

  // ───────────────────────────── notes ─────────────────────────────

  upsertNote(note: DayNote): void {
    this.q(
      `INSERT INTO notes (day, account_id, text, mood, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day, account_id) DO UPDATE SET text = excluded.text, mood = excluded.mood, updated_at = excluded.updated_at`,
    ).run(note.day, note.accountId ?? '', note.text, note.mood, note.updatedAt);
  }

  // ───────────────────────────── drawings ─────────────────────────────

  /** Oldest first (later drawings paint on top). */
  listDrawings(symbol: string): Drawing[] {
    return this.q('SELECT * FROM drawings WHERE symbol = ? ORDER BY created_at, id').all(symbol).map(rowToDrawing);
  }

  getDrawing(id: string): Drawing | null {
    const r = this.q('SELECT * FROM drawings WHERE id = ?').get(id);
    return r ? rowToDrawing(r) : null;
  }

  countDrawings(symbol: string): number {
    return n(this.q('SELECT COUNT(*) AS c FROM drawings WHERE symbol = ?').get(symbol)?.c);
  }

  upsertDrawing(d: Drawing): void {
    this.q(
      `INSERT INTO drawings (id, symbol, kind, points, tp, sl, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, points = excluded.points, tp = excluded.tp, sl = excluded.sl, updated_at = excluded.updated_at`,
    ).run(d.id, d.symbol, d.kind, JSON.stringify(d.points), d.tp, d.sl, d.createdAt, d.updatedAt);
  }

  deleteDrawing(id: string): boolean {
    return n(this.q('DELETE FROM drawings WHERE id = ?').run(id).changes) > 0;
  }

  deleteDrawings(symbol: string): number {
    return n(this.q('DELETE FROM drawings WHERE symbol = ?').run(symbol).changes);
  }

  queryNotes(from?: string | null, to?: string | null): DayNote[] {
    return this.q('SELECT * FROM notes WHERE day >= ? AND day <= ? ORDER BY day, account_id')
      .all(from ?? '0000-00-00', to ?? '9999-99-99')
      .map((r) => ({
        day: s(r.day),
        accountId: s(r.account_id) === '' ? null : s(r.account_id),
        text: s(r.text),
        mood: ns(r.mood) as DayNote['mood'],
        updatedAt: n(r.updated_at),
      }));
  }
}

// ───────────────────────────── row mappers ─────────────────────────────

function rowToDrawing(r: Row): Drawing {
  return {
    id: s(r.id),
    symbol: s(r.symbol),
    kind: s(r.kind) as Drawing['kind'],
    points: json(r.points, []),
    tp: nn(r.tp),
    sl: nn(r.sl),
    createdAt: n(r.created_at),
    updatedAt: n(r.updated_at),
  };
}

function rowToAccount(r: Row): Account {
  return {
    id: s(r.id),
    name: s(r.name),
    kind: s(r.kind) as Account['kind'],
    status: s(r.status) as Account['status'],
    presetId: ns(r.preset_id),
    phase: n(r.phase),
    phaseCount: n(r.phase_count),
    rules: json(r.rules, {} as Account['rules']),
    payout: json(r.payout, null),
    fee: n(r.fee),
    createdAt: n(r.created_at),
    endedAt: nn(r.ended_at),
    endReason: ns(r.end_reason),
    parentId: ns(r.parent_id),
    balance: n(r.balance),
    highWaterMark: n(r.high_water_mark),
    maxLossThreshold: nn(r.max_loss_threshold),
    dayStartBalance: n(r.day_start_balance),
    tradingDay: s(r.trading_day),
    tradingDays: n(r.trading_days),
    lock: json(r.lock, null),
    archived: n(r.archived) === 1,
    totalPayouts: n(r.total_payouts),
    lastPayoutAt: nn(r.last_payout_at),
  };
}

function rowToOrder(r: Row): Order {
  return {
    id: s(r.id),
    accountId: s(r.account_id),
    symbol: s(r.symbol),
    side: s(r.side) as Order['side'],
    type: s(r.type) as Order['type'],
    qty: n(r.qty),
    price: nn(r.price),
    status: s(r.status) as Order['status'],
    role: s(r.role) as Order['role'],
    reduceOnly: n(r.reduce_only) === 1,
    sl: nn(r.sl),
    tp: nn(r.tp),
    tags: json(r.tags, null),
    createdAt: n(r.created_at),
    updatedAt: n(r.updated_at),
    filledAt: nn(r.filled_at),
    fillPrice: nn(r.fill_price),
    rejectReason: ns(r.reject_reason),
  };
}

function rowToPosition(r: Row): Position {
  return {
    accountId: s(r.account_id),
    symbol: s(r.symbol),
    qty: n(r.qty),
    avgPrice: n(r.avg_price),
    openedAt: n(r.opened_at),
    sl: nn(r.sl),
    tp: nn(r.tp),
    tradeId: s(r.trade_id),
    markPrice: n(r.mark_price),
    openPnl: n(r.open_pnl),
  };
}

function rowToFill(r: Row): Fill {
  return {
    id: s(r.id),
    orderId: ns(r.order_id),
    accountId: s(r.account_id),
    symbol: s(r.symbol),
    side: s(r.side) as Fill['side'],
    qty: n(r.qty),
    price: n(r.price),
    fee: n(r.fee),
    realizedPnl: n(r.realized_pnl),
    liquidity: s(r.liquidity) as Fill['liquidity'],
    role: s(r.role) as Fill['role'],
    ts: n(r.ts),
    tradingDay: s(r.trading_day),
    tradeId: s(r.trade_id),
  };
}

function rowToTrade(r: Row): Trade {
  return {
    id: s(r.id),
    accountId: s(r.account_id),
    symbol: s(r.symbol),
    direction: s(r.direction) as Trade['direction'],
    status: s(r.status) as Trade['status'],
    openedAt: n(r.opened_at),
    closedAt: nn(r.closed_at),
    maxQty: n(r.max_qty),
    entryQty: n(r.entry_qty),
    exitQty: n(r.exit_qty),
    avgEntry: n(r.avg_entry),
    avgExit: nn(r.avg_exit),
    grossPnl: n(r.gross_pnl),
    fees: n(r.fees),
    netPnl: n(r.net_pnl),
    initialStop: nn(r.initial_stop),
    riskAmount: nn(r.risk_amount),
    rMultiple: nn(r.r_multiple),
    mae: n(r.mae),
    mfe: n(r.mfe),
    exitReason: ns(r.exit_reason) as Trade['exitReason'],
    tradingDay: s(r.trading_day),
    tags: { ...EMPTY_TAGS, ...json<Partial<TradeTags>>(r.tags, {}) },
    review: json(r.review, null),
  };
}

function rowToDaily(r: Row): DailyStat {
  return {
    accountId: s(r.account_id),
    day: s(r.day),
    startBalance: n(r.start_balance),
    endBalance: n(r.end_balance),
    grossPnl: n(r.gross_pnl),
    fees: n(r.fees),
    netPnl: n(r.net_pnl),
    trades: n(r.trades),
    wins: n(r.wins),
    losses: n(r.losses),
    fills: n(r.fills),
    highEquity: n(r.high_equity),
    lowEquity: n(r.low_equity),
    flags: json(r.flags, []),
  };
}

function rowToEvent(r: Row): AccountEvent {
  return {
    id: s(r.id),
    accountId: ns(r.account_id),
    ts: n(r.ts),
    kind: s(r.kind) as AccountEvent['kind'],
    severity: s(r.severity) as AccountEvent['severity'],
    title: s(r.title),
    message: s(r.message),
    data: json(r.data, null),
  };
}

function rowToWalletTx(r: Row): WalletTx {
  return {
    id: s(r.id),
    ts: n(r.ts),
    kind: s(r.kind) as WalletTx['kind'],
    amount: n(r.amount),
    accountId: ns(r.account_id),
    note: ns(r.note),
    balanceAfter: n(r.balance_after),
  };
}
