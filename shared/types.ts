// Core domain model shared by the server and the web client.
//
// Conventions
// - Timestamps are milliseconds since epoch (UTC), except Candle.time which is SECONDS (lightweight-charts).
// - Money is USD, rounded to cents whenever it is written to an account (balance, fees, realized P&L).
// - Prices are rounded to the instrument tick size when an order is accepted or filled.
// - Quantities are always positive; direction lives in `side` (orders/fills) or the sign of Position.qty.
// - A "trading day" is a key 'YYYY-MM-DD' computed with the account's Rollover (see shared/time.ts).

// ───────────────────────────── Instruments & market data ─────────────────────────────

export type AssetClass = 'futures' | 'crypto' | 'metals' | 'energy' | 'stocks' | 'forex';
export type FeedProvider = 'binance' | 'yahoo';
/** cme: Sun 18:00 → Fri 17:00 ET with a daily 17:00–18:00 ET break. fx: Sun 17:00 → Fri 17:00 ET. */
export type SessionKind = 'cme' | 'fx' | '24x7';
/** bidask: the feed has a real top of book. last: only trade prices; bid/ask are synthesized. */
export type QuoteModel = 'bidask' | 'last';
export type QtyUnit = 'contracts' | 'units' | 'lots' | 'shares';

export type CommissionModel =
  /** $ per 1 qty (contract or lot) per side. */
  | { kind: 'per_contract'; perSide: number }
  /** Fraction of notional per side, e.g. 0.0005 = 0.05%. Limit fills pay maker, everything else taker. */
  | { kind: 'percent'; maker: number; taker: number };

export interface InstrumentSpec {
  /** App symbol, unique across the catalog: 'MNQ', 'BTCUSD', 'EURUSD'. */
  symbol: string;
  name: string;
  assetClass: AssetClass;
  /** Watchlist group label. */
  group: string;
  provider: FeedProvider;
  /** Symbol at the provider ('NQ=F', 'BTCUSDT'). Several app symbols may share one feed (NQ and MNQ). */
  feedSymbol: string;
  /**
   * Real-time stand-in for a delayed feed: the price moves with this Binance perpetual (provider symbol),
   * scaled to the feed's own price and re-anchored to it every minute (CME futures via Yahoo are ~10 min late).
   */
  liveProxy?: { feed: string; label: string };
  session: SessionKind;
  quoteModel: QuoteModel;
  /** For quoteModel 'last': synthesized spread in ticks (futures use the tick rule, see SPEC.md). */
  syntheticSpreadTicks: number;
  tickSize: number;
  /** USD P&L per 1.0 price move per 1 qty. MNQ = 2, NQ = 20, BTCUSD = 1, EURUSD (lots) = 100000. */
  multiplier: number;
  qtyStep: number;
  minQty: number;
  qtyUnit: QtyUnit;
  /** Display label for quantities: 'contracts', 'BTC', 'lots', 'shares', 'oz', 'bbl'. */
  unitLabel: string;
  pricePrecision: number;
  qtyPrecision: number;
  commission: CommissionModel;
  /** Futures only: how much one contract counts toward maxContracts (mini = 1, micro = 0.1). */
  miniEquivalent: number | null;
  defaultQty: number;
  description: string;
}

export interface Quote {
  /** App symbol. */
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  /** Time of the price (already shifted to "now" for delayed feeds). */
  ts: number;
  /** Change vs previous session close / 24h ago, as a fraction (0.012 = +1.2%). */
  changePct: number | null;
}

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

export interface Candle {
  /** Bar open time in SECONDS since epoch (UTC). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FeedStatus {
  provider: FeedProvider;
  state: 'connecting' | 'live' | 'degraded' | 'down';
  /** Detected data delay in seconds that is being compensated by time-shifting (0 = real time). */
  delaySec: number;
  lastMessageAt: number | null;
  message: string | null;
}

export interface SessionState {
  open: boolean;
  /** Next time the open/closed state flips, or null for 24x7. */
  nextChange: number | null;
  /** 'Open', 'Closed', 'Daily break', 'Weekend'. */
  label: string;
}

// ───────────────────────────── Rules, presets, accounts ─────────────────────────────

export type DrawdownMode = 'static' | 'trailing_intraday' | 'trailing_eod';

