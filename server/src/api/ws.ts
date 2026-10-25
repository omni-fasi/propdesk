// WebSocket server on /ws (SPEC §9).
// - quotes: batched per client every ~125 ms, latest quote per symbol, for subscribed symbols plus
//   symbols with open positions / working orders;
// - candle: live 1m bars of the client's chart symbol (in the same batch, oldest first);
// - snapshot: ≤ 4/s per account, immediately after fills / status changes;
// - everything else pushed to all clients as it happens.

import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import type { ServerMessage } from '../../../shared/api.ts';
import type { Candle, Quote } from '../../../shared/types.ts';
import { getInstrument } from '../../../shared/instruments.ts';
import type { Engine } from '../engine/engine.ts';
import type { DepthSource, Logger, MarketHub } from '../market/types.ts';
import { VERSION } from '../version.ts';

const QUOTE_BATCH_MS = 125;
const SNAPSHOT_MS = 250;
const HEARTBEAT_MS = 30_000;
/** Skip quote batches for a client whose socket buffer is backed up. */
const MAX_BUFFERED = 1_000_000;
const MAX_SUBSCRIPTIONS = 200;

interface Client {
  id: string;
  ws: WebSocket;
  subs: Set<string>;
  chart: string | null;
  /** Symbol whose live order book this client watches (heatmap). */
  book: string | null;
  /** Symbols this client holds at the market hub (subs ∪ chart). */
  retained: Set<string>;
  quotes: Map<string, Quote>;
  candles: Map<number, Candle>;
  alive: boolean;
}

export interface WsHub {
  clientCount(): number;
  close(): void;
}

