import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getInstrument, INSTRUMENTS } from '../../shared/instruments.ts';
import type { Candle, FeedProvider, FeedStatus, Quote, Timeframe } from '../../shared/types.ts';
import { ManualClock } from '../src/market/clock.ts';
import { DelayDetector, roundDelay } from '../src/market/delay.ts';
import { SuspendDetector } from '../src/market/gap.ts';
import { createHub } from '../src/market/hub.ts';
import type { FeedRef, Provider, ProviderSink, ProviderStatus } from '../src/market/provider.ts';
import { newTickRuleState, synthesize } from '../src/market/synth.ts';
import type { MarketGap } from '../src/market/types.ts';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const WED = Date.UTC(2026, 9, 21, 15, 0); // Wed 11:00 ET: CME and FX open
const SAT = Date.UTC(2026, 9, 24, 6, 0);
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

class FakeProvider implements Provider {
  readonly name: FeedProvider;
  readonly nativeBars: boolean;
  readonly sink: ProviderSink;
  calls: string[] = [];
  historyCalls: Array<{ feed: string; tf: Timeframe; endMs: number; limit: number }> = [];
  h1mCalls: Array<{ feed: string; fromMs: number; toMs: number }> = [];
  historyImpl: (ref: FeedRef, tf: Timeframe, endMs: number, limit: number) => Promise<Candle[]> = async () => [];
  h1mImpl: (ref: FeedRef, fromMs: number, toMs: number) => Promise<Candle[]> = async () => [];
  state: ProviderStatus['state'] = 'live';
  connected = true;
  lastMessageAt: number | null = null;
  connectedSince: number | null = 0;
  constructor(name: FeedProvider, nativeBars: boolean, sink: ProviderSink) {
    this.name = name;
    this.nativeBars = nativeBars;
    this.sink = sink;
  }
  start() {}
  stop() {}
  subscribe(ref: FeedRef) {
    this.calls.push(`sub:${ref.feed}`);
  }
  unsubscribe(feed: string) {
    this.calls.push(`unsub:${feed}`);
  }
  async seed(ref: FeedRef) {
    this.calls.push(`seed:${ref.feed}`);
  }
  async history(ref: FeedRef, tf: Timeframe, endMs: number, limit: number) {
    this.historyCalls.push({ feed: ref.feed, tf, endMs, limit });
    return this.historyImpl(ref, tf, endMs, limit);
  }
  async history1m(ref: FeedRef, fromMs: number, toMs: number) {
    this.h1mCalls.push({ feed: ref.feed, fromMs, toMs });
    return this.h1mImpl(ref, fromMs, toMs);
  }
  status(): ProviderStatus {
    return { state: this.state, message: this.state, lastMessageAt: this.lastMessageAt, connected: this.connected, connectedSince: this.connectedSince };
  }
  reconnect() {
    this.calls.push('reconnect');
  }
}

async function setup(start = WED, liveProxies = false) {
  const clock = new ManualClock(start);
  let bin!: FakeProvider;
  let yah!: FakeProvider;
  const hub = createHub(
    { instruments: INSTRUMENTS, log: quiet },
    { clock, lingerMs: 1000, liveProxies, providers: { binance: (s) => (bin = new FakeProvider('binance', true, s)), yahoo: (s) => (yah = new FakeProvider('yahoo', false, s)) } },
  );
  const quotes: Quote[] = [];
  const candles: Array<[string, Candle]> = [];
  const gaps: MarketGap[] = [];
  const feeds: FeedStatus[][] = [];
  hub.onQuote((q) => quotes.push(q));
  hub.onCandle((s, c) => candles.push([s, c]));
  hub.onGap((g) => gaps.push(g));
  hub.onFeedStatus((f) => feeds.push(f));
  await hub.start();
  return { clock, hub, bin, yah, quotes, candles, gaps, feeds };
}

const bar = (time: number, o: number, h: number, l: number, c: number, v = 1): Candle => ({ time, open: o, high: h, low: l, close: c, volume: v });

