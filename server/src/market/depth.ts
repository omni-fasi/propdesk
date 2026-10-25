// Order book liquidity for the chart heatmap — Binance USDⓈ-M markets only (Yahoo has no order book).
//
// A local book per symbol is kept in sync from a REST snapshot (1000 levels a side) plus the
// `<feed>@depth@500ms` diff stream, following Binance's procedure: buffer events, load the snapshot, drop
// events older than it, then every event's `pu` must equal the previous event's `u` — otherwise resync.
// Levels beyond the snapshot appear as they change. Every second each book is bucketed around its mid
// price: pushed live to viewers and averaged per minute into BookRows, stored for the heatmap's history.
// Symbols in the watchlist are recorded all the time; others only while someone watches them.

import type { BookFrame, BookLevel, BookRow, InstrumentSpec } from '../../../shared/types.ts';
import { getInstrument } from '../../../shared/instruments.ts';
import { BINANCE_REST, BINANCE_WS_BOOK, StreamConnection } from './binance.ts';
import type { Clock, TimerHandle } from './clock.ts';
import { errorMessage, getJson, RequestQueue, type FetchFn } from './http.ts';
import type { SocketFactory } from './socket.ts';
import type { DepthSource, Logger } from './types.ts';

/** Price range kept on each side of the mid price. */
export const BOOK_RANGE = 0.015;
/** Stored rows drop buckets smaller than this share of the row's largest one. */
const MIN_SHARE = 0.002;
/** A minute needs this many samples to be stored. */
const MIN_SAMPLES = 10;
const MAX_SYMBOLS = 12;
const MAX_BUFFER = 5_000;
const RETENTION_MS = 24 * 3_600_000;
const PRUNE_EVERY_MS = 10 * 60_000;
const SNAPSHOT_RETRY_MS = 10_000;

/** Heatmap bucket size: about 0.01 % of the price, a round number, a whole number of ticks. */
export function bucketStep(price: number, tick: number): number {
  const raw = price * 0.0001;
  const base = 10 ** Math.floor(Math.log10(raw));
  const m = raw / base;
  const nice = m < 1.5 ? 1 : m < 2.25 ? 2 : m < 3.5 ? 2.5 : m < 7.5 ? 5 : 10;
  const ticks = Math.max(1, Math.round((nice * base) / tick));
  return Number((ticks * tick).toFixed(10));
}

type RawLevels = Array<[string, string]>;

/** A `depthUpdate` event of the diff stream. */
export interface DepthEvent {
  U: number;
  u: number;
  pu: number;
  b: RawLevels;
  a: RawLevels;
}

export interface DepthSnapshot {
  lastUpdateId: number;
  bids: RawLevels;
  asks: RawLevels;
}

function applyLevels(side: Map<number, number>, levels: RawLevels): void {
  for (const [p, q] of levels) {
    const price = Number(p);
    const qty = Number(q);
    if (!Number.isFinite(price) || !Number.isFinite(qty)) continue;
    if (qty > 0) side.set(price, qty);
    else side.delete(price);
  }
}

/** One symbol's order book: a snapshot plus the diff events after it. */
export class LocalBook {
  readonly bids = new Map<number, number>();
  readonly asks = new Map<number, number>();
  /** A snapshot is loaded and the event chain is unbroken. */
  synced = false;
  private lastUpdateId = 0;
  private prevU: number | null = null;
  private buffer: DepthEvent[] = [];

  get pending(): number {
    return this.buffer.length;
  }

  /** Forget everything; events are buffered again until the next snapshot. */
  reset(): void {
    this.synced = false;
    this.bids.clear();
    this.asks.clear();
    this.prevU = null;
    this.buffer = [];
  }

  /** A diff event. false = the chain broke: the book was reset and starts buffering again from this event. */
  apply(ev: DepthEvent): boolean {
    if (this.synced) {
      if (this.step(ev)) return true;
      this.reset();
      this.buffer.push(ev);
      return false;
    }
    this.buffer.push(ev);
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
    return true;
  }

