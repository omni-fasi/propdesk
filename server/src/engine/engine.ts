// Trading engine: orders, fills, positions, trades, challenge rules, discipline locks, wallet,
// rollovers, auto-flatten and gap reconciliation (SPEC §4–§8).
//
// Design
// - All live state is held in memory (one Acct per account) and written through to SQLite synchronously.
// - Every entry point (command, quote, scheduler tick, gap replay) runs inside run(): one SQLite
//   transaction; notifications are queued and emitted only after COMMIT. Commands validate before
//   they mutate; if anything still fails half-way the transaction is rolled back and the in-memory
//   state is reloaded from the database.
// - Time always comes from the injected clock (`now`), so tests control it completely.

import { randomUUID } from 'node:crypto';
import type {
  Account,
  AccountEvent,
  AccountRules,
  AccountSnapshot,
  BracketChange,
  Candle,
  DailyStat,
  Drawing,
  DayNote,
  EventKind,
  ExitReason,
  FeesMode,
  Fill,
  InstrumentSpec,
  LockReason,
  Order,
  OrderRole,
  OrderType,
  PayoutPolicy,
  Position,
  TickSample,
  Quote,
  Settings,
  Side,
  Trade,
  TradeTags,
  WalletSummary,
  WalletTx,
  ZonedTime,
} from '../../../shared/types.ts';
import { LOCK_FLAGS } from '../../../shared/types.ts';
import type {
  BootstrapResponse,
  BreakRequest,
  ClosePositionRequest,
  CreateAccountRequest,
  DepositRequest,
  ModifyOrderRequest,
  OkResponse,
  PayoutEligibility,
  PayoutRequest,
  PayoutResponse,
  PlaceOrderRequest,
  PutDrawingRequest,
  PutNoteRequest,
  ReversePositionRequest,
  SetBracketRequest,
  UpdateAccountRequest,
  UpdateTradeRequest,
  WalletResponse,
} from '../../../shared/api.ts';
import { ASSET_CLASS_LABELS, INSTRUMENTS, getInstrument } from '../../../shared/instruments.ts';
import { PRESETS, PRESET_MAP, practiceRules, rulesForPhase } from '../../../shared/presets.ts';
import {
  accountCommission,
  commissionFor,
  contractsEquivalent,
  floorToStep,
  isOnStep,
  notional,
  pnl,
  riskAmount,
  round2,
  roundPrice,
  roundToStep,
  sideSign,
  validateBracket,
} from '../../../shared/risk.ts';
import { DAY_MS, addDays, nextWeekdayTimeAt, sessionState, tradingDayBounds, tradingDayOf } from '../../../shared/time.ts';
import { fmtDuration, fmtLeverage } from '../../../shared/format.ts';
import type { Logger, MarketGap, MarketHub } from '../market/types.ts';
import type { AccountState, Store, TradeQuery } from '../store.ts';
import { EMPTY_TAGS } from '../store.ts';
import { VERSION } from '../version.ts';
import { EngineError, fail, type ErrorCode } from './errors.ts';
import { Emitter, type EngineEvent, type EngineListener } from './events.ts';
import { allocateFill, splitFee, weightedAvg } from './netting.ts';
import { exitSide, limitMarketable, limitState, marketPrice, markFor, stopReference, stopTriggered, TOUCH_FILL_MS } from './triggers.ts';
import {
  DAY_LOCKS,
  LOCK_TITLES,
  UNLOCK_MESSAGES,
  canPass,
  classNotAllowedMessage,
  consistencyOk,
  dailyLossThreshold,
  flatByInDay,
  fmtZoned,
  inWeekendBlock,
  initialThreshold,
  isLockActive,
  lockEnd,
  marginFor,
  marketClosedMessage,
  maxContractsMessage,
  nextFridayAt,
  passBlockers,
  targetText,
  trailedThreshold,
  weekendFlatTime,
} from './rules.ts';
import { capitalize, customName, fundedName, money, moneyWhole, plural, practiceName, presetAccountName, px, qtyText, signed } from './naming.ts';
import { asObj, bool, dayKeyArg, mergeTags, mood, num, oneOf, optText, orderTags, str, validateReview, validateRules } from './validation.ts';
import { applySettingsPatch, mergeSettings } from './settings.ts';
import { MAX_DRAWINGS_PER_SYMBOL, parseDrawing } from './drawings.ts';
import { walletSummary } from './wallet.ts';

const OWNER = 'engine';
const EPS = 1e-9;
/** Gaps shorter than this are ignored (SPEC §8). */
export const MIN_GAP_MS = 5_000;
/** A scheduler tick this late means the process was suspended. */
const SUSPEND_MS = 6_000;
const INITIAL_STOP_WINDOW_MS = 10_000;
const EQUITY_POINT_MS = 60_000;
const TRADE_FLUSH_MS = 5_000;
const META_FLUSH_MS = 5_000;
const FLAT_WARNING_MS = 5 * 60_000;
/** Auto-flatten only executes on a quote at most this old (else it waits for data / the gap replay). */
const FRESH_QUOTE_MS = 60_000;
const DEFAULT_PRACTICE_BALANCE = 50_000;
const FEES_MODES: readonly FeesMode[] = ['real', 'off'];
/** Payout policy for funded accounts created from custom challenges. */
const CUSTOM_PAYOUT: PayoutPolicy = { profitSplit: 0.9, minWinningDays: 5, minDayProfit: 100, maxPctOfProfit: 0.5, minAmount: 100 };

export interface EngineOptions {
  store: Store;
  market: MarketHub;
  log?: Logger;
  now?: () => number;
  /** What 'local' means for rollover / flat-by zones and the wallet month (default: machine zone). */
  localTz?: string;
  /** Detect process suspend from a late scheduler tick and replay the gap (production). Default false. */
  detectSuspend?: boolean;
  /** After a detected suspend, wait this long for the market's onGap before replaying anyway. */
  gapWaitMs?: number;
}

export interface StartOptions {
  /** Run the 1 s scheduler. Tests leave it off and call tick() themselves. Default true. */
  scheduler?: boolean;
}

/** In-memory runtime of one account. */
interface Acct {
  a: Account;
  st: AccountState;
  /** Open positions by id (= trade id), oldest first: a symbol's positions close in this order. */
  positions: Map<string, Position>;
  /** Working orders by id (insertion order = creation order). */
  orders: Map<string, Order>;
  /** Open trades by id. */
  trades: Map<string, Trade>;
  /** DailyStat of a.tradingDay (null until the first activity of the day). */
  day: DailyStat | null;
  /** Best daily net P&L before the current trading day. */
  bestPastDay: number | null;
  /** End of the current trading day = next rollover. */
  dayEnd: number;
  nextFlatAt: number | null;
  nextWeekendAt: number | null;
  flatWarnedAt: number | null;
  weekendWarnedAt: number | null;
  lastEquityAt: number;
  /** Account row changed without being persisted (high-water mark, internal state). */
  dirty: boolean;
  /** Day high / low equity changed without being persisted. */
  dayDirty: boolean;
  /** Open trades whose MAE / MFE changed. */
  dirtyTrades: Set<string>;
  /** 'last' model limits: since when the trade price has sat exactly at the limit. */
  touches: Map<string, number>;
  /** Being reconciled after a gap: commands answer `busy`, live quotes wait. */
  busy: boolean;
}

interface FillRequest {
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  liquidity: 'maker' | 'taker';
  role: OrderRole;
  orderId: string | null;
  ts: number;
  /** Exit reason if this fill completes the trade (a flip always records 'reversal'). */
  exitReason: ExitReason;
  /** Close only this position (bracket fills, closing one position); otherwise the symbol's positions FIFO. */
  positionId?: string | null;
  /** Bracket / tags of an entry order, applied to the resulting position / new trade. */
  sl?: number | null;
  tp?: number | null;
  tags?: TradeTags | null;
}

interface FillOutcome {
  fills: Fill[];
  /** Trades of the positions this execution closed, oldest first. */
  closed: Trade[];
  opened: Trade | null;
  /** Realized P&L minus fee of this execution. */
  net: number;
}

interface LiquidateOptions {
  /** Only positions / orders whose instrument matches. */
  filter?: ((spec: InstrumentSpec) => boolean) | null;
  /** Explicit exit prices (gap replay). */
  prices?: Map<string, number> | null;
  /** Require a fresh quote (auto-flatten); positions without one are skipped. */
  fresh?: boolean;
  cancelReason?: string;
}

interface LiquidationResult {
  closed: Array<{ symbol: string; price: number; pnl: number }>;
  cancelled: number;
  skipped: string[];
}

/** Context of a running gap replay. */
interface ReplayCtx {
  /** Open price per symbol of the bar being replayed (auto-flatten fills there). */
  opens: Map<string, number>;
  /** Human summary items for the catch_up event. */
  notes: string[];
}

interface Blocker {
  code: ErrorCode;
  message: string;
}

const isFutures = (spec: InstrumentSpec) => spec.assetClass === 'futures';

function validQuote(q: Quote | null | undefined): q is Quote {
  return !!q && [q.bid, q.ask, q.last].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
}

function errText(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/** The order only reduces the symbol's positions (signed total `net`): opposite side, not larger than them. */
function isReducing(net: number, side: Side, qty: number): boolean {
  return net !== 0 && Math.sign(net) !== sideSign(side) && qty <= Math.abs(net) + EPS;
}

function blankDay(accountId: string, day: string, startBalance: number, endBalance: number, equity: number): DailyStat {
  return {
    accountId,
    day,
    startBalance,
    endBalance,
    grossPnl: 0,
    fees: 0,
    netPnl: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    fills: 0,
    highEquity: equity,
    lowEquity: equity,
    flags: [],
  };
}

const dayLabelFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
function fmtDayKey(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return dayLabelFmt.format(Date.UTC(y, m - 1, d));
}

function fmtMinutes(m: number): string {
  return m >= 60 && m % 60 === 0 ? `${m / 60} hour` : `${m} minute`;
}

function orderLabel(spec: InstrumentSpec, o: Order): string {
  return `${capitalize(o.side)} ${o.type} ${qtyText(spec, o.qty)}${o.price != null ? ` @ ${px(spec, o.price)}` : ''}`;
}

/** Sorted, de-duplicated 1m bars that overlap [fromMs, toMs). */
function cleanBars(bars: Candle[], fromMs: number, toMs: number): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of bars ?? []) {
    if (!c || ![c.time, c.open, c.high, c.low, c.close].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    if (c.open <= 0 || c.low <= 0 || c.high < c.low) continue;
    const ms = c.time * 1000;
    if (ms >= toMs || ms + 60_000 <= fromMs) continue;
    byTime.set(c.time, c);
  }
  return [...byTime.values()].sort((x, y) => x.time - y.time);
}

const clone = <T>(v: T): T => structuredClone(v);

export class Engine {
  readonly now: () => number;
  readonly localTz: string;
  private readonly store: Store;
  private readonly market: MarketHub;
  private readonly log: Logger;
  private readonly detectSuspend: boolean;
  private readonly gapWaitMs: number;
  private readonly emitter: Emitter;

  private accounts = new Map<string, Acct>();
  private settings: Settings = mergeSettings(null);
  /** symbol → active accounts with a position or working order in it. */
  private symbolIndex = new Map<string, Acct[]>();
  /** Symbols retained at the market hub by the engine. */
  private retained = new Set<string>();
  /** Last stop / target written to trade_brackets per open trade ("sl|tp"), to record changes only. */
  private lastBracket = new Map<string, string>();

  private depth = 0;
  private writes = 0;
  private queue: EngineEvent[] = [];
  private snapQueue = new Map<string, boolean>();
  private walletDirty = false;
  private retentionDirty = false;

  private unsubs: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private stopped = false;
  private lastTickAt: number | null = null;
  /** Up to when market time has been processed (persisted as meta.last_processed_ts). */
  private lastProcessedTs = 0;
  private lastMetaAt = 0;
  private lastTradeFlushAt = 0;

  private catchUp: { fromMs: number; timer: ReturnType<typeof setTimeout> | null; running: boolean } | null = null;
  private pendingQuotes = new Map<string, Quote>();
  private pendingGap: MarketGap | null = null;
  private reconciledUntil = 0;
  private replay: ReplayCtx | null = null;
  private idle: Promise<void> = Promise.resolve();

  constructor(opts: EngineOptions) {
    this.store = opts.store;
    this.market = opts.market;
    this.log = opts.log ?? { debug() {}, info() {}, warn() {}, error() {} };
    this.now = opts.now ?? Date.now;
    this.localTz = opts.localTz ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    this.detectSuspend = opts.detectSuspend ?? false;
    this.gapWaitMs = opts.gapWaitMs ?? 15_000;
    this.emitter = new Emitter((err) => this.log.error('engine: listener failed: %s', errText(err)));
  }

  // ═════════════════════════════ lifecycle ═════════════════════════════

  on(fn: EngineListener): () => void {
    return this.emitter.on(fn);
  }

  /** Load state → replay the gap since the last run → process missed rollovers → go live. */
  async start(opts: StartOptions = {}): Promise<void> {
    if (this.started) return;
    this.started = true;
    const last = Number(this.store.getMeta('last_processed_ts'));
    this.lastProcessedTs = Number.isFinite(last) && last > 0 ? last : this.now();
    this.loadState();
    this.unsubs.push(this.market.onQuote((q) => this.handleQuote(q)));
    this.unsubs.push(this.market.onGap((g) => this.handleGap(g)));
    const t = this.now();
    if (t - this.lastProcessedTs >= MIN_GAP_MS) {
      this.log.info('engine: replaying %s of downtime', fmtDuration(t - this.lastProcessedTs));
      this.catchUp = { fromMs: this.lastProcessedTs, timer: null, running: false };
      await this.runCatchUp(t);
    } else {
      this.tick();
    }
    if (opts.scheduler !== false && !this.stopped) {
      this.timer = setInterval(() => this.tick(), 1000);
      this.timer.unref?.();
    }
  }

  /** Persist everything and detach from the market. Safe to call twice. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.catchUp?.timer) clearTimeout(this.catchUp.timer);
    for (const off of this.unsubs.splice(0)) off();
    try {
      this.run(() => this.flushDirty(true));
      // While a gap is pending keep its start, so the next start replays it.
      this.store.setMeta('last_processed_ts', String(this.catchUp ? this.catchUp.fromMs : this.lastProcessedTs));
    } catch (err) {
      this.log.error('engine: final flush failed: %s', errText(err));
    }
    for (const s of this.retained) this.market.release(s, OWNER);
    this.retained.clear();
  }

  /** Resolves when the current gap replay (if any) has finished. */
  whenIdle(): Promise<void> {
    return this.idle;
  }

  isCatchingUp(): boolean {
    return this.catchUp != null;
  }

  /** Symbols with open positions / working orders in active accounts. */
  activeSymbols(): ReadonlySet<string> {
    return this.retained;
  }

  private loadState(): void {
    this.settings = mergeSettings(this.store.loadSettings());
    const accounts = new Map<string, Acct>();
    for (const { account, state } of this.store.listAccounts()) accounts.set(account.id, this.newAcct(account, state));
    for (const p of this.store.listPositions()) accounts.get(p.accountId)?.positions.set(p.tradeId, p);
    for (const o of this.store.listWorkingOrders()) accounts.get(o.accountId)?.orders.set(o.id, o);
    for (const tr of this.store.listOpenTrades()) accounts.get(tr.accountId)?.trades.set(tr.id, tr);
    for (const acc of accounts.values()) {
      acc.day = this.store.getDaily(acc.a.id, acc.a.tradingDay);
      acc.bestPastDay = this.store.bestDailyNet(acc.a.id, acc.a.tradingDay);
      for (const pos of acc.positions.values()) {
        const q = this.market.getQuote(pos.symbol);
        if (validQuote(q)) this.applyMark(acc, pos, q);
      }
    }
    this.accounts = accounts;
    this.syncRetention();
  }