test('futures tick rule: uptick hits the ask, downtick the bid, unchanged keeps the side', () => {
  const mnq = getInstrument('MNQ')!;
  const st = newTickRuleState();
  assert.deepEqual(synthesize(mnq, { last: 25000 }, st), { bid: 25000, ask: 25000.25, last: 25000 }); // no history: bid side
  assert.deepEqual(synthesize(mnq, { last: 25000.5 }, st), { bid: 25000.25, ask: 25000.5, last: 25000.5 }); // uptick
  assert.deepEqual(synthesize(mnq, { last: 25000.5 }, st), { bid: 25000.25, ask: 25000.5, last: 25000.5 }); // unchanged
  assert.deepEqual(synthesize(mnq, { last: 25000.25 }, st), { bid: 25000.25, ask: 25000.5, last: 25000.25 }); // downtick
  assert.deepEqual(synthesize(mnq, { last: 25000.26 }, st), { bid: 25000.25, ask: 25000.5, last: 25000.25 }); // rounds to tick, unchanged
});

test('forex: symmetric N-tick spread on the tick grid, real book used when plausible', () => {
  const eur = getInstrument('EURUSD')!; // 6 ticks of 0.00001
  const st = newTickRuleState();
  assert.deepEqual(synthesize(eur, { last: 1.162344 }, st), { bid: 1.16231, ask: 1.16237, last: 1.16234 });
  assert.deepEqual(synthesize(eur, { last: 1.16234, bid: 1.162301, ask: 1.162362 }, st), { bid: 1.1623, ask: 1.16236, last: 1.16234 });
  // Crossed / zero-spread / far-away books are ignored.
  assert.deepEqual(synthesize(eur, { last: 1.16234, bid: 1.1624, ask: 1.1623 }, st), { bid: 1.16231, ask: 1.16237, last: 1.16234 });
  assert.deepEqual(synthesize(eur, { last: 1.16234, bid: 1.16234, ask: 1.16234 }, st), { bid: 1.16231, ask: 1.16237, last: 1.16234 });
  assert.deepEqual(synthesize(eur, { last: 1.16234, bid: 1.15, ask: 1.18 }, st), { bid: 1.16231, ask: 1.16237, last: 1.16234 });
  // bidask instruments: the book, rounded to the tick.
  const xau = getInstrument('XAUUSD')!;
  assert.deepEqual(synthesize(xau, { last: 4003.5649, bid: 4003.561, ask: 4003.574 }, newTickRuleState()), { bid: 4003.56, ask: 4003.57, last: 4003.56 });
});

test('delay detection: median rounded to minutes, immediate during warm-up, hysteresis afterwards', () => {
  assert.equal(roundDelay(5_000), 0);
  assert.equal(roundDelay(600_900), 600);
  assert.equal(roundDelay(-90_000), 0);
  const d = new DelayDetector();
  let t = WED;
  assert.equal(d.addSample(600_400, t), true);
  assert.equal(d.delaySec, 600);
  for (let i = 0; i < 20; i++) d.addSample(595_000 + (i % 5) * 5_000, (t += 1000)); // jitter 9:55–10:15
  assert.equal(d.delaySec, 600);
  assert.equal(d.addSample(45 * 60_000, (t += 1000)), false, 'lags > 30 min are "no trade yet", not delay');
  // The feed turns real-time: the new estimate must persist 90 s before it is applied.
  let changedAt = 0;
  let estimateAt = 0;
  for (let i = 0; i < 200 && !changedAt; i++) {
    if (d.addSample(800, (t += 1000))) changedAt = t;
    if (!estimateAt && d.estimate() === 0) estimateAt = t;
  }
  assert.equal(d.delaySec, 0);
  assert.ok(changedAt - estimateAt >= 90_000 && changedAt - estimateAt <= 92_000, `switched ${(changedAt - estimateAt) / 1000} s after the estimate moved`);
  // A brief excursion does not flap back.
  for (let i = 0; i < 30; i++) d.addSample(600_000, (t += 1000));
  for (let i = 0; i < 30; i++) d.addSample(500, (t += 1000));
  assert.equal(d.delaySec, 0);
});