  /** Load a snapshot and replay the events buffered meanwhile. false = they don't connect (fetch again). */
  load(snap: DepthSnapshot): boolean {
    this.bids.clear();
    this.asks.clear();
    applyLevels(this.bids, snap.bids);
    applyLevels(this.asks, snap.asks);
    this.lastUpdateId = snap.lastUpdateId;
    this.prevU = null;
    this.synced = true;
    const pending = this.buffer;
    this.buffer = [];
    for (const ev of pending) {
      if (this.step(ev)) continue;
      this.reset();
      return false;
    }
    return true;
  }

  private step(ev: DepthEvent): boolean {
    if (this.prevU == null) {
      if (ev.u < this.lastUpdateId) return true; // older than the snapshot
      if (ev.U > this.lastUpdateId) return false; // events between the snapshot and this one are missing
    } else if (ev.pu !== this.prevU) return false;
    applyLevels(this.bids, ev.b);
    applyLevels(this.asks, ev.a);
    this.prevU = ev.u;
    return true;
  }

  /** Best bid / ask (null when a side is empty or the book is crossed). */
  top(): { bid: number; ask: number } | null {
    let bid = -Infinity;
    let ask = Infinity;
    for (const p of this.bids.keys()) if (p > bid) bid = p;
    for (const p of this.asks.keys()) if (p < ask) ask = p;
    return Number.isFinite(bid) && Number.isFinite(ask) && bid < ask ? { bid, ask } : null;
  }

  /** Size per bucket of `step` within `range` of the mid price. */
  buckets(step: number, mid: number, range: number): { bids: Map<number, number>; asks: Map<number, number> } {
    const lo = mid * (1 - range);
    const hi = mid * (1 + range);
    const bids = new Map<number, number>();
    const asks = new Map<number, number>();
    for (const [p, q] of this.bids) {
      if (p < lo) continue;
      const i = Math.floor(p / step + 1e-6);
      bids.set(i, (bids.get(i) ?? 0) + q);
    }
    for (const [p, q] of this.asks) {
      if (p > hi) continue;
      const i = Math.floor(p / step + 1e-6);
      asks.set(i, (asks.get(i) ?? 0) + q);
    }
    return { bids, asks };
  }
}

const sig4 = (q: number) => Number(q.toPrecision(4));

