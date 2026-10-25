// REST API (mounted at /api) — implements exactly the endpoint list at the top of shared/api.ts.

import { Hono, type Context } from 'hono';
import type { BreakRequest, ClosePositionRequest, CreateAccountRequest, DepositRequest, ModifyOrderRequest, OkResponse, PayoutRequest, PlaceOrderRequest, PutDrawingRequest, PutNoteRequest, ReversePositionRequest, SetBracketRequest, UpdateAccountRequest, UpdateTradeRequest } from '../../../shared/api.ts';
import type { Timeframe } from '../../../shared/types.ts';
import { TIMEFRAMES } from '../../../shared/types.ts';
import { getInstrument } from '../../../shared/instruments.ts';
import type { Engine } from '../engine/engine.ts';
import { EngineError, fail } from '../engine/errors.ts';
import type { DepthSource, Logger, MarketHub } from '../market/types.ts';
import { buildReplay } from '../replay/build.ts';
import { VERSION } from '../version.ts';
import { accountParam, dayParam, enumParam, intParam, jsonBody, msParam } from './params.ts';

export interface ApiDeps {
  engine: Engine;
  market: MarketHub;
  /** Order books for the liquidity heatmap (null: not available). */
  depth?: DepthSource | null;
  log: Logger;
  /** Process start (wall clock) for /health uptime. */
  startedAt: number;
}

/** JSON error response: {error, code} with the status of the EngineError (500 for anything else). */
export function errorResponse(c: Context, err: unknown, log: Logger): Response {
  if (err instanceof EngineError) return c.json({ error: err.message, code: err.code }, err.status);
  log.error('api: %s %s failed: %s', c.req.method, c.req.path, err instanceof Error ? (err.stack ?? err.message) : String(err));
  return c.json({ error: 'Internal server error', code: 'internal' }, 500);
}

const OK: OkResponse = { ok: true };