test('ref-counting: one subscription per feed, linger on release, releaseAll, last quote kept', async () => {
  const { clock, hub, yah, quotes } = await setup();
  hub.retain('MNQ', 'ws:1');
  hub.retain('MNQ', 'ws:1'); // idempotent per owner
  hub.retain('NQ', 'engine');
  hub.retain('EURUSD', 'ws:1');
  hub.retain('NOPE', 'ws:1'); // unknown: ignored
  assert.deepEqual(yah.calls, ['sub:NQ=F', 'seed:NQ=F', 'sub:EURUSD=X', 'seed:EURUSD=X']);
  yah.sink.tick({ feed: 'NQ=F', ts: clock.now() - 1000, last: 25000, source: 'stream' });
  assert.deepEqual(quotes.map((q) => q.symbol), ['MNQ', 'NQ']);
  hub.release('MNQ', 'ws:1');
  clock.advance(5000);
  assert.ok(!yah.calls.includes('unsub:NQ=F'), 'NQ still retained by the engine');
  yah.sink.tick({ feed: 'NQ=F', ts: clock.now() - 1000, last: 25001, source: 'stream' });
  assert.deepEqual(quotes.slice(2).map((q) => q.symbol), ['NQ'], 'released symbols are not emitted');
  assert.equal(hub.getQuote('MNQ')?.last, 25001, 'but their quote stays current');
  hub.releaseAll('ws:1');
  hub.release('NQ', 'engine');
  clock.advance(500);
  hub.retain('NQ', 'ws:2'); // re-retained within the linger: no churn
  clock.advance(2000);
  assert.ok(!yah.calls.includes('unsub:NQ=F'));
  assert.ok(yah.calls.includes('unsub:EURUSD=X'));
  hub.release('NQ', 'ws:2');
  clock.advance(1000);
  assert.ok(yah.calls.includes('unsub:NQ=F'));
  assert.equal(hub.getQuote('NQ')?.last, 25001, 'last known quote survives the release');
  assert.equal(hub.getQuote('NOPE'), null);
  await hub.stop();
});

test('fan-out: NQ and MNQ get the same rounded price under their own symbols; bidask books rounded', async () => {
  const { clock, hub, yah, bin, quotes } = await setup();
  hub.retain('MNQ', 'a');
  hub.retain('NQ', 'a');
  hub.retain('XAUUSD', 'a');
  yah.sink.tick({ feed: 'NQ=F', ts: clock.now() - 500, last: 25000.13, refPrice: 24900, source: 'stream' });
  assert.deepEqual(
    quotes.map((q) => [q.symbol, q.bid, q.ask, q.last, q.changePct]),
    [
      ['MNQ', 25000.25, 25000.5, 25000.25, 0.004026],
      ['NQ', 25000.25, 25000.5, 25000.25, 0.004026],
    ],
  );
  bin.sink.tick({ feed: 'XAUUSDT', ts: clock.now() - 50, bid: 4003.561, ask: 4003.574, source: 'stream' });
  bin.sink.tick({ feed: 'XAUUSDT', ts: clock.now() - 40, last: 4003.569, source: 'stream' });
  bin.sink.tick({ feed: 'XAUUSDT', ts: clock.now() - 30, bid: 4003.561, ask: 4003.574, source: 'stream' }); // sizes only: no new quote
  // Book first (last falls back to the mid), then a kline close and a size-only book update that change nothing.
  assert.deepEqual(quotes.slice(2).map((q) => [q.symbol, q.bid, q.ask, q.last]), [['XAUUSD', 4003.56, 4003.57, 4003.57]]);
  assert.equal(hub.getQuote('XAUUSD')?.ts, clock.now() - 30);
  await hub.stop();
});