export function attachWebSocket(server: Server, deps: { engine: Engine; market: MarketHub; depth?: DepthSource | null; log: Logger }): WsHub {
  const { engine, market, log } = deps;
  const depth = deps.depth ?? null;
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
  const clients = new Map<string, Client>();
  const snapshots = new Map<string, { last: number; timer: ReturnType<typeof setTimeout> | null }>();
  const owner = (c: Client) => `ws:${c.id}`;

  const send = (c: Client, msg: ServerMessage) => {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMessage) => {
    if (!clients.size) return;
    const data = JSON.stringify(msg);
    for (const c of clients.values()) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  };

  // ── account snapshots (throttled per account, wall clock)
  const sendSnapshot = (accountId: string) => {
    const s = snapshots.get(accountId);
    if (s) s.last = Date.now();
    if (!clients.size) return;
    const snapshot = engine.snapshot(accountId);
    if (snapshot) broadcast({ type: 'snapshot', snapshot });
  };
  const scheduleSnapshot = (accountId: string, immediate: boolean) => {
    let s = snapshots.get(accountId);
    if (!s) snapshots.set(accountId, (s = { last: 0, timer: null }));
    const since = Date.now() - s.last;
    if (immediate || since >= SNAPSHOT_MS) {
      if (s.timer) clearTimeout(s.timer);
      s.timer = null;
      sendSnapshot(accountId);
    } else if (!s.timer) {
      const entry = s;
      entry.timer = setTimeout(() => {
        entry.timer = null;
        sendSnapshot(accountId);
      }, SNAPSHOT_MS - since);
    }
  };

  const offEngine = engine.on((ev) => {
    if (ev.type === 'snapshot') scheduleSnapshot(ev.accountId, ev.immediate);
    else broadcast(ev);
  });

  // ── market data
  const offQuote = market.onQuote((q) => {
    if (!clients.size) return;
    const engineSymbols = engine.activeSymbols();
    for (const c of clients.values()) if (c.subs.has(q.symbol) || engineSymbols.has(q.symbol)) c.quotes.set(q.symbol, q);
  });
  const offCandle = market.onCandle((symbol, candle) => {
    for (const c of clients.values()) if (c.chart === symbol) c.candles.set(candle.time, { ...candle });
  });
  const offFeeds = market.onFeedStatus((feeds) => broadcast({ type: 'feeds', feeds }));

  // ── order book: live frames (~1/s) and finished heatmap minutes, to the clients watching that symbol
  const toBookWatchers = (symbol: string, msg: ServerMessage) => {
    let data: string | null = null;
    for (const c of clients.values()) {
      if (c.book !== symbol || c.ws.readyState !== WebSocket.OPEN || c.ws.bufferedAmount > MAX_BUFFERED) continue;
      c.ws.send((data ??= JSON.stringify(msg)));
    }
  };
  const offBook = depth?.onFrame((frame) => toBookWatchers(frame.symbol, { type: 'book', frame })) ?? (() => {});
  const offBookRow = depth?.onRow((symbol, row) => toBookWatchers(symbol, { type: 'book_row', symbol, row })) ?? (() => {});

  const flush = () => {
    for (const c of clients.values()) {
      if (c.ws.readyState !== WebSocket.OPEN || c.ws.bufferedAmount > MAX_BUFFERED) continue;
      if (c.quotes.size) {
        send(c, { type: 'quotes', quotes: [...c.quotes.values()] });
        c.quotes.clear();
      }
      if (c.candles.size && c.chart) {
        const symbol = c.chart;
        for (const candle of [...c.candles.values()].sort((x, y) => x.time - y.time)) send(c, { type: 'candle', symbol, candle });
        c.candles.clear();
      }
    }
  };
  const flushTimer = setInterval(flush, QUOTE_BATCH_MS);
  flushTimer.unref?.();

  const heartbeat = setInterval(() => {
    for (const c of clients.values()) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        // socket already closing
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  /** Retain subs ∪ chart at the hub for this client; release what it no longer needs. */
  const syncRetention = (c: Client) => {
    const want = new Set(c.subs);
    if (c.chart) want.add(c.chart);
    for (const s of want) if (!c.retained.has(s)) market.retain(s, owner(c));
    for (const s of c.retained) if (!want.has(s)) market.release(s, owner(c));
    c.retained = want;
  };

  const onMessage = (c: Client, raw: string) => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as Record<string, unknown>;
    if (m.type === 'subscribe' && Array.isArray(m.symbols)) {
      const next = new Set(m.symbols.filter((s): s is string => typeof s === 'string' && getInstrument(s) != null).slice(0, MAX_SUBSCRIPTIONS));
      for (const s of next) {
        // Newly subscribed symbols get their latest quote in the next batch.
        const q = !c.subs.has(s) ? market.getQuote(s) : null;
        if (q) c.quotes.set(s, q);
      }
      c.subs = next;
      syncRetention(c);
    } else if (m.type === 'chart') {
      const symbol = typeof m.symbol === 'string' && getInstrument(m.symbol) ? m.symbol : null;
      if (symbol !== c.chart) c.candles.clear();
      c.chart = symbol;
      syncRetention(c);
    } else if (m.type === 'book') {
      const symbol = typeof m.symbol === 'string' && depth?.supports(m.symbol) ? m.symbol : null;
      c.book = symbol;
      depth?.watch(owner(c), symbol);
    } else if (m.type === 'ping') {
      send(c, { type: 'pong', t: typeof m.t === 'number' ? m.t : 0, serverTime: engine.now() });
    }
  };

  wss.on('connection', (ws) => {
    const c: Client = { id: randomUUID(), ws, subs: new Set(), chart: null, book: null, retained: new Set(), quotes: new Map(), candles: new Map(), alive: true };
    clients.set(c.id, c);
    ws.on('pong', () => {
      c.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) onMessage(c, data.toString());
    });
    const drop = () => {
      if (!clients.delete(c.id)) return;
      market.releaseAll(owner(c));
      depth?.watch(owner(c), null);
    };
    ws.on('close', drop);
    ws.on('error', (err) => {
      log.debug('ws: client %s error: %s', c.id, err.message);
      drop();
    });
    send(c, { type: 'hello', serverTime: engine.now(), version: VERSION });
  });
  wss.on('error', (err) => log.error('ws: server error: %s', err.message));

  return {
    clientCount: () => clients.size,
    close() {
      clearInterval(flushTimer);
      clearInterval(heartbeat);
      for (const s of snapshots.values()) if (s.timer) clearTimeout(s.timer);
      offEngine();
      offQuote();
      offCandle();
      offFeeds();
      offBook();
      offBookRow();
      for (const c of clients.values()) {
        market.releaseAll(owner(c));
        c.ws.terminate();
      }
      clients.clear();
      wss.close();
    },
  };
}