export interface MaxLossRule {
  /** Distance in $ between the reference (start / high-water mark) and the failure threshold. */
  amount: number;
  /**
   * static:            threshold = startingBalance - amount (never moves).
   * trailing_intraday: threshold = peak equity (incl. unrealized, tick by tick) - amount.
   * trailing_eod:      threshold = highest end-of-day balance - amount, updated at rollover.
   */
  mode: DrawdownMode;
  /** Trailing modes: the threshold stops trailing once it reaches this balance (usually startingBalance). */
  lockAt: number | null;
}

export interface DailyLossRule {
  /** Max loss in $ within one trading day, measured from the day's starting balance against equity. */
  amount: number;
  /** fail: account is failed. lock: positions are liquidated and trading is locked until the next trading day. */
  action: 'fail' | 'lock';
}

/** Wall-clock time in a time zone. tz is an IANA zone or 'local' (resolved to the machine zone at account creation). */
export interface ZonedTime {
  hour: number;
  minute: number;
  tz: string;
}

export type FeesMode = 'real' | 'off';

export interface AccountRules {
  startingBalance: number;
  profitTarget: number | null;
  maxLoss: MaxLossRule | null;
  dailyLoss: DailyLossRule | null;
  minTradingDays: number;
  /** Fails the evaluation when it is not passed within this many calendar days. */
  maxCalendarDays: number | null;
  /** To pass, the best single day may be at most this fraction of total profit (0.5 = 50%). */
  consistencyPct: number | null;
  /** Futures position limit, in mini-equivalent contracts, summed across all open futures positions. */
  maxContracts: number | null;
  /** Leverage per asset class for margin (notional / leverage). Missing class = 1:1. null = no margin check. */
  leverage: Partial<Record<AssetClass, number>> | null;
  /** Commissions on fills: 'real' (each instrument's schedule; also when missing) or 'off' (practice accounts only). */
  fees?: FeesMode;
  /** null = every asset class allowed. */
  allowedClasses: AssetClass[] | null;
  /** Mon–Fri auto-flatten of futures positions (and cancel of futures orders) at this time. */
  flatBy: ZonedTime | null;
  /** Flatten everything on Friday (at flatBy, or 16:55 ET when flatBy is null). */
  noWeekendHolding: boolean;
  /** Trading-day boundary. Daily loss resets, EOD trailing updates and the calendar all use it. */
  rollover: ZonedTime;
}

export interface PayoutPolicy {
  /** Trader share of each payout (0.9 = 90%). */
  profitSplit: number;
  /** Winning days (net P&L ≥ minDayProfit) required since the last payout (or since activation). */
  minWinningDays: number;
  minDayProfit: number;
  /** Max fraction of current profit (balance - startingBalance) that can be withdrawn at once. */
  maxPctOfProfit: number;
  minAmount: number;
}

export interface PresetPhase {
  name: string;
  profitTarget: number;
  minTradingDays: number;
  maxCalendarDays: number | null;
}

export interface ChallengePreset {
  id: string;
  name: string;
  tagline: string;
  style: 'futures' | 'cfd' | 'crypto';
  /** Price of the evaluation, paid from the wallet. */
  fee: number;
  /** Price to buy a fresh attempt after failing (cheaper than a new purchase). null = no discount. */
  resetFee: number | null;
  /** Price to activate the funded account after passing the final phase. */
  activationFee: number;
  /** Base evaluation rules; each phase overrides profitTarget / minTradingDays / maxCalendarDays. */
  rules: AccountRules;
  phases: PresetPhase[];
  funded: { rules: AccountRules; payout: PayoutPolicy } | null;
  highlights: string[];
}

export type AccountKind = 'practice' | 'evaluation' | 'funded';
export type AccountStatus = 'active' | 'passed' | 'failed' | 'closed';
export type LockReason = 'daily_loss' | 'tilt_cooldown' | 'max_trades' | 'personal_loss_limit' | 'break';

export interface AccountLock {
  reason: LockReason;
  since: number;
  /** null = until the next trading day (rollover). */
  until: number | null;
  message: string;
}

/** The calendar flag a lock leaves on its trading day. */
export const LOCK_FLAGS: Record<LockReason, DailyStat['flags'][number]> = {
  daily_loss: 'daily_loss',
  tilt_cooldown: 'tilt',
  max_trades: 'locked',
  personal_loss_limit: 'locked',
  break: 'break',
};