test('delayed feed: detected from tick lag, every timestamp shifted to now, reported in the feed status', async () => {
  const { clock, hub, yah, quotes, candles } = await setup();
  hub.retain('MNQ', 'a');
  hub.retain('NQ', 'a');
  const now = clock.now();
  const tradeTs = now - 600_400; // Yahoo CME: ~10 min late
  yah.sink.tick({ feed: 'NQ=F', ts: tradeTs, last: 25000.3, dayVolume: 1000, source: 'stream' });
  yah.sink.tick({ feed: 'NQ=F', ts: tradeTs + 200, last: 25000.5, dayVolume: 1004, source: 'stream' });
  assert.deepEqual(quotes.map((q) => [q.symbol, q.ts, q.last]), [
    ['MNQ', now - 400, 25000.25],
    ['NQ', now - 400, 25000.25],
    ['MNQ', now - 200, 25000.5],
    ['NQ', now - 200, 25000.5],
  ]);
  const minute = Math.floor(tradeTs / 60_000) * 60;
  assert.deepEqual(candles.at(-1), ['NQ', bar(minute + 600, 25000.25, 25000.5, 25000.25, 25000.5, 4)]);
  clock.advance(100);
  const yahoo = hub.getFeedStatus().find((f) => f.provider === 'yahoo')!;
  assert.equal(yahoo.delaySec, 600);
  assert.match(yahoo.message ?? '', /NQ=F delayed 10 min \(time-shifted\)/);

  // History is requested in feed time and returned shifted.
  yah.historyImpl = async () => [bar(minute - 60, 24999, 25001, 24998, 25000, 10), bar(minute, 25000, 25000.6, 24999.9, 25000.4, 5)];
  const c = await hub.getCandles('MNQ', '1m');
  assert.equal(yah.historyCalls[0].endMs, (Math.floor(clock.now() / 1000) - 600 + 60) * 1000);
  assert.deepEqual(c.map((b) => b.time), [minute - 60 + 600, minute + 600]);
  assert.deepEqual(c[1], bar(minute + 600, 25000, 25000.5, 25000, 25000.5, 5), 'rounded to MNQ ticks');

  const from = clock.now() - 30 * 60_000;
  yah.h1mImpl = async (_r, f) => [bar(Math.floor(f / 60_000) * 60, 1, 1, 1, 1), bar(Math.floor(f / 60_000) * 60 + 60, 2, 2, 2, 2)];
  const h = await hub.getHistory1m('NQ', from, clock.now());
  assert.deepEqual(yah.h1mCalls[0], { feed: 'NQ=F', fromMs: Math.floor((from - 600_000) / 60_000) * 60_000, toMs: clock.now() - 600_000 });
  assert.equal(h[0].time * 1000, Math.floor((from - 600_000) / 60_000) * 60_000 + 600_000);
  await hub.stop();
});

test('closed market: last price kept from the snapshot, off-session ticks ignored, no delay guessed', async () => {
  const { clock, hub, yah, quotes } = await setup(SAT);
  hub.retain('EURUSD', 'a');
  const fridayClose = Date.UTC(2026, 9, 23, 20, 59, 27);
  yah.sink.tick({ feed: 'EURUSD=X', ts: fridayClose, last: 1.1204, refPrice: 1.1222, source: 'seed' });
  assert.deepEqual(quotes.map((q) => [q.symbol, q.bid, q.ask, q.last, q.ts]), [['EURUSD', 1.12037, 1.12043, 1.1204, fridayClose]]);
  yah.sink.tick({ feed: 'EURUSD=X', ts: clock.now() - 1000, last: 1.1301, source: 'stream' }); // weekend noise
  yah.sink.tick({ feed: 'EURUSD=X', ts: fridayClose - 60_000, last: 1.1, source: 'seed' }); // older snapshot
  assert.equal(quotes.length, 1);
  assert.equal(hub.getQuote('EURUSD')?.last, 1.1204);
  clock.advance(60_000);
  assert.equal(quotes.length, 1, 'no synthetic ticks');
  assert.equal(hub.getFeedStatus().find((f) => f.provider === 'yahoo')!.delaySec, 0);
  await hub.stop();
});

test('suspend detector: a 1 s timer firing > 5 s late reports the frozen interval', () => {
  const clock = new ManualClock(WED);
  const seen: Array<[number, number]> = [];
  const d = new SuspendDetector(clock, (a, b) => seen.push([a, b]));
  d.start();
  clock.advance(3000);
  clock.jump(4000); // 5 s between ticks: below the threshold
  clock.advance(1);
  assert.deepEqual(seen, []);
  clock.advance(1000);
  const before = clock.now();
  clock.jump(30_000);
  clock.advance(0);
  assert.deepEqual(seen, [[before - 1, before + 30_000]]); // from the last on-time tick to the late one
  d.stop();
});

