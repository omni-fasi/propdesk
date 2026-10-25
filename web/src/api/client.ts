// Typed REST client for /api (see shared/api.ts for the contract).

import type {
  ApiError,
  BootstrapResponse,
  BreakRequest,
  ClosePositionRequest,
  CreateAccountRequest,
  DailyQuery,
  DepositRequest,
  EquityQuery,
  EventsQuery,
  FillsQuery,
  ModifyOrderRequest,
  NotesQuery,
  OkResponse,
  PayoutEligibility,
  PayoutRequest,
  PayoutResponse,
  PlaceOrderRequest,
  PutDrawingRequest,
  PutNoteRequest,
  ReversePositionRequest,
  SetBracketRequest,
  TradeReplay,
  TradesQuery,
  UpdateAccountRequest,
  UpdateTradeRequest,
  WalletResponse,
} from '@shared/api';
import type {
  Account,
  AccountEvent,
  Candle,
  DailyStat,
  DayNote,
  BookRow,
  Drawing,
  EquityPoint,
  Fill,
  Order,
  Position,
  Quote,
  Settings,
  Timeframe,
  Trade,
} from '@shared/types';

/** Thrown for any non-2xx response. `code` mirrors ApiError.code ('market_closed', 'locked', …). */
export class ApiRequestError extends Error {
  status: number;
  code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

type QueryValue = string | number | boolean | null | undefined;

function queryString(q?: object): string {
  if (!q) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q as Record<string, QueryValue>)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

async function request<T>(method: string, path: string, body?: unknown, query?: object): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}${queryString(query)}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiRequestError('Cannot reach the PropDesk server', 0, 'network');
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = data as Partial<ApiError> | null;
    throw new ApiRequestError(err?.error ?? `Request failed (${res.status})`, res.status, err?.code);
  }
  return data as T;
}

/** Message suitable for a toast. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export const api = {
  bootstrap: () => request<BootstrapResponse>('GET', '/bootstrap'),
  /** `end` is in SECONDS (exclusive). */
  candles: (symbol: string, tf: Timeframe, opts: { end?: number; limit?: number } = {}) =>
    request<Candle[]>('GET', '/candles', undefined, { symbol, tf, end: opts.end, limit: opts.limit }),
  quotes: () => request<Quote[]>('GET', '/quotes'),

  createAccount: (body: CreateAccountRequest) => request<Account>('POST', '/accounts', body),
  updateAccount: (id: string, body: UpdateAccountRequest) => request<Account>('PATCH', `/accounts/${id}`, body),
  flattenAccount: (id: string) => request<OkResponse>('POST', `/accounts/${id}/flatten`, {}),
  takeBreak: (id: string, body: BreakRequest) => request<Account>('POST', `/accounts/${id}/break`, body),
  retryAccount: (id: string) => request<Account>('POST', `/accounts/${id}/retry`, {}),
  activateFunded: (id: string) => request<Account>('POST', `/accounts/${id}/activate`, {}),
  payoutEligibility: (id: string) => request<PayoutEligibility>('GET', `/accounts/${id}/payout-eligibility`),
  requestPayout: (id: string, body: PayoutRequest) => request<PayoutResponse>('POST', `/accounts/${id}/payouts`, body),

  placeOrder: (body: PlaceOrderRequest) => request<Order>('POST', '/orders', body),
  modifyOrder: (id: string, body: ModifyOrderRequest) => request<Order>('PATCH', `/orders/${id}`, body),
  cancelOrder: (id: string) => request<Order>('DELETE', `/orders/${id}`),
  closePosition: (body: ClosePositionRequest) => request<OkResponse>('POST', '/positions/close', body),
  reversePosition: (body: ReversePositionRequest) => request<OkResponse>('POST', '/positions/reverse', body),
  setBracket: (body: SetBracketRequest) => request<Position[]>('PATCH', '/positions/bracket', body),

  trades: (q: TradesQuery = {}) => request<Trade[]>('GET', '/trades', undefined, q),
  updateTrade: (id: string, body: UpdateTradeRequest) => request<Trade>('PATCH', `/trades/${id}`, body),
  tradeReplay: (id: string) => request<TradeReplay>('GET', `/trades/${id}/replay`),
  fills: (q: FillsQuery = {}) => request<Fill[]>('GET', '/fills', undefined, q),
  daily: (q: DailyQuery) => request<DailyStat[]>('GET', '/daily', undefined, q),
  equity: (q: EquityQuery) => request<EquityPoint[]>('GET', '/equity', undefined, q),
  events: (q: EventsQuery = {}) => request<AccountEvent[]>('GET', '/events', undefined, q),
  notes: (q: NotesQuery) => request<DayNote[]>('GET', '/notes', undefined, q),
  putNote: (day: string, body: PutNoteRequest) => request<DayNote>('PUT', `/notes/${day}`, body),
  drawings: (symbol: string) => request<Drawing[]>('GET', '/drawings', undefined, { symbol }),
  /** Order book heatmap minutes; from / to in SECONDS. */
  book: (symbol: string, from: number, to: number) => request<BookRow[]>('GET', '/book', undefined, { symbol, from, to }),
  putDrawing: (id: string, body: PutDrawingRequest) => request<Drawing>('PUT', `/drawings/${encodeURIComponent(id)}`, body),
  deleteDrawing: (id: string) => request<OkResponse>('DELETE', `/drawings/${encodeURIComponent(id)}`),
  clearDrawings: (symbol: string) => request<{ deleted: number }>('DELETE', '/drawings', undefined, { symbol }),

  wallet: () => request<WalletResponse>('GET', '/wallet'),
  deposit: (body: DepositRequest) => request<WalletResponse>('POST', '/wallet/deposit', body),
  settings: () => request<Settings>('GET', '/settings'),
  updateSettings: (patch: Partial<Settings>) => request<Settings>('PUT', '/settings', patch),
};