  private newAcct(a: Account, s: Partial<AccountState>): Acct {
    return {
      a,
      st: {
        consecutiveLosses: s.consecutiveLosses ?? 0,
        streakDay: s.streakDay ?? a.tradingDay,
        warnedDay: s.warnedDay ?? a.tradingDay,
        warned: Array.isArray(s.warned) ? s.warned : [],
        dailyHitDay: s.dailyHitDay ?? '',
        personalHitDay: s.personalHitDay ?? '',
      },
      positions: new Map(),
      orders: new Map(),
      trades: new Map(),
      day: null,
      bestPastDay: null,
      dayEnd: tradingDayBounds(a.tradingDay, a.rules.rollover).end,
      nextFlatAt: null,
      nextWeekendAt: null,
      flatWarnedAt: null,
      weekendWarnedAt: null,
      lastEquityAt: 0,
      dirty: false,
      dayDirty: false,
      dirtyTrades: new Set(),
      touches: new Map(),
      busy: false,
    };
  }

  // ═════════════════════════════ transactions & notifications ═════════════════════════════

  private run<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth = 1;
    const writesBefore = this.writes;
    let result: T;
    try {
      result = this.store.tx(fn);
    } catch (err) {
      this.depth = 0;
      this.queue = [];
      this.snapQueue.clear();
      this.walletDirty = false;
      this.retentionDirty = false;
      // Validation errors are thrown before anything is mutated; anything else may have left
      // half-applied in-memory state behind: the transaction was rolled back, so reload.
      if (!(err instanceof EngineError) || this.writes !== writesBefore) {
        if (!(err instanceof EngineError)) this.log.error('engine: operation failed, state reloaded: %s', errText(err));
        try {
          this.loadState();
        } catch (e) {
          this.log.error('engine: reload failed: %s', errText(e));
        }
      }
      throw err;
    }
    this.depth = 0;
    this.flushNotifications();
    return result;
  }

  private flushNotifications(): void {
    if (this.retentionDirty) {
      this.retentionDirty = false;
      this.syncRetention();
    }
    const queue = this.queue;
    const snaps = this.snapQueue;
    const wallet = this.walletDirty;
    this.queue = [];
    this.snapQueue = new Map();
    this.walletDirty = false;
    for (const ev of queue) this.emitter.emit(ev);
    if (wallet) this.emitter.emit({ type: 'wallet', wallet: this.walletSummary() });
    for (const [accountId, immediate] of snaps) this.emitter.emit({ type: 'snapshot', accountId, immediate });
  }

  private notify(ev: EngineEvent): void {
    if (this.depth > 0) this.queue.push(ev);
    else this.emitter.emit(ev);
  }

  private touchSnapshot(acc: Acct, immediate: boolean): void {
    this.snapQueue.set(acc.a.id, (this.snapQueue.get(acc.a.id) ?? false) || immediate);
  }

  // Persistence helpers — every write goes through these (they count writes for the rollback logic).

  private saveAccount(acc: Acct, notify = true): void {
    this.writes++;
    this.store.upsertAccount(acc.a, acc.st);
    acc.dirty = false;
    if (notify) this.notify({ type: 'account', account: clone(acc.a) });
  }

  private saveOrder(o: Order): void {
    this.writes++;
    this.store.upsertOrder(o);
    this.notify({ type: 'order', order: clone(o) });
  }

  private savePosition(p: Position): void {
    this.writes++;
    this.store.upsertPosition(p);
    this.notify({ type: 'position', position: { ...p } });
  }

  /** Replay history: the position's stop / target from `ts` on, written only when it changed. */
  private recordBracket(p: Position, ts: number): void {
    if (!p.tradeId) return;
    const key = `${p.sl}|${p.tp}`;
    if (this.lastBracket.get(p.tradeId) === key) return;
    this.lastBracket.set(p.tradeId, key);
    this.store.insertBracket(p.tradeId, { ts, sl: p.sl, tp: p.tp });
  }

  private removePosition(acc: Acct, p: Position): void {
    this.writes++;
    this.store.deletePosition(p.tradeId);
    this.notify({ type: 'position_closed', accountId: acc.a.id, symbol: p.symbol, tradeId: p.tradeId });
  }

  private saveTrade(acc: Acct | null, tr: Trade): void {
    this.writes++;
    this.store.upsertTrade(tr);
    acc?.dirtyTrades.delete(tr.id);
    this.notify({ type: 'trade', trade: clone(tr) });
  }

  private saveDay(acc: Acct, d: DailyStat): void {
    this.writes++;
    this.store.upsertDaily(d);
    if (d === acc.day) acc.dayDirty = false;
    else acc.bestPastDay = this.store.bestDailyNet(acc.a.id, acc.a.tradingDay);
  }

  private addFill(f: Fill): void {
    this.writes++;
    this.store.insertFill(f);
    this.notify({ type: 'fill', fill: { ...f } });
  }

  private addEquityPoint(acc: Acct, ts: number): void {
    this.writes++;
    this.store.insertEquity(acc.a.id, { ts, balance: acc.a.balance, equity: this.equity(acc) });
    acc.lastEquityAt = ts;
  }

  private addWalletTx(tx: WalletTx): void {
    this.writes++;
    this.store.insertWalletTx(tx);
    this.walletDirty = true;
  }

  private event(
    accountId: string | null,
    ts: number,
    kind: EventKind,
    severity: AccountEvent['severity'],
    title: string,
    message: string,
    data: Record<string, unknown> | null = null,
  ): AccountEvent {
    const ev: AccountEvent = { id: randomUUID(), accountId, ts, kind, severity, title, message, data };
    this.writes++;
    this.store.insertEvent(ev);
    this.notify({ type: 'event', event: clone(ev) });
    return ev;
  }

  /** Persist state that changes on every quote (high-water mark, MAE/MFE, day extremes). */
  private flushDirty(force: boolean): void {
    const t = this.now();
    const trades = force || t - this.lastTradeFlushAt >= TRADE_FLUSH_MS;
    if (trades) this.lastTradeFlushAt = t;
    for (const acc of this.accounts.values()) {
      if (acc.dirty) this.saveAccount(acc);
      if (acc.dayDirty && acc.day) this.saveDay(acc, acc.day);
      if (trades && acc.dirtyTrades.size) {
        for (const id of [...acc.dirtyTrades]) {
          const tr = acc.trades.get(id);
          if (tr) this.saveTrade(acc, tr);
        }
        acc.dirtyTrades.clear();
      }
    }
  }

  // ═════════════════════════════ market symbols ═════════════════════════════

  private syncRetention(): void {
    const want = new Set<string>();
    const index = new Map<string, Acct[]>();
    const add = (sym: string, acc: Acct) => {
      want.add(sym);
      const list = index.get(sym);
      if (!list) index.set(sym, [acc]);
      else if (!list.includes(acc)) list.push(acc);
    };
    for (const acc of this.accounts.values()) {
      if (acc.a.status !== 'active') continue;
      for (const p of acc.positions.values()) add(p.symbol, acc);
      for (const o of acc.orders.values()) add(o.symbol, acc);
    }
    for (const s of want) if (!this.retained.has(s)) this.market.retain(s, OWNER);
    for (const s of this.retained) if (!want.has(s)) this.market.release(s, OWNER);
    this.retained = want;
    this.symbolIndex = index;
  }

  private spec(symbol: string): InstrumentSpec {
    return getInstrument(symbol) ?? fail('invalid', `Unknown symbol ${symbol}`);
  }

  // ═════════════════════════════ positions ═════════════════════════════

  /** The account's open positions in `symbol`, oldest first (all on the same side). */
  private legs(acc: Acct, symbol: string): Position[] {
    const out: Position[] = [];
    for (const p of acc.positions.values()) if (p.symbol === symbol) out.push(p);
    return out;
  }

  /** Signed total size of the account's positions in `symbol` (0 = flat). */
  private netQty(acc: Acct, symbol: string): number {
    let q = 0;
    for (const p of acc.positions.values()) if (p.symbol === symbol) q += p.qty;
    return q === 0 ? 0 : roundToStep(q, this.spec(symbol).qtyStep);
  }

  /** Symbols the account holds positions in, in the order they were first opened. */
  private positionSymbolsOf(acc: Acct): string[] {
    return [...new Set([...acc.positions.values()].map((p) => p.symbol))];
  }

  // ═════════════════════════════ marks & equity ═════════════════════════════

  private equity(acc: Acct): number {
    let e = acc.a.balance;
    for (const p of acc.positions.values()) e += p.openPnl;
    return round2(e);
  }

  private openPnl(acc: Acct): number {
    let s = 0;
    for (const p of acc.positions.values()) s += p.openPnl;
    return round2(s);
  }

  private setMark(acc: Acct, pos: Position, mark: number): void {
    const spec = this.spec(pos.symbol);
    pos.markPrice = mark;
    pos.openPnl = round2(pnl(spec, pos.qty > 0 ? 1 : -1, Math.abs(pos.qty), pos.avgPrice, mark));
    const tr = acc.trades.get(pos.tradeId);
    if (tr) {
      const running = round2(tr.grossPnl + pos.openPnl);
      if (running < tr.mae) (tr.mae = running), acc.dirtyTrades.add(tr.id);
      if (running > tr.mfe) (tr.mfe = running), acc.dirtyTrades.add(tr.id);
    }
  }

  private applyMark(acc: Acct, pos: Position, q: Quote): void {
    this.setMark(acc, pos, markFor(pos.qty, q));
  }

  private trackDayEquity(acc: Acct): void {
    const d = acc.day;
    if (!d) return;
    const eq = this.equity(acc);
    if (eq > d.highEquity) (d.highEquity = eq), (acc.dayDirty = true);
    if (eq < d.lowEquity) (d.lowEquity = eq), (acc.dayDirty = true);
  }

  private bestDay(acc: Acct): number {
    return Math.max(0, acc.bestPastDay ?? 0, acc.day?.netPnl ?? 0);
  }

  // ═════════════════════════════ live quotes ═════════════════════════════

  private handleQuote(q: Quote): void {
    if (this.stopped || !this.started) return;
    if (this.catchUp) {
      this.pendingQuotes.set(q.symbol, q);
      return;
    }
    const accs = this.symbolIndex.get(q.symbol);
    if (!accs?.length || !validQuote(q)) return;
    const spec = getInstrument(q.symbol);
    if (!spec) return;
    try {
      this.run(() => {
        const t = this.now();
        for (const acc of accs) {
          if (acc.a.status === 'active' && !acc.busy) this.processQuote(acc, spec, q, t);
        }
      });
    } catch (err) {
      this.log.error('engine: quote %s failed: %s', q.symbol, errText(err));
    }
  }

  private processQuote(acc: Acct, spec: InstrumentSpec, q: Quote, t: number): void {
    this.processRollovers(acc, t);
    if (acc.a.status !== 'active') return;
    for (const pos of this.legs(acc, spec.symbol)) this.applyMark(acc, pos, q);
    this.checkTriggers(acc, spec, q, t);
    this.evaluate(acc, t);
    this.touchSnapshot(acc, false);
  }

  /** Brackets and working orders, pessimistic order: stops first, then limits. Each position has its own bracket. */
  private checkTriggers(acc: Acct, spec: InstrumentSpec, q: Quote, t: number): void {
    const sym = spec.symbol;
    for (const pos of this.legs(acc, sym)) {
      if (acc.a.status !== 'active') return;
      if (pos.sl != null && acc.positions.has(pos.tradeId) && stopTriggered(spec, exitSide(pos.qty), pos.sl, q)) {
        this.bracketFill(acc, pos, 'sl', marketPrice(exitSide(pos.qty), q), t);
      }
    }
    for (const o of this.working(acc, sym, 'stop')) {
      if (acc.a.status !== 'active') return;
      if (o.status === 'working' && stopTriggered(spec, o.side, o.price!, q)) this.fillWorking(acc, o, marketPrice(o.side, q), 'taker', t);
    }
    for (const pos of this.legs(acc, sym)) {
      if (acc.a.status !== 'active') return;
      if (pos.tp != null && this.limitReady(acc, `tp:${pos.tradeId}`, spec, exitSide(pos.qty), pos.tp, q)) this.bracketFill(acc, pos, 'tp', pos.tp, t);
    }
    for (const o of this.working(acc, sym, 'limit')) {
      if (acc.a.status !== 'active') return;
      if (o.status === 'working' && this.limitReady(acc, o.id, spec, o.side, o.price!, q)) this.fillWorking(acc, o, o.price!, 'maker', t);
    }
  }

  private working(acc: Acct, symbol: string, type: OrderType): Order[] {
    return [...acc.orders.values()].filter((o) => o.symbol === symbol && o.type === type);
  }

  /** Limit fill check incl. the 'last'-model rule: at the price for ≥ 3 s also fills. */
  private limitReady(acc: Acct, key: string, spec: InstrumentSpec, side: Side, limit: number, q: Quote): boolean {
    const state = limitState(spec, side, limit, q);
    if (state === 'fill') {
      acc.touches.delete(key);
      return true;
    }
    if (state === 'touch') {
      const since = acc.touches.get(key);
      if (since == null) acc.touches.set(key, q.ts);
      else if (q.ts - since >= TOUCH_FILL_MS) {
        acc.touches.delete(key);
        return true;
      }
      return false;
    }
    acc.touches.delete(key);
    return false;
  }

  // ═════════════════════════════ fills ═════════════════════════════

  /** Stop-loss (stop-market) or take-profit (limit) execution of one position. */
  private bracketFill(acc: Acct, pos: Position, which: 'sl' | 'tp', price: number, t: number): void {
    const spec = this.spec(pos.symbol);
    const symbol = pos.symbol;
    const side = exitSide(pos.qty);
    const qty = Math.abs(pos.qty);
    const isSl = which === 'sl';
    const fillPrice = roundPrice(spec, price);
    const out = this.executeFill(acc, {
      symbol,
      side,
      qty,
      price: fillPrice,
      liquidity: isSl ? 'taker' : 'maker',
      role: isSl ? 'stop_loss' : 'take_profit',
      orderId: null,
      ts: t,
      exitReason: isSl ? 'stop_loss' : 'take_profit',
      positionId: pos.tradeId,
    });
    const result = out.closed.length ? out.closed[0].netPnl : out.net;
    const what = isSl ? 'stop-loss' : 'take-profit';
    if (this.replay) {
      this.replay.notes.push(`${what} hit on ${symbol} at ${px(spec, fillPrice)} (${signed(result)})`);
    } else {
      this.event(
        acc.a.id,
        t,
        isSl ? 'stop_hit' : 'target_hit',
        isSl ? 'warning' : 'success',
        `${capitalize(what)} hit · ${symbol}`,
        `${side === 'sell' ? 'Sold' : 'Bought'} ${qtyText(spec, qty)} @ ${px(spec, fillPrice)} · ${signed(result)}`,
        { symbol, price: fillPrice, qty, pnl: result, tradeId: out.closed[0]?.id ?? null },
      );
    }
  }

  /** A working limit / stop order executes (or is rejected if it can no longer be filled). */
  private fillWorking(acc: Acct, o: Order, price: number, liquidity: 'maker' | 'taker', t: number): void {
    const spec = this.spec(o.symbol);
    const net = this.netQty(acc, o.symbol);
    let qty = o.qty;
    if (o.reduceOnly) {
      if (net === 0 || Math.sign(net) === sideSign(o.side)) {
        this.cancelWorking(acc, o, t, 'the position it was closing is gone', true);
        return;
      }
      qty = Math.min(qty, Math.abs(net));
    }
    const fillPrice = roundPrice(spec, price);
    const reducing = isReducing(net, o.side, qty);
    if (!reducing) {
      const newQty = roundToStep(net + sideSign(o.side) * qty, spec.qtyStep);
      const why = this.entryBlocker(acc, spec, t) ?? this.exposureBlocker(acc, spec, newQty, fillPrice);
      if (why) {
        this.rejectWorking(acc, o, t, why.message);
        return;
      }
    }
    acc.orders.delete(o.id);
    acc.touches.delete(o.id);
    Object.assign(o, { status: 'filled', qty, role: reducing ? 'exit' : 'entry', filledAt: t, fillPrice, updatedAt: t });
    this.saveOrder(o);
    const out = this.executeFill(acc, {
      symbol: o.symbol,
      side: o.side,
      qty,
      price: fillPrice,
      liquidity,
      role: o.role,
      orderId: o.id,
      ts: t,
      exitReason: o.type === 'limit' ? 'limit' : o.type === 'stop' ? 'stop_loss' : 'manual',
      sl: reducing ? undefined : o.sl,
      tp: reducing ? undefined : o.tp,
      tags: reducing ? null : o.tags,
    });
    if (this.replay) {
      const closedPnl = round2(out.closed.reduce((sum, tr) => sum + tr.netPnl, 0));
      this.replay.notes.push(`${o.side} ${o.type} filled on ${o.symbol} at ${px(spec, fillPrice)}${out.closed.length ? ` (${signed(closedPnl)})` : ''}`);
    }
  }

  private rejectWorking(acc: Acct, o: Order, t: number, message: string): void {
    const spec = this.spec(o.symbol);
    acc.orders.delete(o.id);
    acc.touches.delete(o.id);
    Object.assign(o, { status: 'rejected', rejectReason: message, updatedAt: t });
    this.saveOrder(o);
    this.retentionDirty = true;
    this.event(acc.a.id, t, 'order_rejected', 'warning', `Order rejected · ${o.symbol}`, `${orderLabel(spec, o)}: ${message}`, {
      orderId: o.id,
      symbol: o.symbol,
    });
    if (this.replay) this.replay.notes.push(`${orderLabel(spec, o).toLowerCase()} on ${o.symbol} rejected (${message})`);
  }

  private cancelWorking(acc: Acct, o: Order, t: number, reason: string | null, notify: boolean): void {
    acc.orders.delete(o.id);
    acc.touches.delete(o.id);
    Object.assign(o, { status: 'cancelled', rejectReason: reason, updatedAt: t });
    this.saveOrder(o);
    this.retentionDirty = true;
    if (notify) {
      const spec = this.spec(o.symbol);
      this.event(acc.a.id, t, 'order_rejected', 'info', `Order cancelled · ${o.symbol}`, `${orderLabel(spec, o)} cancelled — ${reason ?? 'cancelled'}.`, {
        orderId: o.id,
        symbol: o.symbol,
      });
    }
  }

  /**
   * Execute one fill against the account: position bookkeeping, trades, balance, daily stats, persistence
   * and notifications. It closes `r.positionId`, or the symbol's positions on the other side oldest first;
   * what is left opens a new position with the order's bracket. Every position closed or opened gets its
   * own fill (the commission is split by qty), so every fill belongs to exactly one trade.
   */
  private executeFill(acc: Acct, r: FillRequest): FillOutcome {
    const a = acc.a;
    const spec = this.spec(r.symbol);
    const dir = sideSign(r.side);
    const target = r.positionId != null ? acc.positions.get(r.positionId) : undefined;
    const candidates = r.positionId != null ? (target ? [target] : []) : this.legs(acc, r.symbol);
    const alloc = allocateFill(candidates, r.side, r.qty, spec.qtyStep);
    // Closing one position never opens anything (callers cap the size to the position).
    const openQty = r.positionId != null ? 0 : alloc.open;
    const fee = commissionFor(accountCommission(a.rules, spec), spec, r.qty, r.price, r.liquidity);
    const fees = splitFee(fee, [...alloc.closes.map((c) => c.qty), ...(openQty > 0 ? [openQty] : [])]);
    const flipped = openQty > 0 && alloc.closes.length > 0;
    const day = tradingDayOf(r.ts, a.rules.rollover);
    // A replayed fill can belong to a trading day that was already closed live (network gap).
    const retro = day < a.tradingDay;
    const stat = this.statFor(acc, day);
    const firstFillOfDay = stat.fills === 0;
    const fills: Fill[] = [];
    const touched: Trade[] = [];
    const closed: Trade[] = [];
    let opened: Trade | null = null;
    let realized = 0;
    const q = this.replay ? null : this.market.getQuote(r.symbol);
    const markOf = (qty: number) => (validQuote(q) ? markFor(qty, q) : r.price);

    alloc.closes.forEach((c, i) => {
      const pos = candidates[c.index];
      const tr = this.tradeOf(acc, pos);
      const gross = round2(pnl(spec, Math.sign(pos.qty) as 1 | -1, c.qty, pos.avgPrice, r.price));
      realized += gross;
      tr.avgExit = weightedAvg(tr.avgExit ?? 0, tr.exitQty, r.price, c.qty);
      tr.exitQty = roundToStep(tr.exitQty + c.qty, spec.qtyStep);
      tr.grossPnl = round2(tr.grossPnl + gross);
      tr.fees = round2(tr.fees + fees[i]);
      tr.netPnl = round2(tr.grossPnl - tr.fees);
      fills.push(this.makeFill(a, r, c.qty, gross, fees[i], tr.id, day));
      touched.push(tr);
      const rest = roundToStep(Math.abs(pos.qty) - c.qty, spec.qtyStep);
      if (rest > 0) {
        // Partial close: same entry price, same bracket.
        pos.qty = Math.sign(pos.qty) * rest;
        this.setMark(acc, pos, markOf(pos.qty));
        this.savePosition(pos);
        return;
      }
      tr.status = 'closed';
      tr.closedAt = r.ts;
      tr.exitReason = flipped ? 'reversal' : r.exitReason;
      tr.tradingDay = day;
      tr.mae = Math.min(tr.mae, tr.grossPnl);
      tr.mfe = Math.max(tr.mfe, tr.grossPnl);
      tr.rMultiple = tr.riskAmount ? round2(tr.netPnl / tr.riskAmount) : null;
      acc.trades.delete(tr.id);
      closed.push(tr);
      stat.trades += 1;
      if (tr.netPnl > 0) stat.wins += 1;
      else if (tr.netPnl < 0) stat.losses += 1;
      this.lastBracket.delete(pos.tradeId);
      acc.positions.delete(pos.tradeId);
      acc.touches.delete(`tp:${pos.tradeId}`);
      this.removePosition(acc, pos);
    });

    if (openQty > 0) {
      const feeOpen = fees[fees.length - 1];
      const tr: Trade = {
        id: randomUUID(),
        accountId: a.id,
        symbol: r.symbol,
        direction: r.side === 'buy' ? 'long' : 'short',
        status: 'open',
        openedAt: r.ts,
        closedAt: null,
        maxQty: openQty,
        entryQty: openQty,
        exitQty: 0,
        avgEntry: r.price,
        avgExit: null,
        grossPnl: 0,
        fees: feeOpen,
        netPnl: round2(-feeOpen),
        initialStop: null,
        riskAmount: null,
        rMultiple: null,
        mae: 0,
        mfe: 0,
        exitReason: null,
        tradingDay: day,
        tags: r.tags ? { ...r.tags } : { ...EMPTY_TAGS },
        review: null,
      };
      acc.trades.set(tr.id, tr);
      opened = tr;
      fills.push(this.makeFill(a, r, openQty, 0, feeOpen, tr.id, day));
      touched.push(tr);
      // A new position of its own — never merged into another one — with the entry order's bracket.
      const p: Position = {
        accountId: a.id,
        symbol: r.symbol,
        qty: dir * openQty,
        avgPrice: r.price,
        openedAt: r.ts,
        sl: r.sl ?? null,
        tp: r.tp ?? null,
        tradeId: tr.id,
        markPrice: r.price,
        openPnl: 0,
      };
      acc.positions.set(p.tradeId, p);
      this.setMark(acc, p, markOf(p.qty));
      this.captureInitialStop(tr, p, spec, r.ts);
      this.savePosition(p);
      this.recordBracket(p, r.ts);
    }

    realized = round2(realized);
    const delta = round2(realized - fee);
    a.balance = round2(a.balance + delta);
    if (retro) a.dayStartBalance = round2(a.dayStartBalance + delta); // keep today's daily P&L untouched
    if (firstFillOfDay) a.tradingDays += 1;
    stat.fills += fills.length;
    stat.grossPnl = round2(stat.grossPnl + realized);
    stat.fees = round2(stat.fees + fee);
    stat.netPnl = round2(stat.grossPnl - stat.fees);
    stat.endBalance = retro ? round2(stat.endBalance + delta) : a.balance;
    if (!retro) this.trackDayEquity(acc);
    this.saveDay(acc, stat);

    for (const tr of touched) this.saveTrade(acc, tr);
    for (const f of fills) this.addFill(f);
    this.saveAccount(acc);
    this.addEquityPoint(acc, r.ts);
    this.touchSnapshot(acc, true);
    this.retentionDirty = true;

    this.syncReduceOnly(acc, r.symbol, r.ts);
    if (closed.length && !retro) this.afterTradesClosed(acc, closed, r.ts);
    return { fills, closed, opened, net: delta };
  }

  private makeFill(a: Account, r: FillRequest, qty: number, realized: number, fee: number, tradeId: string, day: string): Fill {
    return {
      id: randomUUID(),
      orderId: r.orderId,
      accountId: a.id,
      symbol: r.symbol,
      side: r.side,
      qty,
      price: r.price,
      fee,
      realizedPnl: realized,
      liquidity: r.liquidity,
      role: r.role,
      ts: r.ts,
      tradingDay: day,
      tradeId,
    };
  }

  /** The open trade of a position (rebuilt from the position if it went missing). */
  private tradeOf(acc: Acct, pos: Position): Trade {
    const tr = acc.trades.get(pos.tradeId);
    if (tr) return tr;
    this.log.warn('engine: open trade %s missing for %s %s, rebuilding it', pos.tradeId, acc.a.name, pos.symbol);
    const rebuilt: Trade = {
      id: pos.tradeId || randomUUID(),
      accountId: acc.a.id,
      symbol: pos.symbol,
      direction: pos.qty > 0 ? 'long' : 'short',
      status: 'open',
      openedAt: pos.openedAt,
      closedAt: null,
      maxQty: Math.abs(pos.qty),
      entryQty: Math.abs(pos.qty),
      exitQty: 0,
      avgEntry: pos.avgPrice,
      avgExit: null,
      grossPnl: 0,
      fees: 0,
      netPnl: 0,
      initialStop: pos.sl,
      riskAmount: null,
      rMultiple: null,
      mae: 0,
      mfe: 0,
      exitReason: null,
      tradingDay: acc.a.tradingDay,
      tags: { ...EMPTY_TAGS },
      review: null,
    };
    pos.tradeId = rebuilt.id;
    acc.trades.set(rebuilt.id, rebuilt);
    return rebuilt;
  }

  /** initialStop = the stop in place right after opening, or the first one set within 10 s. */
  private captureInitialStop(tr: Trade, p: Position, spec: InstrumentSpec, ts: number): boolean {
    if (tr.initialStop != null || p.sl == null || ts - tr.openedAt > INITIAL_STOP_WINDOW_MS) return false;
    tr.initialStop = p.sl;
    tr.riskAmount = round2(riskAmount(spec, Math.abs(p.qty), p.avgPrice, p.sl));
    return true;
  }

  private statFor(acc: Acct, day: string): DailyStat {
    const a = acc.a;
    if (day === a.tradingDay) {
      acc.day ??= blankDay(a.id, day, a.dayStartBalance, a.balance, this.equity(acc));
      return acc.day;
    }
    return this.store.getDaily(a.id, day) ?? blankDay(a.id, day, a.balance, a.balance, a.balance);
  }

  private flag(acc: Acct, f: DailyStat['flags'][number]): void {
    const stat = this.statFor(acc, acc.a.tradingDay);
    if (!stat.flags.includes(f)) {
      stat.flags.push(f);
      this.saveDay(acc, stat);
    }
  }

  /** Reduce-only orders follow the symbol's positions: capped to their total size, cancelled when flat or flipped. */
  private syncReduceOnly(acc: Acct, symbol: string, t: number): void {
    const net = this.netQty(acc, symbol);
    for (const o of [...acc.orders.values()]) {
      if (o.symbol !== symbol || !o.reduceOnly) continue;
      if (net === 0 || Math.sign(net) === sideSign(o.side)) this.cancelWorking(acc, o, t, 'the position it was closing is gone', true);
      else if (o.qty > Math.abs(net) + EPS) {
        o.qty = Math.abs(net);
        o.updatedAt = t;
        this.saveOrder(o);
      }
    }
  }

  // ═════════════════════════════ rules ═════════════════════════════

  /** Equity-driven rules: trailing HWM, max loss, daily loss, personal stop, warnings, pass. */
  private evaluate(acc: Acct, t: number): void {
    const a = acc.a;
    if (a.status !== 'active') return;
    this.trackDayEquity(acc);
    const eq = this.equity(acc);
    if (a.rules.maxLoss?.mode === 'trailing_intraday' && eq > a.highWaterMark) {
      a.highWaterMark = eq;
      a.maxLossThreshold = trailedThreshold(a.rules, eq, a.maxLossThreshold);
      acc.dirty = true;
    }
    if (a.maxLossThreshold != null && eq <= a.maxLossThreshold + EPS) {
      this.breachMaxLoss(acc, t, eq, null);
      return;
    }
    const dth = dailyLossThreshold(a);
    if (dth != null && eq <= dth + EPS && acc.st.dailyHitDay !== a.tradingDay) {
      this.dailyLossHit(acc, t, eq, null);
      if (a.status !== 'active') return;
    }
    const personal = this.personalLimit(acc);
    if (personal != null && eq <= personal + EPS && acc.st.personalHitDay !== a.tradingDay) this.personalLossHit(acc, t, null);
    if (!this.replay) this.checkWarnings(acc, this.equity(acc), t);
    this.checkPass(acc, t);
  }

  /** Equity level of the personal daily stop (Settings.tilt.personalDailyLoss). */
  private personalLimit(acc: Acct): number | null {
    const tilt = this.settings.tilt;
    return tilt.enabled && tilt.personalDailyLoss != null ? round2(acc.a.dayStartBalance - tilt.personalDailyLoss) : null;
  }

  private breachMaxLoss(acc: Acct, t: number, eq: number, prices: Map<string, number> | null): void {
    const th = acc.a.maxLossThreshold ?? 0;
    this.failAccount(acc, t, {
      endReason: 'Max loss limit breached',
      exitReason: 'breach',
      flag: 'breach',
      title: 'Account failed — max loss limit breached',
      message: `Equity fell to ${money(eq)}, through the max loss limit of ${money(th)}. All positions were liquidated.`,
      prices,
    });
  }

  private dailyLossHit(acc: Acct, t: number, eq: number, prices: Map<string, number> | null): void {
    const a = acc.a;
    const rule = a.rules.dailyLoss!;
    const th = dailyLossThreshold(a)!;
    acc.st.dailyHitDay = a.tradingDay;
    acc.dirty = true;
    if (rule.action === 'fail') {
      this.failAccount(acc, t, {
        endReason: 'Daily loss limit breached',
        exitReason: 'daily_loss',
        flag: 'daily_loss',
        title: 'Account failed — daily loss limit breached',
        message: `Equity fell to ${money(eq)}, through today's loss limit of ${money(th)} (${money(rule.amount)} below the day's start). All positions were liquidated.`,
        prices,
      });
      return;
    }
    const res = this.liquidate(acc, t, 'daily_loss', { prices, cancelReason: 'daily loss limit' });
    if (this.replay) this.replay.notes.push(`daily loss limit hit${res.closed.length ? ` — closed ${res.closed.map((c) => c.symbol).join(', ')}` : ''}`);
    this.applyLock(
      acc,
      t,
      'daily_loss',
      null,
      `Daily loss limit of ${money(rule.amount)} reached${res.closed.length ? ' — positions closed' : ''}. Trading resumes next trading day.`,
      'danger',
    );
  }

  private personalLossHit(acc: Acct, t: number, prices: Map<string, number> | null): void {
    const a = acc.a;
    const limit = this.settings.tilt.personalDailyLoss ?? 0;
    acc.st.personalHitDay = a.tradingDay;
    acc.dirty = true;
    const res = this.liquidate(acc, t, 'daily_loss', { prices, cancelReason: 'personal daily stop' });
    if (this.replay) this.replay.notes.push(`personal daily stop hit${res.closed.length ? ` — closed ${res.closed.map((c) => c.symbol).join(', ')}` : ''}`);
    this.applyLock(
      acc,
      t,
      'personal_loss_limit',
      null,
      `Your personal daily stop of ${money(limit)} was hit${res.closed.length ? ' — positions closed' : ''}. Done for today.`,
      'danger',
    );
  }

  private failAccount(
    acc: Acct,
    t: number,
    o: {
      endReason: string;
      exitReason: ExitReason;
      flag: DailyStat['flags'][number];
      title: string;
      message: string;
      prices?: Map<string, number> | null;
    },
  ): void {
    const a = acc.a;
    // Status first: discipline locks must not fire on the liquidation trades.
    a.status = 'failed';
    a.endedAt = t;
    a.endReason = o.endReason;
    a.lock = null;
    this.liquidate(acc, t, o.exitReason, { prices: o.prices, cancelReason: o.endReason.toLowerCase() });
    this.flag(acc, o.flag);
    const feeNote = a.fee > 0 ? ` The ${money(a.fee)} fee is gone.` : '';
    this.event(a.id, t, 'breach', 'danger', o.title, o.message + feeNote, {
      reason: o.endReason,
      balance: a.balance,
      threshold: a.maxLossThreshold,
      fee: a.fee,
    });
    if (this.replay) this.replay.notes.push(`${o.endReason.toLowerCase()} — account failed`);
    this.saveAccount(acc);
    this.touchSnapshot(acc, true);
    this.retentionDirty = true;
  }

  /** Cancel working orders and close positions at market (role 'liquidation'). */
  private liquidate(acc: Acct, t: number, exitReason: ExitReason, o: LiquidateOptions = {}): LiquidationResult {
    const res: LiquidationResult = { closed: [], cancelled: 0, skipped: [] };
    for (const ord of [...acc.orders.values()]) {
      if (o.filter && !o.filter(this.spec(ord.symbol))) continue;
      this.cancelWorking(acc, ord, t, o.cancelReason ?? null, false);
      res.cancelled++;
    }
    // One execution per symbol closes all of its positions.
    for (const symbol of this.positionSymbolsOf(acc)) {
      const spec = this.spec(symbol);
      if (o.filter && !o.filter(spec)) continue;
      const net = this.netQty(acc, symbol);
      const price = o.prices?.get(symbol) ?? this.exitPrice(this.legs(acc, symbol)[0], t, o.fresh ?? false);
      if (price == null) {
        res.skipped.push(symbol);
        continue;
      }
      const fillPrice = roundPrice(spec, price);
      const out = this.executeFill(acc, {
        symbol,
        side: exitSide(net),
        qty: Math.abs(net),
        price: fillPrice,
        liquidity: 'taker',
        role: 'liquidation',
        orderId: null,
        ts: t,
        exitReason,
      });
      res.closed.push({ symbol, price: fillPrice, pnl: out.closed.length ? round2(out.closed.reduce((sum, tr) => sum + tr.netPnl, 0)) : out.net });
    }
    return res;
  }

  /** Where a forced exit executes now: replay bar open, live bid/ask, or the last mark. */
  private exitPrice(pos: Position, t: number, fresh: boolean): number | null {
    if (this.replay) return this.replay.opens.get(pos.symbol) ?? pos.markPrice;
    const q = this.market.getQuote(pos.symbol);
    if (validQuote(q) && (!fresh || q.ts >= t - FRESH_QUOTE_MS)) return markFor(pos.qty, q);
    return fresh ? null : pos.markPrice;
  }

  /**
   * Lock the account (discipline / daily loss / break). A lock only replaces an active one that
   * ends earlier. Working orders that would add risk are cancelled; exits and brackets stay.
   */
  private applyLock(acc: Acct, t: number, reason: LockReason, until: number | null, message: string, severity: AccountEvent['severity']): void {
    const a = acc.a;
    if (a.status !== 'active') return;
    const cur = isLockActive(a.lock, t) ? a.lock : null;
    if (!cur || lockEnd(cur, acc.dayEnd) < (until ?? acc.dayEnd)) a.lock = { reason, since: t, until, message };
    let cancelled = 0;
    for (const o of [...acc.orders.values()]) {
      if (o.reduceOnly || isReducing(this.netQty(acc, o.symbol), o.side, o.qty)) continue;
      this.cancelWorking(acc, o, t, 'account locked', false);
      cancelled++;
    }
    this.flag(acc, LOCK_FLAGS[reason]);
    const extra = cancelled ? ` ${plural(cancelled, 'working entry order')} cancelled.` : '';
    this.event(a.id, t, 'locked', severity, LOCK_TITLES[reason], message + extra, { reason, until });
    this.saveAccount(acc);
    this.touchSnapshot(acc, true);
  }

  private expireLock(acc: Acct, t: number): void {
    const lock = acc.a.lock;
    if (!lock || lock.until == null || lock.until > t) return;
    acc.a.lock = null;
    this.event(acc.a.id, t, 'unlocked', 'info', 'Trading unlocked', UNLOCK_MESSAGES[lock.reason], { reason: lock.reason });
    this.saveAccount(acc);
    this.touchSnapshot(acc, true);
  }

  /**
   * Discipline guard after an execution closed trades (tilt cooldown, max trades per day). Positions closed
   * by one execution (closing several at once) count as one result for the losing streak.
   */
  private afterTradesClosed(acc: Acct, closed: Trade[], t: number): void {
    const a = acc.a;
    const st = acc.st;
    if (st.streakDay !== a.tradingDay) {
      st.streakDay = a.tradingDay;
      st.consecutiveLosses = 0;
    }
    const net = closed.reduce((sum, tr) => sum + tr.netPnl, 0);
    st.consecutiveLosses = net < 0 ? st.consecutiveLosses + 1 : 0;
    acc.dirty = true;
    const tilt = this.settings.tilt;
    if (a.status !== 'active' || !tilt.enabled) return;
    const n = tilt.maxConsecutiveLosses;
    if (n > 0 && net < 0 && st.consecutiveLosses % n === 0) {
      this.applyLock(
        acc,
        t,
        'tilt_cooldown',
        t + tilt.cooldownMinutes * 60_000,
        `${st.consecutiveLosses} losses in a row — ${fmtMinutes(tilt.cooldownMinutes)} cooldown`,
        'warning',
      );
    }
    const trades = acc.day?.trades ?? 0;
    if (tilt.maxTradesPerDay != null && trades >= tilt.maxTradesPerDay) {
      this.applyLock(
        acc,
        t,
        'max_trades',
        null,
        `${plural(trades, 'trade')} today — that's your limit. Trading is locked until the next trading day.`,
        'warning',
      );
    }
  }

  private checkWarnings(acc: Acct, eq: number, t: number): void {
    const a = acc.a;
    const st = acc.st;
    if (st.warnedDay !== a.tradingDay) {
      st.warnedDay = a.tradingDay;
      st.warned = [];
      acc.dirty = true;
    }
    const ml = a.rules.maxLoss;
    if (ml && a.maxLossThreshold != null) this.bufferWarning(acc, t, 'max', eq - a.maxLossThreshold, ml.amount);
    const dl = a.rules.dailyLoss;
    const dth = dailyLossThreshold(a);
    if (dl && dth != null && st.dailyHitDay !== a.tradingDay) this.bufferWarning(acc, t, 'daily', eq - dth, dl.amount);
  }

  /** Warn once per level per day when 50 % / 25 % of a loss buffer remains. */
  private bufferWarning(acc: Acct, t: number, kind: 'max' | 'daily', left: number, amount: number): void {
    const frac = left / amount;
    const levels = frac <= 0.25 ? ['50', '25'] : frac <= 0.5 ? ['50'] : [];
    const fresh = levels.filter((l) => !acc.st.warned.includes(kind + l));
    if (!fresh.length || left <= 0) return;
    acc.st.warned.push(...fresh.map((l) => kind + l));
    acc.dirty = true;
    const low = fresh.includes('25');
    const failText = kind === 'max' || acc.a.rules.dailyLoss?.action === 'fail' ? 'the account fails' : 'trading locks for today';
    const title =
      kind === 'max'
        ? low
          ? 'Max loss buffer below 25%'
          : 'Half of your max loss buffer is gone'
        : low
          ? "Today's loss buffer below 25%"
          : "Half of today's loss limit is used";
    this.event(acc.a.id, t, 'warning', low ? 'danger' : 'warning', title, `${money(left)} left before ${failText}.`, {
      kind,
      level: low ? 25 : 50,
      left: round2(left),
    });
  }

  private checkPass(acc: Acct, t: number): void {
    if (canPass(acc.a, acc.positions.size, this.bestDay(acc))) this.passAccount(acc, t);
  }

  private passAccount(acc: Acct, t: number): void {
    const a = acc.a;
    for (const o of [...acc.orders.values()]) this.cancelWorking(acc, o, t, 'challenge passed', false);
    a.status = 'passed';
    a.endedAt = t;
    a.endReason = 'Profit target reached';
    a.lock = null;
    this.flag(acc, 'passed');
    this.saveAccount(acc);
    this.touchSnapshot(acc, true);
    this.retentionDirty = true;
    const profit = round2(a.balance - a.rules.startingBalance);
    const preset = a.presetId ? (PRESET_MAP[a.presetId] ?? null) : null;
    if (this.replay) this.replay.notes.push('profit target reached — challenge passed');
    if (preset && a.phase < a.phaseCount) {
      const next = this.createAccountRecord({
        id: randomUUID(),
        name: presetAccountName(preset, a.phase, this.attemptOf(acc)),
        kind: 'evaluation',
        presetId: preset.id,
        phase: a.phase + 1,
        phaseCount: a.phaseCount,
        rules: rulesForPhase(preset, a.phase),
        payout: null,
        fee: 0,
        parentId: a.id,
        t,
      });
      this.event(a.id, t, 'phase_passed', 'success', `Phase ${a.phase} passed!`, `${signed(profit)} — target reached. ${next.a.name} is ready: target ${targetText(next.a.rules)}.`, {
        nextAccountId: next.a.id,
        profit,
      });
      this.event(next.a.id, t, 'account_created', 'info', 'Next phase unlocked', `${next.a.name} — no fee, same rules, target ${targetText(next.a.rules)}.`);
      return;
    }
    const canActivate = !preset || preset.funded != null;
    this.event(
      a.id,
      t,
      'passed',
      'success',
      'You passed!',
      `Profit target reached with ${signed(profit)}.${canActivate ? ' Activate your funded account.' : ''}`,
      { profit },
    );
  }

  /** Attempt number of an evaluation chain = phase-1 accounts among it and its ancestors. */
  private attemptOf(acc: Acct): number {
    let n = 0;
    const seen = new Set<string>();
    for (let cur: Acct | undefined = acc; cur && !seen.has(cur.a.id); cur = cur.a.parentId ? this.accounts.get(cur.a.parentId) : undefined) {
      seen.add(cur.a.id);
      if (cur.a.kind === 'evaluation' && cur.a.phase === 1) n++;
    }
    return Math.max(1, n);
  }

  private checkTimeLimit(acc: Acct, t: number): void {
    const a = acc.a;
    const days = a.rules.maxCalendarDays;
    if (a.kind !== 'evaluation' || a.status !== 'active' || days == null) return;
    if (t < a.createdAt + days * DAY_MS) return;
    this.failAccount(acc, t, {
      endReason: 'Time limit expired',
      exitReason: 'breach',
      flag: 'breach',
      title: 'Account failed — time limit expired',
      message: `The ${plural(days, 'day')} time limit ran out before the profit target was reached.`,
    });
  }

  // ═════════════════════════════ rollover & schedule ═════════════════════════════

  /** Apply every rollover due at or before t (also all those missed during downtime). */
  private processRollovers(acc: Acct, t: number): void {
    for (let guard = 0; acc.a.status === 'active' && t >= acc.dayEnd && guard < 5000; guard++) this.rollover(acc, acc.dayEnd);
  }

  private rollover(acc: Acct, at: number): void {
    const a = acc.a;
    const prevDay = a.tradingDay;
    const stat = acc.day;
    if (stat) {
      stat.endBalance = a.balance;
      this.saveDay(acc, stat);
      acc.bestPastDay = Math.max(acc.bestPastDay ?? -Infinity, stat.netPnl);
    }
    if (a.rules.maxLoss?.mode === 'trailing_eod') {
      a.highWaterMark = Math.max(a.highWaterMark, a.balance);
      a.maxLossThreshold = trailedThreshold(a.rules, a.highWaterMark, a.maxLossThreshold);
    }
    a.dayStartBalance = a.balance;
    let next = tradingDayOf(at, a.rules.rollover);
    if (next <= prevDay) next = addDays(prevDay, 1);
    a.tradingDay = next;
    acc.dayEnd = tradingDayBounds(next, a.rules.rollover).end;
    if (acc.dayEnd <= at) acc.dayEnd = at + DAY_MS;
    acc.day = null;
    Object.assign(acc.st, { consecutiveLosses: 0, streakDay: next, warned: [], warnedDay: next });
    if (a.lock && DAY_LOCKS.has(a.lock.reason)) {
      const reason = a.lock.reason;
      a.lock = null;
      this.event(a.id, at, 'unlocked', 'info', 'Trading unlocked', UNLOCK_MESSAGES[reason], { reason });
    }
    if (stat && stat.fills > 0) {
      this.event(
        a.id,
        at,
        'day_rollover',
        'info',
        `Trading day closed · ${fmtDayKey(prevDay)}`,
        `${signed(stat.netPnl)} net · ${plural(stat.trades, 'trade')} (${stat.wins} W / ${stat.losses} L)`,
        { day: prevDay, netPnl: stat.netPnl, trades: stat.trades },
      );
    }
    this.saveAccount(acc);
    this.touchSnapshot(acc, true);
    this.checkTimeLimit(acc, at);
    if (a.status === 'active') this.evaluate(acc, at); // EOD trailing may have moved the threshold up
  }

  /** Time-driven rules shared by the live scheduler and the gap replay. */
  private runSchedule(acc: Acct, t: number): void {
    this.processRollovers(acc, t);
    if (acc.a.status !== 'active') return;
    this.expireLock(acc, t);
    this.checkTimeLimit(acc, t);
    if (acc.a.status !== 'active') return;
    this.checkAutoFlatten(acc, t);
  }

  private scheduleBase(acc: Acct): number {
    return Math.max(acc.a.createdAt, this.lastProcessedTs) - 1;
  }

  private hasExposure(acc: Acct, filter: ((s: InstrumentSpec) => boolean) | null): boolean {
    for (const p of acc.positions.values()) if (!filter || filter(this.spec(p.symbol))) return true;
    for (const o of acc.orders.values()) if (!filter || filter(this.spec(o.symbol))) return true;
    return false;
  }

  /** flatBy (Mon–Fri, futures) and noWeekendHolding (Friday, everything) — warning 5 min before. */
  private checkAutoFlatten(acc: Acct, t: number): void {
    const a = acc.a;
    const r = a.rules;
    if (r.flatBy) {
      acc.nextFlatAt ??= nextWeekdayTimeAt(this.scheduleBase(acc), r.flatBy);
      const at = acc.nextFlatAt;
      if (!this.replay && acc.flatWarnedAt !== at && t >= at - FLAT_WARNING_MS && t < at) {
        acc.flatWarnedAt = at;
        if (this.hasExposure(acc, isFutures)) {
          this.event(a.id, t, 'warning', 'warning', 'Auto-flatten in 5 minutes', `Futures positions are closed and working futures orders cancelled at ${fmtZoned(r.flatBy)}.`, { at });
        }
      }
      if (t >= at && this.autoFlatten(acc, t, isFutures, `Flat by ${fmtZoned(r.flatBy)}`)) acc.nextFlatAt = nextWeekdayTimeAt(t, r.flatBy);
      if (a.status !== 'active') return;
    }
    if (r.noWeekendHolding) {
      const z = weekendFlatTime(r);
      acc.nextWeekendAt ??= nextFridayAt(this.scheduleBase(acc), z);
      const at = acc.nextWeekendAt;
      if (!this.replay && acc.weekendWarnedAt !== at && t >= at - FLAT_WARNING_MS && t < at) {
        acc.weekendWarnedAt = at;
        if (this.hasExposure(acc, null)) {
          this.event(a.id, t, 'warning', 'warning', 'Weekend flatten in 5 minutes', `No weekend holding: all positions are closed and orders cancelled at ${fmtZoned(z)}.`, { at });
        }
      }
      if (t >= at && this.autoFlatten(acc, t, null, 'No weekend holding')) acc.nextWeekendAt = nextFridayAt(t, z);
    }
  }

  /**
   * Returns false (and does nothing) while an affected position has no fresh price — retried next tick.
   * Nothing can fill without fresh quotes anyway, and the gap replay applies it at the right bar.
   */
  private autoFlatten(acc: Acct, t: number, filter: ((s: InstrumentSpec) => boolean) | null, label: string): boolean {
    for (const pos of acc.positions.values()) {
      if ((!filter || filter(this.spec(pos.symbol))) && this.exitPrice(pos, t, true) == null) return false;
    }
    const res = this.liquidate(acc, t, 'auto_flatten', { filter, fresh: true, cancelReason: label.toLowerCase() });
    if (res.closed.length || res.cancelled) {
      const parts = res.closed.map((c) => `${c.symbol} (${signed(c.pnl)})`);
      const what = [parts.length ? `closed ${parts.join(', ')}` : '', res.cancelled ? `cancelled ${plural(res.cancelled, 'working order')}` : '']
        .filter(Boolean)
        .join(' · ');
      this.event(acc.a.id, t, 'auto_flatten', 'warning', 'Positions auto-flattened', `${label}: ${what}.`, { label });
      if (this.replay && parts.length) this.replay.notes.push(`auto-flatten closed ${parts.join(', ')}`);
    }
    return true;
  }

  // ═════════════════════════════ scheduler ═════════════════════════════

  /** 1 s scheduler: rollovers, lock expiry, time limits, auto-flatten, rules, equity points, persistence. */
  tick(): void {
    if (this.stopped || !this.started) return;
    const t = this.now();
    const late = this.lastTickAt != null && t - this.lastTickAt > SUSPEND_MS;
    this.lastTickAt = t;
    if (this.catchUp) return;
    if (late && this.detectSuspend) {
      this.beginCatchUp(this.lastProcessedTs);
      return;
    }
    try {
      this.run(() => {
        for (const acc of this.accounts.values()) {
          if (acc.a.status !== 'active' || acc.busy) continue;
          this.runSchedule(acc, t);
          if (acc.a.status !== 'active') continue;
          this.evaluate(acc, t);
          if (acc.positions.size && t - acc.lastEquityAt >= EQUITY_POINT_MS) this.addEquityPoint(acc, t);
        }
        this.flushDirty(false);
      });
    } catch (err) {
      this.log.error('engine: tick failed: %s', errText(err));
    }
    this.lastProcessedTs = Math.max(this.lastProcessedTs, t);
    if (t - this.lastMetaAt >= META_FLUSH_MS) {
      this.lastMetaAt = t;
      try {
        this.store.setMeta('last_processed_ts', String(this.lastProcessedTs));
      } catch (err) {
        this.log.error('engine: saving last_processed_ts failed: %s', errText(err));
      }
    }
  }

  // ═════════════════════════════ gaps (SPEC §8) ═════════════════════════════

  /** Suspend detected: hold quotes and rules until the market reports the gap (or a timeout). */
  private beginCatchUp(fromMs: number): void {
    this.log.warn('engine: process was suspended since %s — waiting for market data to replay the gap', new Date(fromMs).toISOString());
    const timer = setTimeout(() => void this.runCatchUp(this.now()), this.gapWaitMs);
    timer.unref?.();
    this.catchUp = { fromMs, timer, running: false };
  }

  private handleGap(g: MarketGap): void {
    if (this.stopped || !(g.toMs - g.fromMs >= MIN_GAP_MS)) return;
    if (this.catchUp?.running) {
      this.pendingGap = this.pendingGap
        ? { fromMs: Math.min(this.pendingGap.fromMs, g.fromMs), toMs: Math.max(this.pendingGap.toMs, g.toMs), symbols: [...new Set([...this.pendingGap.symbols, ...g.symbols])] }
        : g;
      return;
    }
    if (this.catchUp) {
      if (this.catchUp.timer) clearTimeout(this.catchUp.timer);
      this.catchUp.fromMs = Math.min(this.catchUp.fromMs, g.fromMs);
    } else {
      this.catchUp = { fromMs: g.fromMs, timer: null, running: false };
    }
    void this.runCatchUp(Math.max(g.toMs, this.catchUp.fromMs));
  }

  private runCatchUp(toMs: number): Promise<void> {
    const cu = this.catchUp;
    if (!cu || cu.running) return this.idle;
    cu.running = true;
    if (cu.timer) clearTimeout(cu.timer);
    const from = Math.max(cu.fromMs, this.reconciledUntil);
    this.idle = (async () => {
      try {
        if (toMs - from >= MIN_GAP_MS) await this.reconcile(from, toMs);
      } catch (err) {
        this.log.error('engine: gap replay failed: %s', errText(err));
      } finally {
        this.reconciledUntil = Math.max(this.reconciledUntil, toMs);
        this.lastProcessedTs = Math.max(this.lastProcessedTs, toMs);
        this.catchUp = null;
        if (!this.stopped) {
          this.lastTickAt = this.now();
          this.tick();
          const pending = [...this.pendingQuotes.values()];
          this.pendingQuotes.clear();
          for (const q of pending) this.handleQuote(q);
          const gap = this.pendingGap;
          this.pendingGap = null;
          if (gap && gap.toMs > this.reconciledUntil) this.handleGap({ ...gap, fromMs: Math.max(gap.fromMs, this.reconciledUntil) });
        }
      }
    })();
    return this.idle;
  }

  /**
   * Replay 1m history over [fromMs, toMs] for every active account with positions or working
   * orders, pessimistically (SPEC §8). Public for tests; normally driven by startup / onGap.
   */
  async reconcile(fromMs: number, toMs: number): Promise<void> {
    if (!(toMs - fromMs >= MIN_GAP_MS)) return;
    const accs = [...this.accounts.values()].filter((acc) => acc.a.status === 'active' && (acc.positions.size > 0 || acc.orders.size > 0));
    if (!accs.length) return;
    const symbols = new Set<string>();
    for (const acc of accs) {
      acc.busy = true;
      for (const p of acc.positions.values()) symbols.add(p.symbol);
      for (const o of acc.orders.values()) symbols.add(o.symbol);
    }
    try {
      const bars = new Map<string, Candle[]>();
      await Promise.all(
        [...symbols].map(async (sym) => {
          try {
            bars.set(sym, cleanBars(await this.market.getHistory1m(sym, fromMs, toMs), fromMs, toMs));
          } catch (err) {
            this.log.warn('engine: no 1m history for %s over the gap (%s) — using the first live quote', sym, errText(err));
            bars.set(sym, []);
          }
        }),
      );
      if (this.stopped) return;
      for (const acc of accs) {
        if (acc.a.status !== 'active' || this.accounts.get(acc.a.id) !== acc) continue;
        try {
          this.run(() => this.replayAccount(acc, bars, fromMs, toMs));
        } catch (err) {
          this.log.error('engine: replay failed for %s: %s', acc.a.name, errText(err));
        }
      }
    } finally {
      for (const acc of accs) acc.busy = false;
    }
  }

  private replayAccount(acc: Acct, bars: Map<string, Candle[]>, fromMs: number, toMs: number): void {
    const symbols = new Set([...[...acc.positions.values()].map((p) => p.symbol), ...[...acc.orders.values()].map((o) => o.symbol)]);
    const bySymbol = new Map<string, Map<number, Candle>>();
    const times = new Set<number>();
    for (const sym of symbols) {
      const m = new Map<number, Candle>();
      for (const c of bars.get(sym) ?? []) {
        m.set(c.time * 1000, c);
        times.add(c.time * 1000);
      }
      bySymbol.set(sym, m);
    }
    const ctx: ReplayCtx = { opens: new Map(), notes: [] };
    this.replay = ctx;
    try {
      for (const t of [...times].sort((x, y) => x - y)) {
        if (acc.a.status !== 'active') break;
        const barsAt = new Map<string, Candle>();
        ctx.opens.clear();
        for (const [sym, m] of bySymbol) {
          const c = m.get(t);
          if (c) {
            barsAt.set(sym, c);
            ctx.opens.set(sym, c.open);
          }
        }
        this.runSchedule(acc, t);
        if (acc.a.status !== 'active') break;
        this.replayBar(acc, barsAt, t);
      }
    } finally {
      this.replay = null;
    }
    if (ctx.notes.length) {
      this.event(acc.a.id, this.now(), 'catch_up', acc.a.status === 'failed' ? 'danger' : 'info', 'While you were away', `While you were away: ${ctx.notes.join('; ')}`, {
        fromMs,
        toMs,
        notes: ctx.notes,
      });
    }
    this.touchSnapshot(acc, true);
  }

  /** One minute of history: adverse extreme first, then loss limits, then favorable fills. */
  private replayBar(acc: Acct, barsAt: Map<string, Candle>, t: number): void {
    const mid = t + 30_000;
    const existing = new Set([...acc.positions.values()].map((p) => p.tradeId));
    const openedHere = () => [...acc.positions.values()].some((p) => !existing.has(p.tradeId));

    // Stops (position stop-losses and working stop orders) at the bar's adverse extreme; loops so a
    // position opened by a stop entry inside the bar gets its own stop checked against the same bar.
    const adverse = () => {
      for (let pass = 0; pass < 4; pass++) {
        let fills = 0;
        for (const [sym, bar] of barsAt) {
          for (const pos of this.legs(acc, sym)) {
            if (acc.a.status !== 'active') return;
            if (pos.sl == null || !acc.positions.has(pos.tradeId)) continue;
            const long = pos.qty > 0;
            if (long ? bar.low <= pos.sl : bar.high >= pos.sl) {
              const gapped = long ? bar.open <= pos.sl : bar.open >= pos.sl;
              this.bracketFill(acc, pos, 'sl', gapped ? bar.open : pos.sl, gapped ? t : mid);
              fills++;
            }
          }
          if (acc.a.status !== 'active') return;
          for (const o of this.working(acc, sym, 'stop')) {
            if (acc.a.status !== 'active' || o.status !== 'working') continue;
            const stop = o.price!;
            if (o.side === 'buy' ? bar.high < stop : bar.low > stop) continue;
            const gapped = o.side === 'buy' ? bar.open >= stop : bar.open <= stop;
            this.fillWorking(acc, o, gapped ? bar.open : stop, 'taker', gapped ? t : mid);
            fills++;
          }
        }
        if (!fills) return;
      }
    };

    adverse();
    this.replayLossCheck(acc, barsAt, t);
    if (acc.a.status !== 'active') return;

    // Favorable extreme: take-profits (not of positions opened inside this bar) and resting limits.
    for (const [sym, bar] of barsAt) {
      for (const pos of this.legs(acc, sym)) {
        if (acc.a.status !== 'active') return;
        if (pos.tp != null && existing.has(pos.tradeId) && acc.positions.has(pos.tradeId) && (pos.qty > 0 ? bar.high >= pos.tp : bar.low <= pos.tp)) {
          this.bracketFill(acc, pos, 'tp', pos.tp, mid);
        }
      }
      if (acc.a.status !== 'active') return;
      for (const o of this.working(acc, sym, 'limit')) {
        if (acc.a.status !== 'active' || o.status !== 'working') continue;
        if (o.side === 'buy' ? bar.low <= o.price! : bar.high >= o.price!) this.fillWorking(acc, o, o.price!, 'maker', mid);
      }
    }
    if (acc.a.status !== 'active') return;
    if (openedHere()) {
      adverse();
      this.replayLossCheck(acc, barsAt, t);
      if (acc.a.status !== 'active') return;
    }

    // Marks at the close; the intraday high-water mark only learns from closes (pessimistic).
    for (const [sym, bar] of barsAt) {
      for (const pos of this.legs(acc, sym)) {
        this.setMark(acc, pos, pos.qty > 0 ? bar.high : bar.low); // MFE
        this.setMark(acc, pos, bar.close);
      }
    }
    this.trackDayEquity(acc);
    const eq = this.equity(acc);
    const a = acc.a;
    if (a.rules.maxLoss?.mode === 'trailing_intraday' && eq > a.highWaterMark) {
      a.highWaterMark = eq;
      a.maxLossThreshold = trailedThreshold(a.rules, eq, a.maxLossThreshold);
      acc.dirty = true;
    }
    this.checkPass(acc, mid);
  }

  /**
   * Loss limits at every position's adverse extreme of the bar. All prices move linearly from the
   * bar open to their adverse extreme; on a breach everything is liquidated where equity crosses the
   * limit (or at the open when it opened beyond).
   */
  private replayLossCheck(acc: Acct, barsAt: Map<string, Candle>, t: number): void {
    const a = acc.a;
    if (a.status !== 'active' || acc.positions.size === 0) return;
    const legs = [...acc.positions.values()].map((pos) => {
      const spec = this.spec(pos.symbol);
      const bar = barsAt.get(pos.symbol);
      const from = bar ? bar.open : pos.markPrice;
      const to = bar ? (pos.qty > 0 ? bar.low : bar.high) : pos.markPrice;
      return { pos, spec, from, to };
    });
    const equityAt = (f: number) =>
      a.balance + legs.reduce((s, l) => s + pnl(l.spec, l.pos.qty > 0 ? 1 : -1, Math.abs(l.pos.qty), l.pos.avgPrice, l.from + f * (l.to - l.from)), 0);
    const e0 = equityAt(0);
    const e1 = equityAt(1);
    for (const l of legs) {
      const tr = acc.trades.get(l.pos.tradeId);
      if (!tr) continue;
      const worst = round2(tr.grossPnl + pnl(l.spec, l.pos.qty > 0 ? 1 : -1, Math.abs(l.pos.qty), l.pos.avgPrice, l.to));
      if (worst < tr.mae) (tr.mae = worst), acc.dirtyTrades.add(tr.id);
    }
    if (acc.day && e1 < acc.day.lowEquity) (acc.day.lowEquity = round2(e1)), (acc.dayDirty = true);

    const limits: Array<{ kind: 'max' | 'daily' | 'personal'; level: number }> = [];
    if (a.maxLossThreshold != null) limits.push({ kind: 'max', level: a.maxLossThreshold });
    const dth = dailyLossThreshold(a);
    if (dth != null && acc.st.dailyHitDay !== a.tradingDay) limits.push({ kind: 'daily', level: dth });
    const personal = this.personalLimit(acc);
    if (personal != null && acc.st.personalHitDay !== a.tradingDay) limits.push({ kind: 'personal', level: personal });

    let hit: (typeof limits)[number] | null = null;
    let hitF = Infinity;
    for (const l of limits) {
      if (e1 > l.level + EPS) continue;
      const f = e0 <= l.level + EPS ? 0 : (e0 - l.level) / (e0 - e1);
      if (f < hitF - 1e-12) (hit = l), (hitF = f);
    }
    if (!hit) return;

    const prices = new Map<string, number>();
    for (const l of legs) {
      const raw = l.from + hitF * (l.to - l.from);
      const lo = Math.min(l.from, l.to);
      const hi = Math.max(l.from, l.to);
      // Round against the position (longs down, shorts up), within the bar's range.
      const p = l.pos.qty > 0 ? floorToStep(raw, l.spec.tickSize) : roundToStep(Math.ceil(raw / l.spec.tickSize - 1e-9) * l.spec.tickSize, l.spec.tickSize);
      prices.set(l.pos.symbol, Math.min(hi, Math.max(lo, p)));
    }
    const ts = hitF === 0 ? t : t + 30_000;
    const eq = round2(equityAt(hitF));
    if (hit.kind === 'max') this.breachMaxLoss(acc, ts, eq, prices);
    else if (hit.kind === 'daily') this.dailyLossHit(acc, ts, eq, prices);
    else this.personalLossHit(acc, ts, prices);
  }

  // ═════════════════════════════ queries ═════════════════════════════

  bootstrap(): BootstrapResponse {
    const accounts = [...this.accounts.values()];
    return {
      serverTime: this.now(),
      version: VERSION,
      localTz: this.localTz,
      settings: clone(this.settings),
      instruments: INSTRUMENTS,
      presets: PRESETS,
      accounts: accounts.map((acc) => clone(acc.a)),
      snapshots: accounts.map((acc) => this.snapshotOf(acc)),
      positions: accounts.flatMap((acc) => [...acc.positions.values()].map((p) => ({ ...p }))),
      orders: accounts.flatMap((acc) => [...acc.orders.values()].map((o) => clone(o))),
      openTrades: accounts.flatMap((acc) => [...acc.trades.values()].map((tr) => clone(tr))),
      events: this.store.queryEvents({ limit: 100 }),
      wallet: this.walletSummary(),
      feeds: this.market.getFeedStatus(),
      quotes: this.market.getQuotes(),
    };
  }

  listAccounts(): Account[] {
    return [...this.accounts.values()].map((acc) => clone(acc.a));
  }

  getAccount(id: string): Account | null {
    const acc = this.accounts.get(id);
    return acc ? clone(acc.a) : null;
  }

  snapshot(accountId: string): AccountSnapshot | null {
    const acc = this.accounts.get(accountId);
    return acc ? this.snapshotOf(acc) : null;
  }

  private snapshotOf(acc: Acct): AccountSnapshot {
    const a = acc.a;
    const t = this.now();
    let openPnl = 0;
    let exposure = 0;
    let contracts = 0;
    let margin = 0;
    for (const p of acc.positions.values()) {
      const spec = this.spec(p.symbol);
      openPnl += p.openPnl;
      exposure += notional(spec, p.qty, p.markPrice);
      contracts += contractsEquivalent(spec, p.qty);
      margin += marginFor(a.rules, spec, p.qty, p.markPrice);
    }
    openPnl = round2(openPnl);
    const equity = round2(a.balance + openPnl);
    const dayRealized = acc.day?.netPnl ?? 0;
    const dth = dailyLossThreshold(a);
    const profit = round2(a.balance - a.rules.startingBalance);
    const bestDay = this.bestDay(acc);
    return {
      accountId: a.id,
      ts: t,
      status: a.status,
      balance: a.balance,
      equity,
      openPnl,
      dayRealized,
      dayPnl: round2(dayRealized + openPnl),
      tradingDay: a.tradingDay,
      maxLossThreshold: a.maxLossThreshold,
      maxLossBuffer: a.maxLossThreshold != null ? round2(equity - a.maxLossThreshold) : null,
      dailyLossThreshold: dth,
      dailyLossBuffer: dth != null ? round2(equity - dth) : null,
      profit,
      targetProgress: a.rules.profitTarget ? profit / a.rules.profitTarget : null,
      tradingDays: a.tradingDays,
      bestDay,
      consistencyOk: consistencyOk(a.rules, bestDay, profit),
      exposure: round2(exposure),
      contracts: Number(contracts.toFixed(4)),
      marginUsed: round2(margin),
      dayTrades: acc.day?.trades ?? 0,
      consecutiveLosses: acc.st.streakDay === a.tradingDay ? acc.st.consecutiveLosses : 0,
      lock: isLockActive(a.lock, t) ? { ...a.lock } : null,
      passBlockers: passBlockers(a, { openPositions: acc.positions.size, openPnl, bestDay }),
    };
  }

  /** Trades from the database with live (in-memory) values for open ones. */
  listTrades(q: TradeQuery): Trade[] {
    return this.store.queryTrades(q).map((tr) => {
      const live = this.accounts.get(tr.accountId)?.trades.get(tr.id);
      return live ? clone(live) : tr;
    });
  }

  getTrade(id: string): Trade {
    for (const acc of this.accounts.values()) {
      const live = acc.trades.get(id);
      if (live) return clone(live);
    }
    return this.store.getTrade(id) ?? fail('not_found', 'Trade not found');
  }

  listFills(q: { accountId?: string | null; from?: number | null; to?: number | null; limit: number }): Fill[] {
    return this.store.queryFills(q);
  }

  /** A trade's fills, oldest first — including a flip's closing fill, which can carry the next trade's id. */
  tradeFills(t: Trade): Fill[] {
    const close = t.closedAt ?? this.now();
    const all = this.store.queryFills({ accountId: t.accountId, from: t.openedAt - 1000, to: close + 1000, limit: 1000 });
    const own = all.filter((f) => f.tradeId === t.id);
    const hasExit = own.some((f) => Math.abs(f.ts - close) <= 1000 && f.realizedPnl !== 0);
    const flip = hasExit || t.closedAt == null ? [] : all.filter((f) => f.tradeId !== t.id && f.symbol === t.symbol && Math.abs(f.ts - close) <= 1000);
    return [...own, ...flip].sort((a, b) => a.ts - b.ts);
  }

  /** Stop / target changes recorded for a trade, oldest first. */
  tradeBrackets(tradeId: string): BracketChange[] {
    return this.store.queryBrackets(tradeId);
  }

  /** Bid/ask samples the tick recorder stored for `symbol` in [from, to]. */
  recordedTicks(symbol: string, from: number, to: number): TickSample[] {
    return this.store.queryTicks(symbol, from, to);
  }

  /** Symbols with an open position on any account (the tick recorder records these). */
  positionSymbols(): Set<string> {
    const out = new Set<string>();
    for (const acc of this.accounts.values()) for (const p of acc.positions.values()) out.add(p.symbol);
    return out;
  }

  listDaily(q: { accountId?: string | null; from?: string | null; to?: string | null }): DailyStat[] {
    return this.store.queryDaily(q).map((d) => {
      const live = this.accounts.get(d.accountId)?.day;
      return live && live.day === d.day ? clone(live) : d;
    });
  }

  listEquity(accountId: string, from?: number | null, to?: number | null) {
    return this.store.queryEquity(accountId, from, to);
  }

  listEvents(q: { accountId?: string | null; limit: number; from?: number | null; before?: number | null }): AccountEvent[] {
    return this.store.queryEvents(q);
  }

  listDrawings(symbol: string): Drawing[] {
    return this.store.listDrawings(symbol);
  }

  listNotes(from?: string | null, to?: string | null): DayNote[] {
    return this.store.queryNotes(from, to);
  }

  getSettings(): Settings {
    return clone(this.settings);
  }

  wallet(): WalletResponse {
    return { summary: this.walletSummary(), transactions: this.store.listWalletTx() };
  }

  private walletSummary(): WalletSummary {
    return walletSummary(this.store.listWalletTx(), this.settings.monthlyBudget, this.localTz, this.now());
  }

  // ═════════════════════════════ command helpers ═════════════════════════════

  /** Bring an account up to date (rollovers, expired locks) in its own transaction before a command validates. */
  private sync(accountId: unknown): void {
    if (typeof accountId !== 'string') return;
    const acc = this.accounts.get(accountId);
    if (!acc || acc.a.status !== 'active' || acc.busy || this.catchUp) return;
    const t = this.now();
    const lockDue = acc.a.lock?.until != null && acc.a.lock.until <= t;
    if (t < acc.dayEnd && !lockDue) return;
    this.run(() => {
      this.processRollovers(acc, t);
      this.expireLock(acc, t);
    });
  }

  private accountOf(id: unknown): Acct {
    const acc = typeof id === 'string' ? this.accounts.get(id) : undefined;
    return acc ?? fail('not_found', 'Account not found');
  }

  /** An active, not-busy account. */
  private tradable(id: unknown): Acct {
    const acc = this.accountOf(id);
    const s = acc.a.status;
    if (s !== 'active') fail('account_closed', `This account has ${s === 'closed' ? 'been closed' : s} — trading is over on it.`);
    if (acc.busy || this.catchUp) fail('busy', 'Catching up on missed market data — try again in a few seconds.');
    return acc;
  }

  private checkSymbol(acc: Acct, symbol: unknown): InstrumentSpec {
    const spec = typeof symbol === 'string' ? getInstrument(symbol) : undefined;
    if (!spec) fail('invalid', `Unknown symbol ${String(symbol)}`);
    const allowed = acc.a.rules.allowedClasses;
    if (allowed && !allowed.includes(spec.assetClass)) fail('rule_violation', classNotAllowedMessage(acc.a.rules, spec));
    return spec;
  }

  private checkQty(spec: InstrumentSpec, qty: unknown): number {
    if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) fail('invalid', 'Quantity must be a positive number');
    if (!isOnStep(qty, spec.qtyStep)) fail('invalid', `Quantity must be a multiple of ${spec.qtyStep} (${spec.unitLabel})`);
    const q = roundToStep(qty, spec.qtyStep);
    if (q < spec.minQty - EPS) fail('invalid', `Minimum quantity is ${spec.minQty} (${spec.unitLabel})`);
    if (q > 1e9) fail('invalid', 'Quantity is too large');
    return q;
  }

  private checkPrice(spec: InstrumentSpec, v: unknown, what: string): number {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) fail('invalid', `${what} must be a positive price`);
    return roundPrice(spec, v);
  }

  private optPrice(spec: InstrumentSpec, v: unknown, what: string): number | null {
    return v == null ? null : this.checkPrice(spec, v, what);
  }

  private requireOpen(spec: InstrumentSpec, t: number): void {
    const s = sessionState(spec.session, t);
    if (!s.open) fail('market_closed', marketClosedMessage(s));
  }

  private requireQuote(symbol: string): Quote {
    const q = this.market.getQuote(symbol);
    if (!validQuote(q)) fail('no_price', `No price for ${symbol} yet — waiting for market data`);
    return q;
  }

  /** Why new risk can't be opened right now (lock, flat-by window, weekend), or null. */
  private entryBlocker(acc: Acct, spec: InstrumentSpec, t: number): Blocker | null {
    const a = acc.a;
    if (isLockActive(a.lock, t)) {
      const left = a.lock.until != null ? `unlocks in ${fmtDuration(a.lock.until - t)}` : 'unlocks next trading day';
      return { code: 'locked', message: `Locked: ${a.lock.message} (${left}). You can still close positions and cancel orders.` };
    }
    if (isFutures(spec) && a.rules.flatBy) {
      const at = flatByInDay(a.rules, a.tradingDay);
      if (at != null && t >= at) {
        return { code: 'rule_violation', message: `Flat-by time ${fmtZoned(a.rules.flatBy)} has passed — no new futures positions until the next trading day` };
      }
    }
    if (inWeekendBlock(a.rules, t)) return { code: 'rule_violation', message: 'No weekend holding — new positions open again Sunday 6:00 PM ET' };
    return null;
  }

  private assertEntryAllowed(acc: Acct, spec: InstrumentSpec, t: number): void {
    const b = this.entryBlocker(acc, spec, t);
    if (b) fail(b.code, b.message);
  }

  /** Position limit (maxContracts) and margin after a position in `spec` becomes `newQty` at `price`. */
  private exposureBlocker(acc: Acct, spec: InstrumentSpec, newQty: number, price: number): Blocker | null {
    const r = acc.a.rules;
    if (r.maxContracts != null && spec.miniEquivalent != null) {
      let before = 0;
      let after = contractsEquivalent(spec, newQty);
      for (const p of acc.positions.values()) {
        const c = contractsEquivalent(this.spec(p.symbol), p.qty);
        before += c;
        if (p.symbol !== spec.symbol) after += c;
      }
      if (after > r.maxContracts + EPS && after > before + EPS) return { code: 'rule_violation', message: maxContractsMessage(r.maxContracts) };
    }
    if (r.leverage) {
      let before = 0;
      let after = marginFor(r, spec, newQty, price);
      for (const p of acc.positions.values()) {
        const m = marginFor(r, this.spec(p.symbol), p.qty, p.markPrice);
        before += m;
        if (p.symbol !== spec.symbol) after += m;
      }
      const eq = this.equity(acc);
      if (after > eq + EPS && after > before + EPS) {
        const lev = r.leverage[spec.assetClass] ?? 1;
        // Largest position in this symbol the equity left after the other positions' margin can hold.
        const max = Math.max(0, (eq - (after - marginFor(r, spec, newQty, price))) * lev);
        return {
          code: 'insufficient_margin',
          message: `Too big for this account: ${fmtLeverage(lev)} leverage on ${ASSET_CLASS_LABELS[spec.assetClass]} lets you hold up to ${moneyWhole(max)} of ${spec.symbol} right now — this would make your position ${moneyWhole(notional(spec, newQty, price))}`,
        };
      }
    }
    return null;
  }

  private assertExposure(acc: Acct, spec: InstrumentSpec, newQty: number, price: number): void {
    const b = this.exposureBlocker(acc, spec, newQty, price);
    if (b) fail(b.code, b.message);
  }

  /** settings.requireStopLoss: every entry opens a position of its own, so every entry needs its own stop. */
  private assertStop(sl: number | null): void {
    if (this.settings.requireStopLoss && sl == null) fail('stop_required', 'A stop-loss is required on every entry (Settings → Discipline)');
  }

  /** An order filled right away at the touch (market, or a marketable limit), recorded as an Order. */
  private marketOrder(
    acc: Acct,
    spec: InstrumentSpec,
    side: Side,
    qty: number,
    q: Quote,
    t: number,
    role: OrderRole,
    exitReason: ExitReason,
    entry: { sl: number | null; tp: number | null; tags: TradeTags | null } | null,
    limitPrice: number | null = null,
    positionId: string | null = null,
  ): Order {
    const price = marketPrice(side, q);
    const o: Order = {
      id: randomUUID(),
      accountId: acc.a.id,
      symbol: spec.symbol,
      side,
      type: limitPrice == null ? 'market' : 'limit',
      qty,
      price: limitPrice,
      status: 'filled',
      role,
      reduceOnly: false,
      sl: entry?.sl ?? null,
      tp: entry?.tp ?? null,
      tags: entry?.tags ?? null,
      createdAt: t,
      updatedAt: t,
      filledAt: t,
      fillPrice: price,
      rejectReason: null,
    };
    this.saveOrder(o);
    this.executeFill(acc, { symbol: spec.symbol, side, qty, price, liquidity: 'taker', role, orderId: o.id, ts: t, exitReason, positionId, sl: o.sl, tp: o.tp, tags: o.tags });
    return o;
  }

  private findWorkingOrder(id: unknown): { acc: Acct; order: Order } {
    if (typeof id !== 'string') fail('not_found', 'Order not found');
    for (const acc of this.accounts.values()) {
      const order = acc.orders.get(id);
      if (order) return { acc, order };
    }
    const stored = this.store.getOrder(id);
    if (stored) fail('conflict', `This order is already ${stored.status}`);
    fail('not_found', 'Order not found');
  }

  private resolveRules(r: AccountRules): AccountRules {
    const zone = (z: ZonedTime): ZonedTime => ({ ...z, tz: z.tz === 'local' ? this.localTz : z.tz });
    return {
      ...r,
      maxLoss: r.maxLoss ? { ...r.maxLoss } : null,
      dailyLoss: r.dailyLoss ? { ...r.dailyLoss } : null,
      leverage: r.leverage ? { ...r.leverage } : null,
      allowedClasses: r.allowedClasses ? [...r.allowedClasses] : null,
      flatBy: r.flatBy ? zone(r.flatBy) : null,
      rollover: zone(r.rollover),
    };
  }

  private createAccountRecord(p: {
    id: string;
    name: string;
    kind: Account['kind'];
    presetId: string | null;
    phase: number;
    phaseCount: number;
    rules: AccountRules;
    payout: PayoutPolicy | null;
    fee: number;
    parentId: string | null;
    t: number;
  }): Acct {
    const rules = this.resolveRules(p.rules);
    const a: Account = {
      id: p.id,
      name: p.name,
      kind: p.kind,
      status: 'active',
      presetId: p.presetId,
      phase: p.phase,
      phaseCount: p.phaseCount,
      rules,
      payout: p.payout ? { ...p.payout } : null,
      fee: p.fee,
      createdAt: p.t,
      endedAt: null,
      endReason: null,
      parentId: p.parentId,
      balance: rules.startingBalance,
      highWaterMark: rules.startingBalance,
      maxLossThreshold: initialThreshold(rules),
      dayStartBalance: rules.startingBalance,
      tradingDay: tradingDayOf(p.t, rules.rollover),
      tradingDays: 0,
      lock: null,
      archived: false,
      totalPayouts: 0,
      lastPayoutAt: null,
    };
    const acc = this.newAcct(a, {});
    this.accounts.set(a.id, acc);
    this.saveAccount(acc);
    this.touchSnapshot(acc, true);
    return acc;
  }

  private walletCharge(kind: WalletTx['kind'], amount: number, accountId: string, note: string, what: string, t: number): void {
    if (!(amount > 0)) return;
    const bal = this.store.walletBalance();
    if (bal + EPS < amount) fail('insufficient_funds', `Wallet balance ${money(bal)} — ${what} ${money(amount)}`);
    this.addWalletTx({ id: randomUUID(), ts: t, kind, amount: -round2(amount), accountId, note, balanceAfter: round2(bal - amount) });
  }

  // ═════════════════════════════ commands: accounts ═════════════════════════════

  createAccount(req: CreateAccountRequest): Account {
    return this.run(() => {
      const t = this.now();
      const r = asObj(req, 'Request');
      const name = optText(r.name, 'Name', 80);
      const id = randomUUID();
      let acc: Acct;
      if (r.kind === 'practice') {
        const sb = r.startingBalance == null ? DEFAULT_PRACTICE_BALANCE : round2(num(r.startingBalance, 'Starting balance', { min: 1_000, max: 10_000_000 }));
        const fees = r.fees == null ? 'real' : oneOf(r.fees, FEES_MODES, 'fees');
        const rules = { ...practiceRules(sb), fees };
        acc = this.createAccountRecord({ id, name: name ?? practiceName(sb), kind: 'practice', presetId: null, phase: 0, phaseCount: 0, rules, payout: null, fee: 0, parentId: null, t });
        this.event(id, t, 'account_created', 'info', 'Live account opened', `${acc.a.name} — ${money(sb)} to trade with. No challenge rules, no fee${fees === 'off' ? ', no trading fees' : ''}.`);
      } else if (r.kind === 'evaluation') {
        if (r.presetId != null) {
          const preset = typeof r.presetId === 'string' ? PRESET_MAP[r.presetId] : undefined;
          if (!preset) fail('not_found', 'Unknown challenge preset');
          this.walletCharge('challenge_fee', preset.fee, id, `${preset.name} evaluation`, 'this challenge costs', t);
          acc = this.createAccountRecord({
            id,
            name: name ?? presetAccountName(preset, 0, 1),
            kind: 'evaluation',
            presetId: preset.id,
            phase: 1,
            phaseCount: preset.phases.length,
            rules: rulesForPhase(preset, 0),
            payout: null,
            fee: preset.fee,
            parentId: null,
            t,
          });
        } else {
          const rules = validateRules(r.rules);
          const fee = r.fee == null ? 0 : round2(num(r.fee, 'Fee', { min: 0, max: 100_000 }));
          this.walletCharge('challenge_fee', fee, id, 'Custom evaluation', 'this challenge costs', t);
          acc = this.createAccountRecord({ id, name: name ?? customName(rules.startingBalance), kind: 'evaluation', presetId: null, phase: 1, phaseCount: 1, rules, payout: null, fee, parentId: null, t });
        }
        const ar = acc.a.rules;
        const parts = [`Target ${targetText(ar)}`];
        if (ar.maxLoss) parts.push(`max loss ${money(ar.maxLoss.amount)}`);
        if (ar.dailyLoss) parts.push(`daily loss ${money(ar.dailyLoss.amount)}`);
        this.event(id, t, 'account_created', 'info', 'Challenge started', `${acc.a.name}${acc.a.fee > 0 ? ` — ${money(acc.a.fee)} paid from your wallet` : ''}. ${parts.join(', ')}.`);
      } else {
        fail('invalid', "kind must be 'practice' or 'evaluation'");
      }
      return clone(acc.a);
    });
  }

  updateAccount(id: string, req: UpdateAccountRequest): Account {
    return this.run(() => {
      const acc = this.accountOf(id);
      const r = asObj(req, 'Request');
      const name = r.name === undefined ? undefined : optText(r.name, 'Name', 80);
      if (name === null) fail('invalid', 'Name cannot be empty');
      const archived = r.archived === undefined ? undefined : bool(r.archived, 'archived');
      const fees = r.fees === undefined ? undefined : oneOf(r.fees, FEES_MODES, 'fees');
      // Prop firms always charge commissions: only practice accounts can trade without them.
      if (fees !== undefined && acc.a.kind !== 'practice') fail('invalid', 'Trading fees can only be switched off on practice accounts');
      if (name !== undefined) acc.a.name = name;
      if (archived !== undefined) acc.a.archived = archived;
      if (fees !== undefined) acc.a.rules = { ...acc.a.rules, fees };
      this.saveAccount(acc);
      return clone(acc.a);
    });
  }

  /** Cancel all working orders and close every position at market. */
  flattenAccount(id: string): void {
    this.sync(id);
    const skipped = this.run(() => {
      const acc = this.accountOf(id);
      if (acc.a.status !== 'active') return [] as string[];
      if (acc.busy || this.catchUp) fail('busy', 'Catching up on missed market data — try again in a few seconds.');
      const t = this.now();
      for (const o of [...acc.orders.values()]) this.cancelWorking(acc, o, t, null, false);
      const left: string[] = [];
      for (const symbol of this.positionSymbolsOf(acc)) {
        const spec = this.spec(symbol);
        const q = this.market.getQuote(symbol);
        if (!sessionState(spec.session, t).open || !validQuote(q)) {
          left.push(symbol);
          continue;
        }
        const net = this.netQty(acc, symbol);
        this.marketOrder(acc, spec, exitSide(net), Math.abs(net), q, t, 'exit', 'manual', null);
      }
      this.evaluate(acc, t);
      return left;
    });
    if (skipped.length) {
      const spec = this.spec(skipped[0]);
      fail('market_closed', `${marketClosedMessage(sessionState(spec.session, this.now()))} — ${skipped.join(', ')} still open (orders were cancelled)`);
    }
  }

  takeBreak(id: string, req: BreakRequest): Account {
    this.sync(id);
    return this.run(() => {
      const acc = this.accountOf(id);
      if (acc.a.status !== 'active') fail('account_closed', 'Only active accounts can take a break');
      const r = asObj(req, 'Request');
      const minutes = Math.round(num(r.minutes, 'Minutes', { min: 1, max: 7 * 24 * 60 }));
      const note = optText(r.message, 'Message', 200);
      const t = this.now();
      this.applyLock(acc, t, 'break', t + minutes * 60_000, note ?? `Taking a ${fmtMinutes(minutes)} break`, 'info');
      return clone(acc.a);
    });
  }

  /** New phase-1 attempt of a failed preset evaluation (pays resetFee ?? fee). */
  retryAccount(id: string): Account {
    return this.run(() => {
      const t = this.now();
      const acc = this.accountOf(id);
      const a = acc.a;
      if (a.kind !== 'evaluation' || a.status !== 'failed') fail('conflict', 'Only failed evaluations can be retried');
      const preset = a.presetId ? PRESET_MAP[a.presetId] : undefined;
      if (!preset) fail('conflict', 'Custom challenges cannot be retried — start a new one');
      if ([...this.accounts.values()].some((x) => x.a.parentId === a.id && x.a.kind === 'evaluation' && x.a.phase === 1)) {
        fail('conflict', 'This attempt was already retried');
      }
      const fee = preset.resetFee ?? preset.fee;
      const attempt = this.attemptOf(acc) + 1;
      const newId = randomUUID();
      this.walletCharge('reset_fee', fee, newId, `${preset.name} · attempt ${attempt}`, 'a new attempt costs', t);
      const next = this.createAccountRecord({
        id: newId,
        name: presetAccountName(preset, 0, attempt),
        kind: 'evaluation',
        presetId: preset.id,
        phase: 1,
        phaseCount: preset.phases.length,
        rules: rulesForPhase(preset, 0),
        payout: null,
        fee,
        parentId: a.id,
        t,
      });
      this.event(newId, t, 'account_created', 'info', `Attempt ${attempt}`, `${next.a.name} — reset fee ${money(fee)} paid. Same rules, clean slate.`);
      return clone(next.a);
    });
  }

  /** Funded account from a passed final phase (pays activationFee; one activation per evaluation). */
  activateFunded(id: string): Account {
    return this.run(() => {
      const t = this.now();
      const acc = this.accountOf(id);
      const a = acc.a;
      if (a.kind !== 'evaluation' || a.status !== 'passed' || a.phase < a.phaseCount) fail('conflict', 'Only a passed final-phase evaluation can be activated');
      if ([...this.accounts.values()].some((x) => x.a.parentId === a.id && x.a.kind === 'funded')) fail('conflict', 'This evaluation was already activated');
      const preset = a.presetId ? (PRESET_MAP[a.presetId] ?? null) : null;
      if (preset && !preset.funded) fail('conflict', 'This challenge has no funded stage');
      const funded = preset?.funded ?? {
        rules: { ...a.rules, profitTarget: null, minTradingDays: 0, maxCalendarDays: null, consistencyPct: null },
        payout: CUSTOM_PAYOUT,
      };
      const fee = preset?.activationFee ?? 0;
      const newId = randomUUID();
      const name = fundedName(preset, a.name);
      this.walletCharge('activation_fee', fee, newId, `${name} activation`, 'activation costs', t);
      const f = this.createAccountRecord({ id: newId, name, kind: 'funded', presetId: a.presetId, phase: 0, phaseCount: 0, rules: funded.rules, payout: funded.payout, fee, parentId: a.id, t });
      this.event(
        newId,
        t,
        'funded',
        'success',
        'Funded account activated',
        `${name} is live with ${money(f.a.balance)}. ${Math.round(funded.payout.profitSplit * 100)}% of every payout goes to your wallet.${fee > 0 ? ` Activation fee ${money(fee)} paid.` : ''}`,
      );
      return clone(f.a);
    });
  }

  payoutEligibility(id: string): PayoutEligibility {
    return this.eligibility(this.accountOf(id));
  }

  private eligibility(acc: Acct): PayoutEligibility {
    const a = acc.a;
    const p = a.payout;
    if (a.kind !== 'funded' || !p) {
      return { eligible: false, maxAmount: 0, minAmount: 0, profitSplit: 0, winningDays: 0, requiredWinningDays: 0, reasons: ['Payouts are only available on funded accounts'] };
    }
    const since = a.lastPayoutAt != null ? tradingDayOf(a.lastPayoutAt, a.rules.rollover) : null;
    const winningDays = this.listDaily({ accountId: a.id }).filter((d) => (since == null || d.day > since) && d.netPnl >= p.minDayProfit - EPS).length;
    const profit = round2(a.balance - a.rules.startingBalance);
    const maxAmount = Math.max(0, floorToStep(p.maxPctOfProfit * profit, 0.01));
    const reasons: string[] = [];
    if (a.status !== 'active') reasons.push(`This account has ${a.status === 'closed' ? 'been closed' : a.status}`);
    if (acc.positions.size > 0) reasons.push('Close your open positions first');
    if (winningDays < p.minWinningDays) {
      reasons.push(`${plural(p.minWinningDays - winningDays, 'more winning day')} needed (days of +${money(p.minDayProfit)} or more${since ? ' since your last payout' : ''})`);
    }
    if (profit <= 0) reasons.push('No profit to withdraw yet');
    else if (maxAmount < p.minAmount) reasons.push(`Minimum payout is ${money(p.minAmount)} — you can withdraw up to ${money(maxAmount)} so far`);
    return { eligible: reasons.length === 0, maxAmount, minAmount: p.minAmount, profitSplit: p.profitSplit, winningDays, requiredWinningDays: p.minWinningDays, reasons };
  }

  requestPayout(id: string, req: PayoutRequest): PayoutResponse {
    this.sync(id);
    return this.run(() => {
      const t = this.now();
      const acc = this.accountOf(id);
      const a = acc.a;
      const amount = round2(num(asObj(req, 'Request').amount, 'Amount', { min: 0, gt: true, max: 1e9 }));
      const e = this.eligibility(acc);
      if (!e.eligible) fail(a.kind === 'funded' ? 'rule_violation' : 'conflict', e.reasons[0]);
      if (amount < e.minAmount - EPS || amount > e.maxAmount + EPS) fail('invalid', `Payout must be between ${money(e.minAmount)} and ${money(e.maxAmount)}`);
      const received = round2(amount * e.profitSplit);
      a.balance = round2(a.balance - amount);
      a.dayStartBalance = round2(a.dayStartBalance - amount); // a payout is not a trading loss
      a.totalPayouts = round2(a.totalPayouts + amount);
      a.lastPayoutAt = t;
      const bal = this.store.walletBalance();
      this.addWalletTx({
        id: randomUUID(),
        ts: t,
        kind: 'payout',
        amount: received,
        accountId: a.id,
        note: `${a.name} payout · ${Math.round(e.profitSplit * 100)}% of ${money(amount)}`,
        balanceAfter: round2(bal + received),
      });
      this.flag(acc, 'payout');
      if (acc.day) {
        acc.day.endBalance = a.balance;
        this.saveDay(acc, acc.day);
      }
      this.saveAccount(acc);
      this.addEquityPoint(acc, t);
      this.event(a.id, t, 'payout', 'success', `Payout of ${money(amount)} approved`, `${money(received)} (${Math.round(e.profitSplit * 100)}% split) landed in your wallet.`, {
        amount,
        received,
      });
      this.touchSnapshot(acc, true);
      return { account: clone(a), wallet: this.walletSummary(), received };
    });
  }

  // ═════════════════════════════ commands: orders & positions ═════════════════════════════

  placeOrder(req: PlaceOrderRequest): Order {
    const body = asObj(req, 'Order');
    this.sync(body.accountId);
    return this.run(() => {
      const t = this.now();
      const acc = this.tradable(body.accountId);
      const spec = this.checkSymbol(acc, body.symbol);
      if (body.side !== 'buy' && body.side !== 'sell') fail('invalid', "side must be 'buy' or 'sell'");
      if (body.type !== 'market' && body.type !== 'limit' && body.type !== 'stop') fail('invalid', "type must be 'market', 'limit' or 'stop'");
      const side: Side = body.side;
      const type: OrderType = body.type;
      const qty = this.checkQty(spec, body.qty);
      const price = type === 'market' ? null : this.checkPrice(spec, body.price, type === 'limit' ? 'Limit price' : 'Stop price');
      const sl = this.optPrice(spec, body.sl, 'Stop-loss');
      const tp = this.optPrice(spec, body.tp, 'Take-profit');
      const tags = orderTags(body.tags);
      this.requireOpen(spec, t);
      const q = this.requireQuote(spec.symbol);
      if (type === 'stop' && stopTriggered(spec, side, price!, q)) {
        fail('invalid', `${side === 'buy' ? 'Buy stop must be above' : 'Sell stop must be below'} the current price (${px(spec, stopReference(spec, side, q))})`);
      }
      const net = this.netQty(acc, spec.symbol);
      const reducing = isReducing(net, side, qty);
      const immediate = type === 'market' || (type === 'limit' && limitMarketable(spec, side, price!, q));
      const execPrice = immediate ? marketPrice(side, q) : price!;
      if (!reducing) {
        this.assertEntryAllowed(acc, spec, t);
        this.assertStop(sl);
        const bracketError = validateBracket(sideSign(side), execPrice, sl, tp);
        if (bracketError) fail('invalid', bracketError);
        this.assertExposure(acc, spec, roundToStep(net + sideSign(side) * qty, spec.qtyStep), execPrice);
      }
      const entry = reducing ? null : { sl, tp, tags };
      if (immediate) {
        // Market order, or a marketable limit: immediate taker fill at the touch.
        const o = this.marketOrder(acc, spec, side, qty, q, t, reducing ? 'exit' : 'entry', 'manual', entry, type === 'limit' ? price : null);
        this.evaluate(acc, t);
        return clone(o);
      }
      const o: Order = {
        id: randomUUID(),
        accountId: acc.a.id,
        symbol: spec.symbol,
        side,
        type,
        qty,
        price,
        status: 'working',
        role: reducing ? 'exit' : 'entry',
        reduceOnly: reducing,
        sl: entry?.sl ?? null,
        tp: entry?.tp ?? null,
        tags: entry?.tags ?? null,
        createdAt: t,
        updatedAt: t,
        filledAt: null,
        fillPrice: null,
        rejectReason: null,
      };
      acc.orders.set(o.id, o);
      this.saveOrder(o);
      this.retentionDirty = true;
      return clone(o);
    });
  }

  modifyOrder(id: string, req: ModifyOrderRequest): Order {
    const found = this.findWorkingOrder(id);
    this.sync(found.acc.a.id);
    return this.run(() => {
      const t = this.now();
      const { acc, order: o } = this.findWorkingOrder(id);
      this.tradable(acc.a.id);
      const r = asObj(req, 'Request');
      const spec = this.spec(o.symbol);
      const price = r.price === undefined ? o.price! : this.checkPrice(spec, r.price, o.type === 'limit' ? 'Limit price' : 'Stop price');
      const qty = r.qty === undefined ? o.qty : this.checkQty(spec, r.qty);
      const sl = r.sl === undefined ? o.sl : this.optPrice(spec, r.sl, 'Stop-loss');
      const tp = r.tp === undefined ? o.tp : this.optPrice(spec, r.tp, 'Take-profit');
      this.requireOpen(spec, t);
      const q = this.requireQuote(spec.symbol);
      const net = this.netQty(acc, o.symbol);
      const reducing = isReducing(net, o.side, qty);
      if (o.reduceOnly && !reducing) fail('invalid', 'This exit order cannot be larger than the position');
      if (o.type === 'stop' && stopTriggered(spec, o.side, price, q)) {
        fail('invalid', `${o.side === 'buy' ? 'Buy stop must be above' : 'Sell stop must be below'} the current price (${px(spec, stopReference(spec, o.side, q))})`);
      }
      const immediate = o.type === 'limit' && limitMarketable(spec, o.side, price, q);
      const execPrice = immediate ? marketPrice(o.side, q) : price;
      if (!reducing) {
        this.assertEntryAllowed(acc, spec, t);
        this.assertStop(sl);
        const bracketError = validateBracket(sideSign(o.side), execPrice, sl, tp);
        if (bracketError) fail('invalid', bracketError);
        this.assertExposure(acc, spec, roundToStep(net + sideSign(o.side) * qty, spec.qtyStep), execPrice);
      }
      Object.assign(o, { price, qty, sl: reducing ? null : sl, tp: reducing ? null : tp, role: reducing ? 'exit' : 'entry', reduceOnly: reducing, updatedAt: t });
      acc.touches.delete(o.id);
      if (immediate) {
        // Became marketable: fills now at the touch as a taker.
        acc.orders.delete(o.id);
        Object.assign(o, { status: 'filled', filledAt: t, fillPrice: execPrice });
        this.saveOrder(o);
        this.executeFill(acc, {
          symbol: o.symbol,
          side: o.side,
          qty,
          price: execPrice,
          liquidity: 'taker',
          role: o.role,
          orderId: o.id,
          ts: t,
          exitReason: 'manual',
          sl: o.sl,
          tp: o.tp,
          tags: o.tags,
        });
        this.evaluate(acc, t);
      } else {
        this.saveOrder(o);
      }
      return clone(o);
    });
  }

  cancelOrder(id: string): Order {
    return this.run(() => {
      const { acc, order } = this.findWorkingOrder(id);
      this.cancelWorking(acc, order, this.now(), null, false);
      return clone(order);
    });
  }

  /** Close one position (`tradeId`) or all of a symbol's positions (oldest first), fully or in part, at market. */
  closePosition(req: ClosePositionRequest): void {
    const body = asObj(req, 'Request');
    this.sync(body.accountId);
    this.run(() => {
      const t = this.now();
      const acc = this.tradable(body.accountId);
      const spec = this.spec(String(body.symbol));
      const legs = this.legs(acc, spec.symbol);
      if (!legs.length) fail('not_found', `No open position in ${spec.symbol}`);
      const one = body.tradeId == null ? null : (legs.find((p) => p.tradeId === body.tradeId) ?? fail('not_found', 'This position is already closed'));
      const size = Math.abs(one ? one.qty : this.netQty(acc, spec.symbol));
      const qty = body.qty == null ? size : Math.min(this.checkQty(spec, body.qty), size);
      this.requireOpen(spec, t);
      const q = this.requireQuote(spec.symbol);
      this.marketOrder(acc, spec, exitSide(legs[0].qty), qty, q, t, 'exit', 'manual', null, null, one?.tradeId ?? null);
      this.evaluate(acc, t);
    });
  }

  /** Market order of 2× the symbol's positions in the opposite direction: closes them all, opens one the other way. */
  reversePosition(req: ReversePositionRequest): void {
    const body = asObj(req, 'Request');
    this.sync(body.accountId);
    this.run(() => {
      const t = this.now();
      const acc = this.tradable(body.accountId);
      const spec = this.spec(String(body.symbol));
      const net = this.netQty(acc, spec.symbol);
      if (net === 0) fail('not_found', `No open position in ${spec.symbol}`);
      this.requireOpen(spec, t);
      const q = this.requireQuote(spec.symbol);
      const side = exitSide(net);
      this.assertEntryAllowed(acc, spec, t);
      if (this.settings.requireStopLoss) fail('stop_required', 'A stop-loss is required on every entry — close the position and enter again with a stop');
      this.assertExposure(acc, spec, -net, marketPrice(side, q));
      this.marketOrder(acc, spec, side, roundToStep(Math.abs(net) * 2, spec.qtyStep), q, t, 'entry', 'reversal', { sl: null, tp: null, tags: null });
      this.evaluate(acc, t);
    });
  }

  /**
   * Set / move / remove the stop-loss and take-profit (undefined = unchanged, null = remove) of one position
   * (`tradeId`) or of all the symbol's positions. Returns the positions it changed.
   */
  setBracket(req: SetBracketRequest): Position[] {
    const body = asObj(req, 'Request');
    this.sync(body.accountId);
    return this.run(() => {
      const t = this.now();
      const acc = this.tradable(body.accountId);
      const spec = this.spec(String(body.symbol));
      const legs = this.legs(acc, spec.symbol);
      if (!legs.length) fail('not_found', `No open position in ${spec.symbol}`);
      const targets = body.tradeId == null ? legs : [legs.find((p) => p.tradeId === body.tradeId) ?? fail('not_found', 'This position is already closed')];
      const dir = legs[0].qty > 0 ? 1 : -1;
      const slIn = body.sl === undefined ? undefined : this.optPrice(spec, body.sl, 'Stop-loss');
      const tpIn = body.tp === undefined ? undefined : this.optPrice(spec, body.tp, 'Take-profit');
      const q = this.market.getQuote(spec.symbol);
      const ref = validQuote(q) ? markFor(legs[0].qty, q) : legs[0].markPrice;
      const bracketError = validateBracket(dir, ref, slIn, tpIn);
      if (bracketError) fail('invalid', bracketError);
      const lock = acc.a.lock;
      for (const pos of targets) {
        if (this.settings.requireStopLoss && slIn === null && pos.sl != null) fail('stop_required', 'A stop-loss is required — move it instead of removing it');
        if (isLockActive(lock, t) && slIn != null && pos.sl != null && (dir === 1 ? slIn < pos.sl : slIn > pos.sl)) {
          fail('locked', `Locked: ${lock.message}. You can tighten or remove your stop, not move it further away.`);
        }
      }
      for (const pos of targets) {
        if (slIn !== undefined) pos.sl = slIn;
        if (tpIn !== undefined) pos.tp = tpIn;
        acc.touches.delete(`tp:${pos.tradeId}`);
        const tr = acc.trades.get(pos.tradeId);
        if (tr && this.captureInitialStop(tr, pos, spec, t)) this.saveTrade(acc, tr);
        this.savePosition(pos);
        this.recordBracket(pos, t);
      }
      return targets.map((p) => ({ ...p }));
    });
  }

  // ═════════════════════════════ commands: journal, settings, wallet ═════════════════════════════

  updateTrade(id: string, req: UpdateTradeRequest): Trade {
    return this.run(() => {
      const r = asObj(req, 'Request');
      let acc: Acct | null = null;
      let tr: Trade | null = null;
      for (const x of this.accounts.values()) {
        const live = x.trades.get(id);
        if (live) (acc = x), (tr = live);
      }
      tr ??= typeof id === 'string' ? this.store.getTrade(id) : null;
      if (!tr) fail('not_found', 'Trade not found');
      const tags = r.tags === undefined ? tr.tags : mergeTags(tr.tags, r.tags);
      const review = r.review === undefined ? tr.review : validateReview(r.review, this.now());
      tr.tags = tags;
      tr.review = review;
      this.saveTrade(acc, tr);
      return clone(tr);
    });
  }

  updateSettings(patch: unknown): Settings {
    return this.run(() => {
      const next = applySettingsPatch(this.settings, patch);
      this.writes++;
      this.store.saveSettings(next);
      if (next.monthlyBudget !== this.settings.monthlyBudget) this.walletDirty = true;
      this.settings = next;
      this.notify({ type: 'settings', settings: clone(next) });
      return clone(next);
    });
  }

  putNote(day: string, req: PutNoteRequest): DayNote {
    return this.run(() => {
      const d = dayKeyArg(day, 'Day');
      const r = asObj(req, 'Request');
      const text = str(r.text ?? '', 'Note', 20_000);
      const accountId = r.accountId == null ? null : str(r.accountId, 'accountId', 64);
      if (accountId && !this.accounts.has(accountId)) fail('not_found', 'Account not found');
      const note: DayNote = { day: d, accountId, text, mood: mood(r.mood, 'Mood'), updatedAt: this.now() };
      this.writes++;
      this.store.upsertNote(note);
      return note;
    });
  }

  putDrawing(id: string, req: PutDrawingRequest): Drawing {
    return this.run(() => {
      const existing = this.store.getDrawing(String(id));
      const d = parseDrawing(id, req, this.now(), existing);
      if (!existing && this.store.countDrawings(d.symbol) >= MAX_DRAWINGS_PER_SYMBOL) {
        fail('invalid', `${d.symbol} already has ${MAX_DRAWINGS_PER_SYMBOL} drawings — delete some first`);
      }
      this.writes++;
      this.store.upsertDrawing(d);
      return d;
    });
  }

  /** Idempotent: deleting a drawing that is already gone is fine. */
  deleteDrawing(id: string): OkResponse {
    return this.run(() => {
      this.writes++;
      this.store.deleteDrawing(String(id));
      return { ok: true };
    });
  }

  clearDrawings(symbol: string): { deleted: number } {
    return this.run(() => {
      this.writes++;
      return { deleted: this.store.deleteDrawings(symbol) };
    });
  }

  deposit(req: DepositRequest): WalletResponse {
    return this.run(() => {
      const r = asObj(req, 'Request');
      const amount = round2(num(r.amount, 'Amount', { min: 0, gt: true, max: 10_000_000 }));
      if (amount <= 0) fail('invalid', 'Amount must be at least $0.01');
      const note = optText(r.note, 'Note', 200);
      const bal = this.store.walletBalance();
      this.addWalletTx({ id: randomUUID(), ts: this.now(), kind: 'deposit', amount, accountId: null, note, balanceAfter: round2(bal + amount) });
      return this.wallet();
    });
  }
}