test('gaps: suspend and outages > 5 s are reported once after data resumes; short blips ignored', async () => {
  const { clock, hub, bin, gaps } = await setup();
  hub.retain('BTCUSD', 'engine');
  bin.lastMessageAt = clock.now();
  clock.advance(1000);
  const lastTick = clock.now();
  clock.jump(60_000); // laptop asleep
  clock.advance(1000);
  assert.ok(bin.calls.includes('reconnect'), 'sockets recycled after a real suspend');
  assert.equal(gaps.length, 0, 'not before data resumes');
  bin.lastMessageAt = clock.now() + 1;
  clock.advance(1000);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].fromMs, lastTick);
  assert.ok(gaps[0].toMs >= lastTick + 60_000);
  assert.deepEqual(gaps[0].symbols, ['BTCUSD']);
  clock.advance(30_000);
  assert.equal(gaps.length, 1, 'once per gap');

  // WS outage of 8 s.
  const downAt = clock.now() - 200;
  bin.connected = false;
  bin.sink.down(downAt);
  clock.advance(8000);
  assert.equal(gaps.length, 1);
  bin.connected = true;
  bin.lastMessageAt = clock.now();
  clock.advance(1000);
  assert.equal(gaps.length, 2);
  assert.equal(gaps[1].fromMs, downAt);

  // 2 s blip: ignored.
  bin.connected = false;
  bin.sink.down(clock.now());
  clock.advance(2000);
  bin.connected = true;
  bin.lastMessageAt = clock.now();
  clock.advance(1000);
  assert.equal(gaps.length, 2);
  await hub.stop();
});

test('getCandles: shared cache per feed, de-duplicated requests, limit cap, scrollback', async () => {
  const { clock, hub, yah } = await setup();
  const t = Math.floor(clock.now() / 300_000) * 300;
  yah.historyImpl = async (_r, _tf, _end, limit) => {
    await new Promise((r) => setTimeout(r, 5));
    return Array.from({ length: Math.min(limit, 3) }, (_, i) => bar(t - (2 - i) * 300, 25000, 25001, 24999, 25000.5, i));
  };
  const [a, b] = await Promise.all([hub.getCandles('MNQ', '5m'), hub.getCandles('NQ', '5m', { limit: 2 })]);
  assert.equal(yah.historyCalls.length, 1, 'MNQ and NQ share one request');
  assert.equal(a.length, 3);
  assert.deepEqual(b, a.slice(-2));
  await hub.getCandles('MNQ', '5m');
  assert.equal(yah.historyCalls.length, 1, 'served from cache');
  clock.advance(61_000); // 5m "latest" TTL is 60 s
  await hub.getCandles('MNQ', '5m');
  assert.equal(yah.historyCalls.length, 2);
  await hub.getCandles('MNQ', '1h', { limit: 99_999 });
  assert.equal(yah.historyCalls[2].limit, 1500);
  const endSec = t - 86_400;
  await hub.getCandles('MNQ', '5m', { endSec, limit: 50 });
  assert.deepEqual(yah.historyCalls[3], { feed: 'NQ=F', tf: '5m', endMs: endSec * 1000, limit: 50 });
  await hub.getCandles('NQ', '5m', { endSec, limit: 50 });
  assert.equal(yah.historyCalls.length, 4, 'scrollback pages are cached too');
  await assert.rejects(hub.getCandles('NOPE', '1m'), /Unknown symbol/);
  await hub.stop();
});

test('getCandles at "now" includes the forming bar from live data on top of cached history', async () => {
  const { clock, hub, yah } = await setup();
  hub.retain('EURUSD', 'ws:1');
  clock.advance(50_000); // live coverage starts once the provider is connected
  const m = Math.floor(clock.now() / 60_000) * 60;
  yah.historyImpl = async () => [bar(m - 60, 1.1622, 1.1624, 1.1621, 1.1623, 0), bar(m, 1.1623, 1.1623, 1.1622, 1.1622, 0)];
  const first = await hub.getCandles('EURUSD', '1m');
  assert.deepEqual(first.map((b) => b.time), [m - 60, m]);
  // 15 s later (within the 30 s cache TTL) ticks of the next minute arrive through the streamer.
  clock.advance(15_000);
  yah.sink.tick({ feed: 'EURUSD=X', ts: clock.now() - 200, last: 1.16251, source: 'stream' });
  yah.sink.tick({ feed: 'EURUSD=X', ts: clock.now() - 100, last: 1.16262, source: 'stream' });
  const second = await hub.getCandles('EURUSD', '1m');
  assert.equal(yah.historyCalls.length, 1, 'still cached');
  assert.deepEqual(second.at(-1), bar(m + 60, 1.16251, 1.16262, 1.16251, 1.16262, 0));
  const five = await hub.getCandles('EURUSD', '5m');
  assert.equal(five.at(-1)!.close, 1.16262);
  await hub.stop();
});