export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  status: AccountStatus;
  presetId: string | null;
  /** 1-based phase for evaluations, 0 for practice/funded. */
  phase: number;
  phaseCount: number;
  rules: AccountRules;
  payout: PayoutPolicy | null;
  /** What was paid from the wallet to open this account. */
  fee: number;
  createdAt: number;
  endedAt: number | null;
  endReason: string | null;
  /** Previous phase / evaluation this account was created from. */
  parentId: string | null;
  /** Realized balance (after fees and payouts). */
  balance: number;
  /** Trailing reference: peak equity (intraday mode) or peak EOD balance (EOD mode). */
  highWaterMark: number;
  /** Current max-loss failure level for equity; null when there is no max-loss rule. */
  maxLossThreshold: number | null;
  dayStartBalance: number;
  /** Current trading day key. */
  tradingDay: string;
  /** Number of distinct trading days with at least one fill. */
  tradingDays: number;
  lock: AccountLock | null;
  archived: boolean;
  totalPayouts: number;
  lastPayoutAt: number | null;
}

/** Live metrics for one account. Pushed over WS (throttled) and included in bootstrap. */
export interface AccountSnapshot {
  accountId: string;
  ts: number;
  status: AccountStatus;
  balance: number;
  equity: number;
  openPnl: number;
  /** Net realized P&L of the current trading day (after fees). */
  dayRealized: number;
  /** dayRealized + openPnl. */
  dayPnl: number;
  tradingDay: string;
  maxLossThreshold: number | null;
  /** equity - maxLossThreshold. */
  maxLossBuffer: number | null;
  dailyLossThreshold: number | null;
  dailyLossBuffer: number | null;
  /** balance - startingBalance. */
  profit: number;
  /** profit / profitTarget, null without a target. */
  targetProgress: number | null;
  tradingDays: number;
  bestDay: number;
  /** null when there is no consistency rule. */
  consistencyOk: boolean | null;
  /** Σ |notional| of open positions. */
  exposure: number;
  /** Σ mini-equivalent futures contracts. */
  contracts: number;
  marginUsed: number;
  dayTrades: number;
  consecutiveLosses: number;
  lock: AccountLock | null;
  /** Human-readable reasons the account has not passed yet although the target may be reached. */
  passBlockers: string[];
}

// ───────────────────────────── Orders, positions, fills, trades ─────────────────────────────

export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop';
export type OrderStatus = 'working' | 'filled' | 'cancelled' | 'rejected';
/** Why an order exists. Bracket legs are not separate orders: SL/TP live on the Position. */
export type OrderRole = 'entry' | 'exit' | 'stop_loss' | 'take_profit' | 'liquidation';

export interface Order {
  id: string;
  accountId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  /** Limit price (limit) or trigger price (stop); null for market. */
  price: number | null;
  status: OrderStatus;
  role: OrderRole;
  reduceOnly: boolean;
  /** Bracket to apply to the resulting position when this order fills. */
  sl: number | null;
  tp: number | null;
  tags: TradeTags | null;
  createdAt: number;
  updatedAt: number;
  filledAt: number | null;
  fillPrice: number | null;
  rejectReason: string | null;
}

/**
 * One open position = one open trade (`tradeId` is its id). An account can hold several positions in a
 * symbol, always on the same side: every entry opens its own, with its own stop-loss / take-profit, and
 * orders the other way close them oldest first (the rest opens a new position on the other side).
 */
export interface Position {
  accountId: string;
  symbol: string;
  /** Signed: > 0 long, < 0 short. Never 0 (flat positions are removed). */
  qty: number;
  avgPrice: number;
  openedAt: number;
  /** Stop-loss price of this position (stop-market), or null. */
  sl: number | null;
  /** Take-profit price of this position (limit), or null. */
  tp: number | null;
  /** Id of the position's trade — also the position's id. */
  tradeId: string;
  /** Mark used for openPnl: bid for longs, ask for shorts. */
  markPrice: number;
  openPnl: number;
}

export interface Fill {
  id: string;
  orderId: string | null;
  accountId: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  fee: number;
  /** Gross realized P&L produced by this fill (0 for opening fills). */
  realizedPnl: number;
  liquidity: 'maker' | 'taker';
  role: OrderRole;
  ts: number;
  tradingDay: string;
  tradeId: string;
}

/** A price sample for trade replays: [time ms, bid, ask] (bid = ask when rebuilt from exchange prints or bars). */
export type TickSample = [t: number, bid: number, ask: number];

// ───────────────────────────── Order book (liquidity heatmap) ─────────────────────────────

/** Resting size in one price bucket: [index, qty]; the bucket covers [index × step, (index + 1) × step). */
export type BookLevel = [index: number, qty: number];

