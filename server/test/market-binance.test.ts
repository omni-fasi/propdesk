import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../../shared/types.ts';
import { BinanceProvider, BINANCE_WS_BOOK, BINANCE_WS_KLINE, parseKlines } from '../src/market/binance.ts';
import { ManualClock } from '../src/market/clock.ts';
import type { FetchFn } from '../src/market/http.ts';
import type { FeedRef, FeedTick, ProviderSink } from '../src/market/provider.ts';
import type { SocketLike } from '../src/market/socket.ts';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const START = Date.UTC(2026, 9, 24, 6, 0);
const ref = (feed: string): FeedRef => ({ feed, session: '24x7', dayRule: { hour: 0, minute: 0, tz: 'UTC' } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Array<{ at: number; msg: { method: string; params?: string[]; id: number } }> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  readonly url: string;
  private readonly clock: ManualClock;
  constructor(url: string, clock: ManualClock) {
    this.url = url;
    this.clock = clock;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  send(data: string) {
    this.sent.push({ at: this.clock.now(), msg: JSON.parse(data) });
  }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  terminate() {
    this.close(1006);
  }
}

function setup(fetchImpl: FetchFn = async () => json([])) {
  const clock = new ManualClock(START);
  const sockets: FakeSocket[] = [];
  const ticks: FeedTick[] = [];
  const bars: Array<{ feed: string; bar: Candle; live: boolean }> = [];
  const downs: number[] = [];
  const sink: ProviderSink = { tick: (t) => ticks.push(t), bar: (feed, bar, live) => bars.push({ feed, bar, live }), changed() {}, down: (s) => downs.push(s) };
  const bp = new BinanceProvider(sink, {
    clock,
    log: quiet,
    fetch: fetchImpl,
    socketFactory: (url) => {
      const s = new FakeSocket(url, clock);
      sockets.push(s);
      return s;
    },
    random: () => 0.5,
  });
  const book = () => sockets.filter((s) => s.url === BINANCE_WS_BOOK).at(-1)!;
  const kline = () => sockets.filter((s) => s.url === BINANCE_WS_KLINE).at(-1)!;
  return { clock, sockets, ticks, bars, downs, bp, book, kline };
}

test('book and kline streams on their own routes, batched into one SUBSCRIBE each', () => {
  const { clock, sockets, bp, book, kline } = setup();
  bp.start();
  assert.deepEqual(sockets.map((s) => s.url).sort(), [BINANCE_WS_KLINE, BINANCE_WS_BOOK].sort());
  for (const f of ['BTCUSDT', 'ETHUSDT', 'XAUUSDT']) bp.subscribe(ref(f));
  clock.advance(100);
  book().open();
  kline().open();
  assert.deepEqual(book().sent.map((s) => s.msg), [{ method: 'SUBSCRIBE', params: ['btcusdt@bookTicker', 'ethusdt@bookTicker', 'xauusdt@bookTicker'], id: 1 }]);
  assert.deepEqual(kline().sent.map((s) => s.msg), [{ method: 'SUBSCRIBE', params: ['btcusdt@kline_1m', 'ethusdt@kline_1m', 'xauusdt@kline_1m'], id: 1 }]);
  assert.equal(bp.status().state, 'live');
  bp.stop();
});

test('control messages are throttled to at most 4 per second', () => {
  const { clock, bp, book } = setup();
  bp.start();
  book().open();
  // 20 separate changes, 60 ms apart: each would trigger its own SUBSCRIBE/UNSUBSCRIBE.
  for (let i = 0; i < 20; i++) {
    if (i % 2) bp.unsubscribe(`S${i - 1}USDT`);
    else bp.subscribe(ref(`S${i}USDT`));
    clock.advance(60);
  }
  clock.advance(10_000);
  const sent = book().sent;
  assert.ok(sent.length >= 10, `sent ${sent.length}`);
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i].at - sent[i - 1].at >= 250, 'spacing ≥ 250 ms');
  for (const s of sent) assert.ok(sent.filter((x) => x.at >= s.at && x.at < s.at + 1000).length <= 5, '≤ 5 per second');
  // The net result is still exact: nothing left subscribed.
  const subscribed = new Set<string>();
  for (const { msg } of sent) for (const p of msg.params ?? []) msg.method === 'SUBSCRIBE' ? subscribed.add(p) : subscribed.delete(p);
  assert.deepEqual([...subscribed], []);
  bp.stop();
});

test('bookTicker → bid/ask tick, kline → live bar + last tick', () => {
  const { bp, book, kline, ticks, bars } = setup();
  bp.start();
  bp.subscribe(ref('BTCUSDT'));
  book().open();
  kline().open();
  book().receive({ stream: 'btcusdt@bookTicker', data: { e: 'bookTicker', s: 'BTCUSDT', b: '80722.30', B: '5.4', a: '80722.40', A: '2.4', T: START - 2, E: START - 1 } });
  kline().receive({
    stream: 'btcusdt@kline_1m',
    data: { e: 'kline', E: START + 5, s: 'BTCUSDT', k: { t: START, T: START + 59_999, s: 'BTCUSDT', i: '1m', o: '80727.40', c: '80727.50', h: '80730.00', l: '80720.10', v: '12.5', x: false } },
  });
  kline().receive({ result: null, id: 1 });
  assert.deepEqual(ticks, [
    { feed: 'BTCUSDT', ts: START - 1, bid: 80722.3, ask: 80722.4, source: 'stream' },
    { feed: 'BTCUSDT', ts: START + 5, last: 80727.5, source: 'stream' },
  ]);
  assert.deepEqual(bars, [{ feed: 'BTCUSDT', bar: { time: START / 1000, open: 80727.4, high: 80730, low: 80720.1, close: 80727.5, volume: 12.5 }, live: true }]);
  bp.stop();
});