test('feed status changes are emitted (and only on change)', async () => {
  const { clock, hub, yah, feeds } = await setup();
  const n = feeds.length;
  clock.advance(5000);
  assert.equal(feeds.length, n, 'nothing changed');
  yah.state = 'down';
  yah.connected = false;
  yah.sink.changed();
  clock.advance(100);
  assert.equal(feeds.length, n + 1);
  assert.equal(feeds.at(-1)!.find((f) => f.provider === 'yahoo')!.state, 'down');
  assert.deepEqual(hub.getFeedStatus().map((f) => f.provider), ['binance', 'yahoo']);
  await hub.stop();
  await flush();
});

test('live proxy: delayed futures move with the proxy × the fitted ratio, real-time and unshifted', async () => {
  const { clock, hub, bin, yah, quotes, candles } = await setup(WED, true);
  const now = Math.floor(WED / 60_000) * 60;
  // Delayed NQ history ends 10 min ago; QQQ (the proxy) has every minute. NQ ≈ 45 × QQQ.
  const nq = Array.from({ length: 20 }, (_, i) => bar(now - 1800 + i * 60, 27000 + i * 4.5, 27000 + i * 4.5, 27000 + i * 4.5, 27000 + i * 4.5));
  yah.h1mImpl = async (ref) => (ref.feed === 'NQ=F' ? nq : []);
  yah.historyImpl = async (ref) => (ref.feed === 'NQ=F' ? nq : []);
  bin.h1mImpl = async (ref) => (ref.feed === 'QQQUSDT' ? Array.from({ length: 30 }, (_, i) => bar(now - 1800 + i * 60, 600 + i * 0.1, 600 + i * 0.1, 600 + i * 0.1, 600 + i * 0.1, 99)) : []);
  hub.retain('MNQ', 'ws:1');
  assert.ok(bin.calls.includes('sub:QQQUSDT'), 'the proxy is subscribed with the future');
  clock.advance(1000);
  await flush();
  // Delayed ticks only anchor: no quote from them.
  yah.sink.tick({ feed: 'NQ=F', ts: WED - 600_000, last: 27050, source: 'stream' });
  assert.equal(quotes.filter((q) => q.symbol === 'MNQ').length, 0);
  bin.sink.tick({ feed: 'QQQUSDT', ts: WED + 1000, bid: 603.0, ask: 603.02, source: 'stream' });
  const q = quotes.filter((x) => x.symbol === 'MNQ').at(-1)!;
  assert.ok(q, 'proxy tick quotes MNQ');
  assert.ok(Math.abs(q.last - 603.01 * 45) <= 0.25, `last ${q.last}`);
  assert.equal(q.ts, WED + 1000, 'real-time, not shifted');
  // History: real NQ bars at their real times, then the proxy's minutes scaled, without volume.
  const c = await hub.getCandles('MNQ', '1m', { limit: 100 });
  assert.equal(c[0].time, now - 1800);
  assert.equal(c[0].close, 27000);
  const tail = c.at(-1)!;
  assert.ok(tail.time >= now - 60 && Math.abs(tail.close - 602.9 * 45) <= 0.25 && tail.volume === 0, JSON.stringify(tail));
  // Live proxy bars arrive as MNQ candles.
  bin.sink.bar('QQQUSDT', bar(now, 603, 603.5, 602.5, 603.2, 10), true);
  assert.ok(candles.some(([s, b]) => s === 'MNQ' && b.time === now && Math.abs(b.high - 603.5 * 45) <= 0.25));
  hub.release('MNQ', 'ws:1');
  clock.advance(2000);
  assert.ok(bin.calls.includes('unsub:QQQUSDT'), 'the proxy is released with the future');
});