/** A symbol's live order book (Binance markets only), bucketed within a range around the mid price. */
export interface BookFrame {
  symbol: string;
  /** ms */
  ts: number;
  step: number;
  mid: number;
  /** Buy orders waiting (index ascending). */
  bids: BookLevel[];
  /** Sell orders waiting (index ascending). */
  asks: BookLevel[];
}

/** One minute of the heatmap: the average size resting in each bucket during that minute. */
export interface BookRow {
  /** Minute start, unix seconds. */
  t: number;
  step: number;
  bids: BookLevel[];
  asks: BookLevel[];
}

/** A position's stop-loss / take-profit from `ts` on (null = none). */
export interface BracketChange {
  ts: number;
  sl: number | null;
  tp: number | null;
}

export type ExitReason =
  | 'manual'
  | 'stop_loss'
  | 'take_profit'
  | 'limit'
  | 'reversal'
  | 'breach'
  | 'daily_loss'
  | 'auto_flatten'
  | 'passed';

/** One position from open to close (partial closes included). An order that flips the side closes the old positions' trades and opens a new one. */
export interface Trade {
  id: string;
  accountId: string;
  symbol: string;
  direction: 'long' | 'short';
  status: 'open' | 'closed';
  openedAt: number;
  closedAt: number | null;
  /** Largest absolute position size during the trade. */
  maxQty: number;
  /** Total qty entered / exited (for averages). */
  entryQty: number;
  exitQty: number;
  avgEntry: number;
  avgExit: number | null;
  grossPnl: number;
  fees: number;
  netPnl: number;
  /** Stop-loss in place when the position was opened (for R multiples). */
  initialStop: number | null;
  /** $ risk at entry based on initialStop, or null. */
  riskAmount: number | null;
  rMultiple: number | null;
  /** Worst / best open P&L in $ seen during the trade (mae ≤ 0 ≤ mfe). */
  mae: number;
  mfe: number;
  exitReason: ExitReason | null;
  /** Trading day of the close (or of the open while still open). */
  tradingDay: string;
  tags: TradeTags;
  review: TradeReview | null;
}

// ───────────────────────────── Journal ─────────────────────────────

export type Mood =
  | 'calm'
  | 'focused'
  | 'confident'
  | 'excited'
  | 'anxious'
  | 'fearful'
  | 'fomo'
  | 'frustrated'
  | 'revenge'
  | 'bored'
  | 'tired';

export interface TradeTags {
  mood: Mood | null;
  /** Setup quality: one of SETUP_GRADES (shared/journal.ts) or free text. */
  setup: string | null;
  /** 1–5 */
  confidence: number | null;
  /** Short plan / thesis written before entry. */
  plan: string | null;
}

export interface TradeReview {
  followedPlan: boolean | null;
  /** 1–5 execution rating. */
  rating: number | null;
  /** From MISTAKES (shared/journal.ts). */
  mistakes: string[];
  /** How it felt after the trade. */
  moodAfter: Mood | null;
  note: string | null;
  reviewedAt: number;
}

export interface DayNote {
  day: string;
  /** null = global note for the day (all accounts). */
  accountId: string | null;
  text: string;
  mood: Mood | null;
  updatedAt: number;
}

export interface DailyStat {
  accountId: string;
  day: string;
  startBalance: number;
  endBalance: number;
  /** Gross realized P&L of fills that day. */
  grossPnl: number;
  fees: number;
  /** grossPnl - fees. The calendar shows this. */
  netPnl: number;
  /** Closed trades that day. */
  trades: number;
  wins: number;
  losses: number;
  fills: number;
  highEquity: number;
  lowEquity: number;
  /** Something notable happened (breach, lock, break, pass...). */
  flags: Array<'breach' | 'daily_loss' | 'locked' | 'break' | 'passed' | 'payout' | 'tilt'>;
}

export interface EquityPoint {
  ts: number;
  balance: number;
  equity: number;
}

// ───────────────────────────── Chart drawings ─────────────────────────────

/** trendline: two points · hline: a price across the chart · hray: from a point to the right · rect: a box
 *  · long / short: position tool (entry with stop-loss and take-profit zones). */
export type DrawingKind = 'trendline' | 'hline' | 'hray' | 'rect' | 'long' | 'short';
export const DRAWING_KINDS: readonly DrawingKind[] = ['trendline', 'hline', 'hray', 'rect', 'long', 'short'];

export interface DrawingPoint {
  /** Unix seconds. */
  time: number;
  price: number;
}

