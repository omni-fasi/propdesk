// HTTP + WebSocket contract between server and web client.
// All bodies are JSON. Errors respond with a non-2xx status and an ApiError body.
//
// REST (prefix /api)
//   GET    /bootstrap                          → BootstrapResponse
//   GET    /candles?symbol&tf&end&limit        → Candle[]   end = SECONDS (exclusive, default now), limit ≤ 1500 (default 500)
//   GET    /quotes                             → Quote[]
//   POST   /accounts                  CreateAccountRequest → Account
//   PATCH  /accounts/:id              UpdateAccountRequest → Account          (name / archived only)
//   POST   /accounts/:id/flatten                → OkResponse                  close all positions + cancel all orders
//   POST   /accounts/:id/break        BreakRequest → Account                  voluntary lock ("take a break")
//   POST   /accounts/:id/retry                  → Account                     new attempt of a failed evaluation (pays resetFee)
//   POST   /accounts/:id/activate               → Account                     funded account from a passed final phase (pays activationFee)
//   GET    /accounts/:id/payout-eligibility     → PayoutEligibility
//   POST   /accounts/:id/payouts      PayoutRequest → PayoutResponse
//   POST   /orders                    PlaceOrderRequest → Order               rejected orders return 400 with ApiError
//   PATCH  /orders/:id                ModifyOrderRequest → Order
//   DELETE /orders/:id                          → Order
//   POST   /positions/close           ClosePositionRequest → OkResponse
//   POST   /positions/reverse         ReversePositionRequest → OkResponse
//   PATCH  /positions/bracket         SetBracketRequest → Position
//   GET    /trades?accountId&from&to&symbol&status&limit&offset → Trade[]   (newest first)
//   PATCH  /trades/:id                UpdateTradeRequest → Trade              journal fields only
//   GET    /fills?accountId&from&to             → Fill[]                      (newest first)
//   GET    /daily?accountId&from&to             → DailyStat[]                 from/to = day keys inclusive
//   GET    /equity?accountId&from&to            → EquityPoint[]               (oldest first)
//   GET    /events?accountId&limit&before       → AccountEvent[]              (newest first)
//   GET    /notes?from&to                       → DayNote[]
//   PUT    /notes/:day                PutNoteRequest → DayNote
//   GET    /wallet                              → WalletResponse
//   POST   /wallet/deposit            DepositRequest → WalletResponse
//   GET    /settings                            → Settings
//   PUT    /settings                  Partial<Settings> → Settings
//   GET    /health                              → { ok: true, version: string, uptime: number }
//
// `accountId` query params accept an account id or 'all'. `from` / `to` are ms timestamps unless noted.
//
// WebSocket: GET /ws (JSON text frames). The server pushes state changes for ALL accounts;
// quotes only for the symbols the client subscribed to (plus symbols with open positions/orders).

import type {
  Account,
  AccountEvent,
  AccountRules,
  AccountSnapshot,
  Candle,
  ChallengePreset,
  DayNote,
  FeedStatus,
  Fill,
  InstrumentSpec,
  Mood,
  Order,
  OrderType,
  Position,
  Quote,
  Settings,
  Side,
  Trade,
  TradeReview,
  TradeTags,
  WalletSummary,
  WalletTx,
} from './types.ts';

// Query parameters (all optional unless noted). accountId: an account id or 'all' (default 'all').
export interface TradesQuery {
  accountId?: string;
  /** ms; matches trades closed (or opened, if still open) in [from, to]. */
  from?: number;
  to?: number;
  symbol?: string;
  /** default 'closed' */
  status?: 'open' | 'closed' | 'all';
  /** default 500, max 5000 */
  limit?: number;
  offset?: number;
}
export interface FillsQuery {
  accountId?: string;
  from?: number;
  to?: number;
  limit?: number;
}
export interface DailyQuery {
  accountId?: string;
  /** Day keys, inclusive (required). */
  from: string;
  to: string;
}
export interface EquityQuery {
  /** A single account id (required). */
  accountId: string;
  from?: number;
  to?: number;
}
export interface EventsQuery {
  accountId?: string;
  /** default 100 */
  limit?: number;
  /** ms, exclusive — for paging older events. */
  before?: number;
}
export interface NotesQuery {
  /** Day keys, inclusive. */
  from: string;
  to: string;
}

export interface ApiError {
  error: string;
  /** Machine-readable: 'insufficient_funds', 'market_closed', 'locked', 'rule_violation', 'invalid', 'not_found'... */
  code?: string;
}

