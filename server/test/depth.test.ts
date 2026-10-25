import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BookFrame, BookRow } from '../../shared/types.ts';
import { ManualClock } from '../src/market/clock.ts';
import { BINANCE_WS_BOOK } from '../src/market/binance.ts';
import { DepthService, LocalBook, bucketStep, type DepthEvent } from '../src/market/depth.ts';
import type { SocketLike } from '../src/market/socket.ts';
import { Store } from '../src/store.ts';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const START = Date.UTC(2026, 9, 24, 6, 0, 0, 500);
const ev = (U: number, u: number, pu: number, b: Array<[string, string]> = [], a: Array<[string, string]> = []): DepthEvent => ({ U, u, pu, b, a });
const tick = () => new Promise((r) => setImmediate(r));

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Array<{ method: string; params?: string[] }> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
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

test('bucket size: about 0.01 % of the price, round, a whole number of ticks', () => {
  assert.equal(bucketStep(102.34, 0.01), 0.01);
  assert.equal(bucketStep(80_858, 0.1), 10);
  assert.equal(bucketStep(2_365, 0.01), 0.25);
  assert.equal(bucketStep(4_010, 0.01), 0.5);
  assert.equal(bucketStep(212.3, 0.01), 0.02);
});

test('local book: buffered events replay onto the snapshot, old ones are dropped, a broken chain resets', () => {
  const book = new LocalBook();
  book.apply(ev(90, 95, 89, [['100.00', '5']])); // older than the snapshot
  book.apply(ev(96, 102, 95, [['100.00', '7'], ['99.99', '3']], [['100.02', '4']]));
  assert.equal(book.synced, false);
  assert.equal(book.pending, 2);
  assert.equal(book.load({ lastUpdateId: 100, bids: [['100.00', '1'], ['99.98', '2']], asks: [['100.01', '6']] }), true);
  assert.deepEqual(
    [...book.bids].sort((a, b) => b[0] - a[0]),
    [
      [100, 7],
      [99.99, 3],
      [99.98, 2],
    ],
  );
  assert.equal(book.apply(ev(103, 104, 102, [], [['100.01', '0']])), true); // removal
  assert.deepEqual(book.top(), { bid: 100, ask: 100.02 });
  // Buckets of 0.02 within ±1 % of the mid.
  const { bids, asks } = book.buckets(0.02, 100.01, 0.01);
  assert.deepEqual(
    [...bids].sort((a, b) => a[0] - b[0]),
    [
      [4999, 5], // 99.98 + 99.99
      [5000, 7],
    ],
  );
  assert.deepEqual([...asks], [[5001, 4]]);
  // A missed event: pu doesn't match the previous u.
  assert.equal(book.apply(ev(110, 112, 109)), false);
  assert.equal(book.synced, false);
  assert.equal(book.bids.size, 0);
});

test('local book: a snapshot older than the first buffered event is refused', () => {
  const book = new LocalBook();
  book.apply(ev(200, 210, 199));
  assert.equal(book.load({ lastUpdateId: 150, bids: [['1', '1']], asks: [['2', '1']] }), false);
  assert.equal(book.synced, false);
});

test('depth service: subscribes, loads the snapshot, pushes frames to viewers and stores a row per minute', async () => {
  const clock = new ManualClock(START);
  const sockets: FakeSocket[] = [];
  const store = new Store(':memory:');
  const urls: string[] = [];
  const svc = new DepthService({
    clock,
    log: quiet,
    store,
    socketFactory: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ lastUpdateId: 100, bids: [['102.30', '50'], ['102.29', '20'], ['90.00', '999']], asks: [['102.31', '40'], ['102.33', '10']] }));
    },
  });
  const frames: BookFrame[] = [];
  const rows: Array<{ symbol: string; row: BookRow }> = [];
  svc.onFrame((f) => frames.push(f));
  svc.onRow((symbol, row) => rows.push({ symbol, row }));
  svc.setRecorded(['SOLUSD', 'MNQ', 'EURUSD']); // only the Binance market is kept
  assert.equal(svc.supports('MNQ'), false);
  svc.start();
  const ws = sockets[0];
  assert.equal(ws.url, BINANCE_WS_BOOK);
  ws.open();
  clock.advance(100);
  assert.deepEqual(ws.sent[0], { method: 'SUBSCRIBE', params: ['solusdt@depth@500ms'], id: 1 });

  const send = (e: DepthEvent) => ws.receive({ stream: 'solusdt@depth@500ms', data: { e: 'depthUpdate', s: 'SOLUSDT', ...e } });
  send(ev(99, 101, 98, [['102.30', '60']]));
  await tick();
  await tick();
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/fapi\/v1\/depth\?symbol=SOLUSDT&limit=1000$/);
  send(ev(102, 103, 101, [['102.28', '5']]));

  // Recorded but nobody watching: no live frames.
  clock.advance(1000);
  assert.equal(frames.length, 0);
  svc.watch('ws:a', 'SOLUSD');
  clock.advance(1000);
  const f = frames.at(-1)!;
  assert.equal(f.symbol, 'SOLUSD');
  assert.equal(f.step, 0.01);
  assert.equal(f.mid, 102.305);
  assert.deepEqual(f.bids, [
    [10228, 5],
    [10229, 20],
    [10230, 60],
  ]); // 90.00 is outside the ±1.5 % range
  assert.deepEqual(f.asks, [
    [10231, 40],
    [10233, 10],
  ]);

  // The minute ends: one row of averages (the size at 102.28 appeared in every sample).
  clock.advance(60_000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'SOLUSD');
  assert.equal(rows[0].row.t, Math.floor(START / 60_000) * 60);
  assert.deepEqual(rows[0].row.bids, [
    [10228, 5],
    [10229, 20],
    [10230, 60],
  ]);
  assert.deepEqual(svc.rows('SOLUSD', 0, Number.MAX_SAFE_INTEGER), [rows[0].row]);

  // A gap reloads the book from a new snapshot.
  send(ev(200, 201, 150));
  await tick();
  await tick();
  assert.equal(urls.length, 2);
  svc.watch('ws:a', null);
  svc.setRecorded([]);
  clock.advance(1000);
  assert.deepEqual(ws.sent.at(-1), { method: 'UNSUBSCRIBE', params: ['solusdt@depth@500ms'], id: 2 });
  svc.stop();
  store.close();
});