test('reconnects with backoff after a drop and resubscribes everything; reports the outage start', () => {
  const { clock, bp, book, kline, sockets, downs } = setup();
  bp.start();
  bp.subscribe(ref('BTCUSDT'));
  bp.subscribe(ref('ETHUSDT'));
  book().open();
  kline().open();
  clock.advance(5000);
  book().receive({ stream: 'btcusdt@bookTicker', data: { e: 'bookTicker', s: 'BTCUSDT', b: '1', a: '2', E: START } });
  const lastMsgAt = clock.now();
  clock.advance(500);
  book().close(1006, 'gone');
  assert.deepEqual(downs, [lastMsgAt]);
  assert.equal(bp.status().state, 'degraded'); // kline route still up
  const before = sockets.length;
  clock.advance(900);
  assert.equal(sockets.length, before, 'waits for the backoff');
  clock.advance(200);
  assert.equal(sockets.length, before + 1);
  book().open();
  const { method, params } = book().sent[0].msg;
  assert.deepEqual({ method, params }, { method: 'SUBSCRIBE', params: ['btcusdt@bookTicker', 'ethusdt@bookTicker'] });
  bp.stop();
});

test('heartbeat: LIST_SUBSCRIPTIONS resyncs lost streams; a silent connection is replaced', () => {
  const { clock, bp, book, kline } = setup();
  bp.start();
  bp.subscribe(ref('BTCUSDT'));
  bp.subscribe(ref('ETHUSDT'));
  book().open();
  kline().open();
  const conn = book();
  clock.advance(30_000);
  const list = conn.sent.at(-1)!.msg;
  assert.equal(list.method, 'LIST_SUBSCRIPTIONS');
  conn.receive({ result: ['btcusdt@bookTicker'], id: list.id });
  clock.advance(300);
  assert.deepEqual(conn.sent.at(-1)!.msg.params, ['ethusdt@bookTicker']);
  // No more traffic at all: the first heartbeat after 75 s of silence (t = 120 s) replaces the connection.
  clock.advance(85_000);
  assert.equal(book(), conn, 'still the same connection at t = 115 s');
  clock.advance(5_000);
  assert.notEqual(book(), conn, 'reconnected');
  assert.equal(conn.readyState, 3, 'old socket terminated');
  bp.stop();
});

test('REST: klines request shape and parsing, 1m history paging, price snapshot', async () => {
  const urls: URL[] = [];
  const fetchImpl: FetchFn = async (url) => {
    const u = new URL(url);
    urls.push(u);
    if (u.pathname === '/fapi/v1/ticker/bookTicker') return json({ symbol: 'BTCUSDT', bidPrice: '80722.30', askPrice: '80722.40', time: START - 100 });
    if (u.pathname === '/fapi/v1/ticker/24hr') return json({ symbol: 'BTCUSDT', lastPrice: '80722.35', openPrice: '81000.00', closeTime: START - 50 });
    const start = Number(u.searchParams.get('startTime') || 0);
    const limit = Number(u.searchParams.get('limit'));
    if (start) {
      // 1500 rows for the first page, 10 for the second.
      const n = start === Math.floor((START - 2000 * 60_000) / 60_000) * 60_000 ? 1500 : 10;
      return json(Array.from({ length: Math.min(n, limit) }, (_, i) => [start + i * 60_000, '1', '2', '0.5', '1.5', '3', start + i * 60_000 + 59_999]));
    }
    const end = Number(u.searchParams.get('endTime'));
    return json([
      [end - 7_200_000 + 1, '10', '11', '9', '10.5', '100'],
      [end - 3_600_000 + 1, '10.5', '12', '10', '11', '50'],
    ]);
  };
  const { bp, ticks } = setup(fetchImpl);
  const h = await bp.history(ref('BTCUSDT'), '1h', START, 5000);
  assert.equal(urls[0].pathname, '/fapi/v1/klines');
  assert.equal(urls[0].searchParams.get('interval'), '1h');
  assert.equal(urls[0].searchParams.get('endTime'), String(START - 1));
  assert.equal(urls[0].searchParams.get('limit'), '1500');
  assert.deepEqual(h, [
    { time: (START - 7_200_000) / 1000, open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
    { time: (START - 3_600_000) / 1000, open: 10.5, high: 12, low: 10, close: 11, volume: 50 },
  ]);

  urls.length = 0;
  const m = await bp.history1m(ref('BTCUSDT'), START - 2000 * 60_000, START);
  assert.equal(urls.length, 2);
  assert.equal(Number(urls[1].searchParams.get('startTime')), Number(urls[0].searchParams.get('startTime')) + 1500 * 60_000);
  assert.equal(m.length, 1510);

  await bp.seed(ref('BTCUSDT'));
  assert.deepEqual(ticks.at(-1), { feed: 'BTCUSDT', ts: START - 100, bid: 80722.3, ask: 80722.4, last: 80722.35, refPrice: 81000, source: 'seed' });
  assert.throws(() => parseKlines({ code: -1121, msg: 'Invalid symbol.' }), /unexpected/);
});