export function createApi({ engine, market, depth = null, log, startedAt }: ApiDeps): Hono {
  const api = new Hono();
  const body = <T>(c: Context) => jsonBody(c) as Promise<T>;

  api.onError((err, c) => errorResponse(c, err, log));
  api.notFound((c) => c.json({ error: `No such endpoint: ${c.req.method} ${c.req.path}`, code: 'not_found' }, 404));

  // ── system & market data
  api.get('/health', (c) => c.json({ ok: true as const, version: VERSION, uptime: Math.round((Date.now() - startedAt) / 1000) }));
  api.get('/bootstrap', (c) => c.json(engine.bootstrap()));
  api.get('/quotes', (c) => c.json(market.getQuotes()));
  api.get('/candles', async (c) => {
    const symbol = c.req.query('symbol') ?? '';
    if (!getInstrument(symbol)) fail('invalid', `Unknown symbol ${symbol}`);
    const tf = enumParam<Timeframe>(c, 'tf', TIMEFRAMES, '1m');
    const end = c.req.query('end');
    let endSec = end == null || end === '' ? undefined : Number(end);
    if (endSec !== undefined && !(Number.isFinite(endSec) && endSec > 0)) fail('invalid', 'end must be a time in seconds');
    if (endSec !== undefined && endSec > engine.now() / 1000) endSec = undefined; // a future end means "up to now"
    const limit = intParam(c, 'limit', 500, 1, 1500);
    try {
      return c.json(await market.getCandles(symbol, tf, { endSec, limit }));
    } catch (err) {
      log.warn('api: candles %s %s failed: %s', symbol, tf, err instanceof Error ? err.message : String(err));
      fail('internal', `Candles for ${symbol} are unavailable right now`);
    }
  });

  api.get('/book', (c) => {
    const symbol = c.req.query('symbol') ?? '';
    if (!getInstrument(symbol)) fail('invalid', `Unknown symbol ${symbol}`);
    const now = Math.floor(engine.now() / 1000);
    const sec = (name: string, def: number) => {
      const v = c.req.query(name);
      if (v == null || v === '') return def;
      const n = Number(v);
      if (!Number.isFinite(n)) fail('invalid', `${name} must be a time in seconds`);
      return n;
    };
    return c.json(depth?.supports(symbol) ? depth.rows(symbol, sec('from', now - 6 * 3600), sec('to', now)) : []);
  });

  // ── accounts
  api.post('/accounts', async (c) => c.json(engine.createAccount(await body<CreateAccountRequest>(c))));
  api.patch('/accounts/:id', async (c) => c.json(engine.updateAccount(c.req.param('id'), await body<UpdateAccountRequest>(c))));
  api.post('/accounts/:id/flatten', (c) => {
    engine.flattenAccount(c.req.param('id'));
    return c.json(OK);
  });
  api.post('/accounts/:id/break', async (c) => c.json(engine.takeBreak(c.req.param('id'), await body<BreakRequest>(c))));
  api.post('/accounts/:id/retry', (c) => c.json(engine.retryAccount(c.req.param('id'))));
  api.post('/accounts/:id/activate', (c) => c.json(engine.activateFunded(c.req.param('id'))));
  api.get('/accounts/:id/payout-eligibility', (c) => c.json(engine.payoutEligibility(c.req.param('id'))));
  api.post('/accounts/:id/payouts', async (c) => c.json(engine.requestPayout(c.req.param('id'), await body<PayoutRequest>(c))));

  // ── orders & positions
  api.post('/orders', async (c) => c.json(engine.placeOrder(await body<PlaceOrderRequest>(c))));
  api.patch('/orders/:id', async (c) => c.json(engine.modifyOrder(c.req.param('id'), await body<ModifyOrderRequest>(c))));
  api.delete('/orders/:id', (c) => c.json(engine.cancelOrder(c.req.param('id'))));
  api.post('/positions/close', async (c) => {
    engine.closePosition(await body<ClosePositionRequest>(c));
    return c.json(OK);
  });
  api.post('/positions/reverse', async (c) => {
    engine.reversePosition(await body<ReversePositionRequest>(c));
    return c.json(OK);
  });
  api.patch('/positions/bracket', async (c) => c.json(engine.setBracket(await body<SetBracketRequest>(c))));

  // ── journal & history
  api.get('/trades', (c) =>
    c.json(
      engine.listTrades({
        accountId: accountParam(c),
        from: msParam(c, 'from'),
        to: msParam(c, 'to'),
        symbol: c.req.query('symbol') || null,
        status: enumParam(c, 'status', ['open', 'closed', 'all'] as const, 'closed'),
        limit: intParam(c, 'limit', 500, 1, 5000),
        offset: intParam(c, 'offset', 0, 0, 10_000_000),
      }),
    ),
  );
  api.get('/trades/:id', (c) => c.json(engine.getTrade(c.req.param('id'))));
  api.patch('/trades/:id', async (c) => c.json(engine.updateTrade(c.req.param('id'), await body<UpdateTradeRequest>(c))));
  api.get('/trades/:id/replay', async (c) => c.json(await buildReplay({ engine, market, log }, c.req.param('id'))));
  api.get('/fills', (c) =>
    c.json(engine.listFills({ accountId: accountParam(c), from: msParam(c, 'from'), to: msParam(c, 'to'), limit: intParam(c, 'limit', 1000, 1, 10_000) })),
  );
  api.get('/daily', (c) => c.json(engine.listDaily({ accountId: accountParam(c), from: dayParam(c, 'from'), to: dayParam(c, 'to') })));
  api.get('/equity', (c) => {
    const accountId = accountParam(c);
    if (!accountId) fail('invalid', 'accountId is required (a single account)');
    if (!engine.getAccount(accountId)) fail('not_found', 'Account not found');
    return c.json(engine.listEquity(accountId, msParam(c, 'from'), msParam(c, 'to')));
  });
  api.get('/events', (c) =>
    c.json(engine.listEvents({ accountId: accountParam(c), limit: intParam(c, 'limit', 100, 1, 1000), from: msParam(c, 'from'), before: msParam(c, 'before') })),
  );
  // ── chart drawings
  api.get('/drawings', (c) => c.json(engine.listDrawings(c.req.query('symbol') ?? '')));
  api.put('/drawings/:id', async (c) => c.json(engine.putDrawing(c.req.param('id'), await body<PutDrawingRequest>(c))));
  api.delete('/drawings/:id', (c) => c.json(engine.deleteDrawing(c.req.param('id'))));
  api.delete('/drawings', (c) => c.json(engine.clearDrawings(c.req.query('symbol') ?? '')));

  api.get('/notes', (c) => c.json(engine.listNotes(dayParam(c, 'from'), dayParam(c, 'to'))));
  api.put('/notes/:day', async (c) => c.json(engine.putNote(c.req.param('day'), await body<PutNoteRequest>(c))));

  // ── wallet & settings
  api.get('/wallet', (c) => c.json(engine.wallet()));
  api.post('/wallet/deposit', async (c) => c.json(engine.deposit(await body<DepositRequest>(c))));
  api.get('/settings', (c) => c.json(engine.getSettings()));
  api.put('/settings', async (c) => c.json(engine.updateSettings(await jsonBody(c))));

  return api;
}