export interface OkResponse {
  ok: true;
}

export interface BootstrapResponse {
  serverTime: number;
  version: string;
  /** Resolved machine time zone (what 'local' means). */
  localTz: string;
  settings: Settings;
  instruments: InstrumentSpec[];
  presets: ChallengePreset[];
  accounts: Account[];
  snapshots: AccountSnapshot[];
  positions: Position[];
  /** Working orders only. */
  orders: Order[];
  openTrades: Trade[];
  /** Most recent 100 events, newest first. */
  events: AccountEvent[];
  wallet: WalletSummary;
  feeds: FeedStatus[];
  quotes: Quote[];
}

export interface CreateAccountRequest {
  kind: 'practice' | 'evaluation';
  /** Evaluation from a preset. */
  presetId?: string;
  /** Custom evaluation (presetId omitted): full rules + the price you decide to "pay". */
  rules?: AccountRules;
  fee?: number;
  /** Practice account starting balance (default 50,000). */
  startingBalance?: number;
  name?: string;
}

export interface UpdateAccountRequest {
  name?: string;
  archived?: boolean;
}

export interface BreakRequest {
  minutes: number;
  message?: string;
}

export interface PlaceOrderRequest {
  accountId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  /** Limit price or stop trigger. Required for limit/stop. */
  price?: number | null;
  sl?: number | null;
  tp?: number | null;
  tags?: Partial<TradeTags> | null;
}

export interface ModifyOrderRequest {
  price?: number;
  qty?: number;
  /** undefined = unchanged, null = remove. */
  sl?: number | null;
  tp?: number | null;
}

export interface ClosePositionRequest {
  accountId: string;
  symbol: string;
  /** Partial close; omitted = close all. */
  qty?: number;
}

export interface ReversePositionRequest {
  accountId: string;
  symbol: string;
}

export interface SetBracketRequest {
  accountId: string;
  symbol: string;
  /** undefined = unchanged, null = remove. */
  sl?: number | null;
  tp?: number | null;
}

export interface UpdateTradeRequest {
  tags?: Partial<TradeTags>;
  review?: Omit<TradeReview, 'reviewedAt'> | null;
}

export interface PutNoteRequest {
  accountId?: string | null;
  text: string;
  mood?: Mood | null;
}

export interface DepositRequest {
  amount: number;
  note?: string;
}

export interface WalletResponse {
  summary: WalletSummary;
  /** Newest first. */
  transactions: WalletTx[];
}

export interface PayoutEligibility {
  eligible: boolean;
  maxAmount: number;
  minAmount: number;
  profitSplit: number;
  winningDays: number;
  requiredWinningDays: number;
  /** Why not eligible (empty when eligible). */
  reasons: string[];
}

export interface PayoutRequest {
  /** Gross amount withdrawn from the funded account; the wallet receives amount × profitSplit. */
  amount: number;
}

export interface PayoutResponse {
  account: Account;
  wallet: WalletSummary;
  received: number;
}

// ───────────────────────────── WebSocket ─────────────────────────────

export type ClientMessage =
  /** Replace the client's quote subscription set. */
  | { type: 'subscribe'; symbols: string[] }
  /** Live 1m candle updates for the chart symbol (null = none). */
  | { type: 'chart'; symbol: string | null }
  | { type: 'ping'; t: number };

export type ServerMessage =
  | { type: 'hello'; serverTime: number; version: string }
  /** Batched, throttled (≤ ~8 batches/s). */
  | { type: 'quotes'; quotes: Quote[] }
  /** Live 1m candle for the client's chart symbol (same bar repeats while it is forming). */
  | { type: 'candle'; symbol: string; candle: Candle }
  /** Throttled (≤ ~4/s per account) + immediately after fills / status changes. */
  | { type: 'snapshot'; snapshot: AccountSnapshot }
  | { type: 'account'; account: Account }
  | { type: 'order'; order: Order }
  | { type: 'position'; position: Position }
  | { type: 'position_closed'; accountId: string; symbol: string }
  | { type: 'fill'; fill: Fill }
  | { type: 'trade'; trade: Trade }
  | { type: 'event'; event: AccountEvent }
  | { type: 'wallet'; wallet: WalletSummary }
  | { type: 'settings'; settings: Settings }
  | { type: 'feeds'; feeds: FeedStatus[] }
  | { type: 'pong'; t: number; serverTime: number };