/** A drawing on a symbol's chart, shown on every timeframe. */
export interface Drawing {
  id: string;
  symbol: string;
  kind: DrawingKind;
  /** trendline / rect: 2 · hline / hray: 1 · long / short: the entry, then the right edge (same price). */
  points: DrawingPoint[];
  /** long / short: take-profit and stop-loss prices (null for the other kinds). */
  tp: number | null;
  sl: number | null;
  createdAt: number;
  updatedAt: number;
}

// ───────────────────────────── Events, wallet, settings ─────────────────────────────

export type EventKind =
  | 'account_created'
  | 'warning'
  | 'breach'
  | 'phase_passed'
  | 'passed'
  | 'funded'
  | 'locked'
  | 'unlocked'
  | 'auto_flatten'
  | 'stop_hit'
  | 'target_hit'
  | 'order_rejected'
  | 'payout'
  | 'catch_up'
  | 'day_rollover'
  | 'info';

export interface AccountEvent {
  id: string;
  accountId: string | null;
  ts: number;
  kind: EventKind;
  severity: 'info' | 'success' | 'warning' | 'danger';
  title: string;
  message: string;
  data: Record<string, unknown> | null;
}

export type WalletTxKind =
  | 'deposit'
  | 'withdrawal'
  | 'challenge_fee'
  | 'reset_fee'
  | 'activation_fee'
  | 'payout';

export interface WalletTx {
  id: string;
  ts: number;
  kind: WalletTxKind;
  /** Signed: fees negative, deposits/payouts positive. */
  amount: number;
  accountId: string | null;
  note: string | null;
  balanceAfter: number;
}

export interface WalletSummary {
  balance: number;
  deposited: number;
  withdrawn: number;
  /** Σ challenge, reset and activation fees (positive number). */
  feesPaid: number;
  /** Σ payouts received (trader share). */
  payouts: number;
  /** payouts - feesPaid: the real scoreboard. */
  net: number;
  /** Fees paid in the current calendar month (local time). */
  monthSpent: number;
  monthBudget: number | null;
}

export interface TiltSettings {
  enabled: boolean;
  /** Lock for cooldownMinutes after this many losing trades in a row (per account, per day). 0 = off. */
  maxConsecutiveLosses: number;
  cooldownMinutes: number;
  /** Lock until the next trading day after this many closed trades. null = off. */
  maxTradesPerDay: number | null;
  /** Personal daily stop in $ (tighter than the challenge rule). Lock until next trading day. null = off. */
  personalDailyLoss: number | null;
}

/** TradingView's execution sounds (Settings → Trading → Execution sound), in its menu order — also its classic alert sounds. */
export const TV_SOUNDS = ['fired', '3_notes_reverb', 'alarm_clock', 'beep_beep', 'calling', 'chirpy', 'fault', 'hand_bell'] as const;
export type TvSound = (typeof TV_SOUNDS)[number];
/** What a fill plays: the "Order filled" voice clip or one of TradingView's execution sounds. */
export const FILL_SOUNDS = ['order_filled', ...TV_SOUNDS] as const;
export type FillSound = (typeof FILL_SOUNDS)[number];

export interface Settings {
  onboarded: boolean;
  traderName: string | null;
  /** Used to show money as hours of work ("≈ 6.5 h of work"). */
  hourlyWage: number | null;
  showWorkHours: boolean;
  sounds: boolean;
  /** Played on every fill (entry, exit, stop, target), like TradingView's execution sound. */
  fillSound: FillSound;
  /** TradingView alert sound for account alerts (risk warnings, breach, locks, pass, payout); null = silent. */
  alertSound: TvSound | null;
  /** 0..1 */
  volume: number;
  /** Desktop notifications for fills / stops / breaches while the window is hidden. */
  notifications: boolean;
  /** always: confirm every order. risky: only orders without SL or risking ≥ riskyPct of the max-loss buffer. */
  confirmOrders: 'always' | 'risky' | 'never';
  riskyPct: number;
  /** Reject entry orders that have no stop-loss. Enforced by the server. */
  requireStopLoss: boolean;
  emotionCheckin: 'required' | 'optional' | 'off';
  postTradeReview: boolean;
  tilt: TiltSettings;
  /** Warn before an entry placed within 2 minutes of a losing trade with a larger size. */
  revengeGuard: boolean;
  monthlyBudget: number | null;
  watchlist: string[];
  activeAccountId: string | null;
  chartTimeframe: Timeframe;
  lastSymbol: string;
}