function levels(m: Map<number, number>, scale = 1, min = 0): BookLevel[] {
  const out: BookLevel[] = [];
  for (const [i, q] of m) {
    const v = q / scale;
    if (v > 0 && v >= min) out.push([i, sig4(v)]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

interface Minute {
  t: number;
  step: number;
  n: number;
  bids: Map<number, number>;
  asks: Map<number, number>;
}

interface SymbolState {
  spec: InstrumentSpec;
  feed: string;
  stream: string;
  book: LocalBook;
  step: number | null;
  fetching: boolean;
  retryAt: number;
  minute: Minute | null;
}

export interface BookStore {
  insertBookRow(symbol: string, row: BookRow): void;
  queryBookRows(symbol: string, from: number, to: number, limit: number): BookRow[];
  pruneBookRows(before: number): number;
}

export interface DepthServiceOptions {
  clock: Clock;
  log: Logger;
  fetch: FetchFn;
  socketFactory: SocketFactory;
  store: BookStore;
  restBase?: string;
  wsUrl?: string;
}

export class DepthService implements DepthSource {
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly fetchFn: FetchFn;
  private readonly store: BookStore;
  private readonly rest: string;
  private readonly conn: StreamConnection;
  private readonly queue: RequestQueue;
  private readonly states = new Map<string, SymbolState>();
  private readonly byFeed = new Map<string, SymbolState>();
  private recorded = new Set<string>();
  private readonly watchers = new Map<string, string>();
  private readonly frameFns = new Set<(f: BookFrame) => void>();
  private readonly rowFns = new Set<(symbol: string, row: BookRow) => void>();
  private timer: TimerHandle | null = null;
  private lastPruneAt = -Infinity;
  private started = false;

  constructor(o: DepthServiceOptions) {
    this.clock = o.clock;
    this.log = o.log;
    this.fetchFn = o.fetch;
    this.store = o.store;
    this.rest = o.restBase ?? BINANCE_REST;
    this.queue = new RequestQueue(2, 250, o.clock);
    this.conn = new StreamConnection({
      name: 'binance-depth',
      url: o.wsUrl ?? BINANCE_WS_BOOK,
      clock: o.clock,
      log: o.log,
      factory: o.socketFactory,
      spacingMs: 250,
      onData: (d) => this.onData(d),
      // Events were missed while the stream was down: every book needs a new snapshot.
      onDown: () => {
        for (const st of this.states.values()) st.book.reset();
      },
      onChange: () => {},
    });
  }

  supports(symbol: string): boolean {
    return getInstrument(symbol)?.provider === 'binance';
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.conn.socket.start();
    this.timer = this.clock.setInterval(() => {
      try {
        this.tick();
      } catch (e) {
        this.log.error(`[depth] tick failed: ${errorMessage(e)}`);
      }
    }, 1000);
  }

  stop(): void {
    this.started = false;
    if (this.timer != null) this.clock.clearInterval(this.timer);
    this.timer = null;
    for (const st of this.states.values()) this.finishMinute(st);
    this.conn.stop();
    this.queue.clear(new Error('order book stopped'));
  }

  setRecorded(symbols: Iterable<string>): void {
    this.recorded = new Set([...symbols].filter((s) => this.supports(s)));
    this.sync();
  }

  watch(owner: string, symbol: string | null): void {
    if (symbol && this.supports(symbol)) this.watchers.set(owner, symbol);
    else this.watchers.delete(owner);
    this.sync();
  }

  onFrame(fn: (frame: BookFrame) => void): () => void {
    this.frameFns.add(fn);
    return () => this.frameFns.delete(fn);
  }

  onRow(fn: (symbol: string, row: BookRow) => void): () => void {
    this.rowFns.add(fn);
    return () => this.rowFns.delete(fn);
  }

  rows(symbol: string, fromSec: number, toSec: number): BookRow[] {
    return this.store.queryBookRows(symbol, fromSec, toSec, 3_000);
  }

  /** Books for the watched symbols first, then the recorded ones, at most MAX_SYMBOLS. */
  private sync(): void {
    const want = [...new Set([...this.watchers.values(), ...this.recorded])].slice(0, MAX_SYMBOLS);
    for (const symbol of want) {
      if (this.states.has(symbol)) continue;
      const spec = getInstrument(symbol)!;
      const st: SymbolState = { spec, feed: spec.feedSymbol, stream: `${spec.feedSymbol.toLowerCase()}@depth@500ms`, book: new LocalBook(), step: null, fetching: false, retryAt: 0, minute: null };
      this.states.set(symbol, st);
      this.byFeed.set(st.feed, st);
      this.conn.add(st.stream);
    }
    for (const [symbol, st] of this.states) {
      if (want.includes(symbol)) continue;
      this.finishMinute(st);
      this.states.delete(symbol);
      this.byFeed.delete(st.feed);
      this.conn.remove(st.stream);
    }
  }

  private onData(d: unknown): void {
    const ev = d as Partial<DepthEvent> & { e?: unknown; s?: unknown };
    if (ev?.e !== 'depthUpdate' || typeof ev.s !== 'string') return;
    const st = this.byFeed.get(ev.s);
    if (!st || typeof ev.U !== 'number' || typeof ev.u !== 'number' || !Array.isArray(ev.b) || !Array.isArray(ev.a)) return;
    if (!st.book.apply(ev as DepthEvent)) this.log.debug(`[depth] ${st.spec.symbol}: update gap, reloading the book`);
    if (!st.book.synced) this.fetchSnapshot(st);
  }

  private fetchSnapshot(st: SymbolState): void {
    if (st.fetching || this.clock.now() < st.retryAt || !st.book.pending) return;
    st.fetching = true;
    const url = `${this.rest}/fapi/v1/depth?symbol=${st.feed}&limit=1000`;
    this.queue
      .run(() => getJson<DepthSnapshot>(this.fetchFn, url))
      .then((snap) => {
        st.fetching = false;
        if (this.states.get(st.spec.symbol) !== st) return;
        if (!snap || typeof snap.lastUpdateId !== 'number' || !Array.isArray(snap.bids) || !Array.isArray(snap.asks)) throw new Error('unexpected response');
        if (!st.book.load(snap)) st.retryAt = this.clock.now() + 1000;
      })
      .catch((e: unknown) => {
        st.fetching = false;
        st.retryAt = this.clock.now() + SNAPSHOT_RETRY_MS;
        this.log.warn(`[depth] ${st.spec.symbol}: snapshot failed: ${errorMessage(e)}`);
      });
  }

  private tick(): void {
    const now = this.clock.now();
    const watched = new Set(this.watchers.values());
    for (const st of this.states.values()) {
      if (!st.book.synced) {
        this.fetchSnapshot(st);
        continue;
      }
      const top = st.book.top();
      if (!top) continue;
      const mid = (top.bid + top.ask) / 2;
      st.step ??= bucketStep(mid, st.spec.tickSize);
      const { bids, asks } = st.book.buckets(st.step, mid, BOOK_RANGE);
      if (watched.has(st.spec.symbol)) {
        const frame: BookFrame = { symbol: st.spec.symbol, ts: now, step: st.step, mid, bids: levels(bids), asks: levels(asks) };
        for (const fn of this.frameFns) fn(frame);
      }
      if (this.recorded.has(st.spec.symbol) || watched.has(st.spec.symbol)) this.addSample(st, now, bids, asks);
    }
    if (now - this.lastPruneAt >= PRUNE_EVERY_MS) {
      this.lastPruneAt = now;
      try {
        this.store.pruneBookRows(Math.floor((now - RETENTION_MS) / 1000));
      } catch (e) {
        this.log.warn(`[depth] prune failed: ${errorMessage(e)}`);
      }
    }
  }

  private addSample(st: SymbolState, now: number, bids: Map<number, number>, asks: Map<number, number>): void {
    const t = Math.floor(now / 60_000) * 60;
    if (st.minute && (st.minute.t !== t || st.minute.step !== st.step)) this.finishMinute(st);
    const m = (st.minute ??= { t, step: st.step!, n: 0, bids: new Map(), asks: new Map() });
    m.n++;
    for (const [i, q] of bids) m.bids.set(i, (m.bids.get(i) ?? 0) + q);
    for (const [i, q] of asks) m.asks.set(i, (m.asks.get(i) ?? 0) + q);
  }

  /** Store the minute being collected as a row of averages (time-weighted: a level present half the minute counts half). */
  private finishMinute(st: SymbolState): void {
    const m = st.minute;
    st.minute = null;
    if (!m || m.n < MIN_SAMPLES) return;
    let max = 0;
    for (const q of m.bids.values()) max = Math.max(max, q / m.n);
    for (const q of m.asks.values()) max = Math.max(max, q / m.n);
    const row: BookRow = { t: m.t, step: m.step, bids: levels(m.bids, m.n, max * MIN_SHARE), asks: levels(m.asks, m.n, max * MIN_SHARE) };
    try {
      this.store.insertBookRow(st.spec.symbol, row);
    } catch (e) {
      this.log.warn(`[depth] saving ${st.spec.symbol} failed: ${errorMessage(e)}`);
    }
    for (const fn of this.rowFns) fn(st.spec.symbol, row);
  }
}
