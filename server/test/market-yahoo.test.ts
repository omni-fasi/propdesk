import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../../shared/types.ts';
import { ManualClock } from '../src/market/clock.ts';
import type { FetchFn } from '../src/market/http.ts';
import type { FeedRef, FeedTick, ProviderSink } from '../src/market/provider.ts';
import type { SocketLike } from '../src/market/socket.ts';
import { parseChart, YahooHttp, YahooProvider } from '../src/market/yahoo.ts';
import { decodePricingData, decodeStreamerFrame } from '../src/market/yahooProto.ts';

// Real frames captured 2026-10-24 ~05:30 UTC.
const BTC_FRAME = 'CgdCVEMtVVNEFaSKnUcY4P+Yxq1oIgNVU0QqA0NDQzApOAFFogylv0iA4M3AoAFV/VueR10iSZ1HZYC1g8R9/VueR7ABgODNwKAB2AEE4AGA4M3AoAHoAYDgzcCgAfIBA0JUQ4ECAAAAgOQrc0GJAgAAJJ+wl3dC9QKAtYPE/QKiDKW/';
const ETH_FRAME = 'CgdFVEgtVVNEFUhpFEUYkPCYxq1oIgNVU0QqA0NDQzApOAFFciiKv0iAsNC0RFXDFhVFXWwJFEVlgEfPwX00BxVFsAGAsNC0RNgBBOABgLDQtEToAYCw0LRE8gEDRVRIgQIAAADA8x+dQYkCAAA8QAjjUEL1AoBHz8H9AnIoir8=';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const near = (a: number | undefined, b: number, eps = 0.005) => assert.ok(a != null && Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

// Minimal protobuf encoder for synthetic frames.
const varint = (n: number) => {
  const out: number[] = [];
  while (n >= 128) {
    out.push((n % 128) + 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
};
type Field = [number, 'string' | 'float' | 'sint64' | 'int32', string | number];
function encode(fields: Field[]): string {
  const bytes: number[] = [];
  for (const [f, kind, v] of fields) {
    if (kind === 'string') {
      const b = [...Buffer.from(String(v))];
      bytes.push(...varint(f * 8 + 2), ...varint(b.length), ...b);
    } else if (kind === 'float') {
      const b = Buffer.alloc(4);
      b.writeFloatLE(Number(v));
      bytes.push(...varint(f * 8 + 5), ...b);
    } else if (kind === 'sint64') {
      const n = Number(v);
      bytes.push(...varint(f * 8), ...varint(n >= 0 ? n * 2 : -n * 2 - 1));
    } else bytes.push(...varint(f * 8), ...varint(Number(v)));
  }
  return Buffer.from(bytes).toString('base64');
}
const frame = (fields: Field[]) => JSON.stringify({ type: 'pricing', message: encode(fields) });

function chartJson(meta: Record<string, unknown>, rows: Array<[number, number | null, number | null, number | null, number | null, number | null]>) {
  return {
    chart: {
      result: [
        {
          meta,
          timestamp: rows.map((r) => r[0]),
          indicators: { quote: [{ open: rows.map((r) => r[1]), high: rows.map((r) => r[2]), low: rows.map((r) => r[3]), close: rows.map((r) => r[4]), volume: rows.map((r) => r[5]) }] },
        },
      ],
      error: null,
    },
  };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  readonly url: string;
  readonly headers: Record<string, string> | undefined;
  constructor(url: string, headers?: Record<string, string>) {
    this.url = url;
    this.headers = headers;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(text: string) {
    this.onmessage?.({ data: text });
  }
  send(data: string) {
    this.sent.push(data);
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

const WED = Date.UTC(2026, 9, 21, 15, 0); // Wed 11:00 ET: CME and FX open
const SAT = Date.UTC(2026, 9, 24, 6, 0); // Saturday: both closed
const NQ: FeedRef = { feed: 'NQ=F', session: 'cme', dayRule: { hour: 17, minute: 0, tz: 'America/New_York' } };
const EUR: FeedRef = { feed: 'EURUSD=X', session: 'fx', dayRule: { hour: 0, minute: 0, tz: 'Europe/London' } };

function setup(start: number, fetchImpl: FetchFn) {
  const clock = new ManualClock(start);
  const sockets: FakeSocket[] = [];
  const ticks: FeedTick[] = [];
  const bars: Array<{ feed: string; bar: Candle; live: boolean }> = [];
  const downs: number[] = [];
  const sink: ProviderSink = { tick: (t) => ticks.push(t), bar: (feed, bar, live) => bars.push({ feed, bar, live }), changed() {}, down: (s) => downs.push(s) };
  const yp = new YahooProvider(sink, {
    clock,
    log: quiet,
    fetch: fetchImpl,
    socketFactory: (url, headers) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    },
    profiles: ['plain'],
    requestSpacingMs: 0,
    random: () => 0.5,
  });
  return { clock, sockets, ticks, bars, downs, yp };
}

test('decodes the captured BTC-USD and ETH-USD PricingData frames', () => {
  const btc = decodeStreamerFrame(JSON.stringify({ type: 'pricing', message: BTC_FRAME }))!;
  assert.equal(btc.id, 'BTC-USD');
  near(btc.price, 80661.28);
  assert.equal(btc.time, 1792819798000); // zigzag sint64 ms
  assert.equal(new Date(btc.time!).toISOString(), '2026-10-24T05:29:58.000Z');
  assert.equal(btc.currency, 'USD');
  assert.equal(btc.exchange, 'CCC');
  assert.equal(btc.quoteType, 41); // plain int32 varint (CRYPTOCURRENCY)
  assert.equal(btc.marketHours, 1);
  near(btc.changePercent, -1.28945, 1e-4);
  assert.equal(btc.dayVolume, 21542582272);
  near(btc.dayHigh, 81079.98);
  near(btc.dayLow, 80530.27);
  near(btc.change, -1053.67);
  near(btc.openPrice, 81079.98);
  assert.equal(btc.priceHint, 2);
  assert.equal(btc.fromCurrency, 'BTC');
  assert.equal(btc.circulatingSupply, 20102728);
  near(btc.price! - btc.change!, 81714.95, 0.01); // previous close

  const eth = decodeStreamerFrame(ETH_FRAME)!; // bare base64 (version 1 framing)
  assert.equal(eth.id, 'ETH-USD');
  near(eth.price, 2374.58);
  assert.equal(eth.time, 1792819797000);
  assert.equal(eth.dayVolume, 9181989888);
  near(eth.change, -25.91);
  near(eth.dayHigh, 2385.42);
  assert.equal(eth.exchange, 'CCC');
});

test('decoder: bid/ask, negative zigzag, unknown fields, wrong wire types, junk', () => {
  const d = decodeStreamerFrame(
    frame([
      [1, 'string', 'EURUSD=X'],
      [2, 'float', 1.16234],
      [3, 'sint64', 1792819798000],
      [12, 'float', -0.0012],
      [14, 'sint64', -42],
      [23, 'float', 1.16231],
      [25, 'float', 1.16237],
      [40, 'int32', 7], // unknown field
      [8, 'int32', 3], // changePercent with a varint wire type: skipped, not misread
    ]),
  )!;
  assert.equal(d.id, 'EURUSD=X');
  near(d.price, 1.16234, 1e-6);
  near(d.bid, 1.16231, 1e-6);
  near(d.ask, 1.16237, 1e-6);
  assert.equal(d.expireDate, -42);
  assert.equal(d.changePercent, undefined);
  assert.equal(decodeStreamerFrame('{"type":"heartbeat"}'), null);
  assert.throws(() => decodePricingData(Buffer.from([0x0a, 0x10, 0x41])), /truncated/);
  assert.throws(() => decodePricingData(Buffer.from(encode([[2, 'float', 1]]), 'base64')), /without id/);
});

test('parseChart: skips nulls, merges the unaligned live row, drops rows past the window', () => {
  const t = Date.UTC(2026, 9, 21, 14, 0) / 1000;
  const data = parseChart(
    chartJson({ regularMarketPrice: 101, regularMarketTime: t + 77 }, [
      [t, 100, 100.5, 99.5, 100.25, 0],
      [t + 60, null, null, null, null, null],
      [t + 77, 100.5, 100.5, 100.5, 101, 0], // live point, floored into the 14:01 bar
      [t + 120, 101, 100.9, 101, 101.2, 50], // high below close: sanitized
      [t + 7200, 1, 1, 1, 1, 1], // past period2 (Yahoo appends the live price): dropped
    ]),
    60,
    { toSec: t + 3600 },
  );
  assert.equal(data.meta.regularMarketPrice, 101);
  assert.deepEqual(data.bars, [
    { time: t, open: 100, high: 100.5, low: 99.5, close: 100.25, volume: 0 },
    { time: t + 60, open: 100.5, high: 101, low: 100.5, close: 101, volume: 0 },
    { time: t + 120, open: 101, high: 101.2, low: 101, close: 101.2, volume: 50 },
  ]);
});

test('parseChart: daily bars normalized to the trading day (EURUSD London, NQ=F CME) and duplicates merged', () => {
  // Real EURUSD=X 1d rows: bars at 23:00Z (London midnight, BST) plus a live row for the same Friday.
  const eur = parseChart(
    chartJson({}, [
      [Date.parse('2026-10-21T23:00:00Z') / 1000, 1.12336, 1.12575, 1.11906, 1.12347, 0],
      [Date.parse('2026-10-22T23:00:00Z') / 1000, 1.12216, 1.12265, 1.11871, 1.12215, 0],
      [Date.parse('2026-10-23T21:29:27Z') / 1000, 1.12221, 1.12296, 1.11894, 1.12045, 0],
    ]),
    86400,
    { dayRule: EUR.dayRule },
  );
  assert.deepEqual(eur.bars, [
    { time: Date.UTC(2026, 9, 22) / 1000, open: 1.12336, high: 1.12575, low: 1.11906, close: 1.12347, volume: 0 },
    { time: Date.UTC(2026, 9, 23) / 1000, open: 1.12216, high: 1.12296, low: 1.11871, close: 1.12045, volume: 0 },
  ]);
  const nq = parseChart(chartJson({}, [[Date.parse('2026-10-23T04:00:00Z') / 1000, 29116.5, 29326, 28987, 29117.75, 855326]]), 86400, { dayRule: NQ.dayRule });
  assert.equal(nq.bars[0].time, Date.UTC(2026, 9, 23) / 1000);
  assert.throws(() => parseChart({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }, 60), /No data found/);
});

test('streamer: subscribe/unsubscribe messages, headers, ticks, reconnect + resubscribe', async () => {
  const { clock, sockets, ticks, downs, yp } = setup(WED, async () => json(chartJson({}, [])));
  yp.start();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, 'wss://streamer.finance.yahoo.com/?version=2');
  assert.equal(sockets[0].headers?.Origin, 'https://finance.yahoo.com');
  assert.match(sockets[0].headers?.['User-Agent'] ?? '', /Mozilla/);
  yp.subscribe(NQ);
  clock.advance(100);
  assert.deepEqual(sockets[0].sent, []); // not open yet
  sockets[0].open();
  assert.deepEqual(sockets[0].sent.map((s) => JSON.parse(s)), [{ subscribe: ['NQ=F'] }]);
  yp.subscribe(EUR);
  clock.advance(60);
  assert.deepEqual(JSON.parse(sockets[0].sent[1]), { subscribe: ['EURUSD=X'] });

  const tradeTime = WED - 600_000; // CME data ~10 min delayed
  sockets[0].receive(frame([[1, 'string', 'NQ=F'], [2, 'float', 25000.25], [3, 'sint64', tradeTime], [9, 'sint64', 123456], [12, 'float', 10]]));
  assert.deepEqual(ticks, [{ feed: 'NQ=F', ts: tradeTime, last: 25000.25, dayVolume: 123456, refPrice: 24990.25, source: 'stream' }]);
  sockets[0].receive(frame([[1, 'string', 'ES=F'], [2, 'float', 6800], [3, 'sint64', tradeTime]])); // not subscribed
  assert.equal(ticks.length, 1);

  yp.unsubscribe('EURUSD=X');
  clock.advance(60);
  assert.deepEqual(JSON.parse(sockets[0].sent[2]), { unsubscribe: ['EURUSD=X'] });

  clock.advance(2000);
  sockets[0].close(1006);
  assert.equal(downs.length, 1); // market open: data stopped at the last message
  assert.equal(downs[0], WED + 160);
  clock.advance(1100); // backoff 1 s
  assert.equal(sockets.length, 2);
  sockets[1].open();
  assert.deepEqual(JSON.parse(sockets[1].sent[0]), { subscribe: ['NQ=F'] });
  yp.stop();
});

test('polling fallback while the streamer is silent for an open market, stops when data resumes', async () => {
  const calls: string[] = [];
  const nowSec = () => Math.floor(clock.now() / 1000);
  const fetchImpl: FetchFn = async (url) => {
    calls.push(url);
    const t = nowSec() - 30;
    return json(chartJson({ regularMarketPrice: 1.1622, regularMarketTime: t, previousClose: 1.16 }, [[Math.floor(t / 60) * 60, 1.1621, 1.1623, 1.162, 1.1622, 0]]));
  };
  const { clock, sockets, ticks, bars, yp } = setup(WED, fetchImpl);
  yp.start();
  sockets[0].open();
  yp.subscribe(EUR);
  clock.advance(10_000);
  assert.equal(calls.length, 0);
  clock.advance(7_000); // > 15 s silent
  await flush();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /EURUSD%3DX\?range=1d&interval=1m/);
  assert.equal(ticks.at(-1)?.source, 'poll');
  assert.equal(ticks.at(-1)?.last, 1.1622);
  assert.equal(ticks.at(-1)?.refPrice, 1.16);
  assert.equal(bars.at(-1)?.live, true);
  assert.equal(yp.status().state, 'degraded');
  clock.advance(4_100);
  await flush();
  assert.equal(calls.length, 2);
  sockets[0].receive(frame([[1, 'string', 'EURUSD=X'], [2, 'float', 1.1623], [3, 'sint64', clock.now() - 500]]));
  assert.equal(yp.status().state, 'live');
  clock.advance(12_000);
  await flush();
  assert.equal(calls.length, 2, 'no polling once the stream is back');
  yp.stop();
});

test('no polling and no synthetic ticks while the market is closed', async () => {
  const calls: string[] = [];
  const { clock, sockets, ticks, yp } = setup(SAT, async (url) => {
    calls.push(url);
    return json(chartJson({}, []));
  });
  yp.start();
  sockets[0].open();
  yp.subscribe(NQ);
  yp.subscribe(EUR);
  clock.advance(120_000);
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(ticks.length, 0);
  assert.equal(sockets.length, 1, 'a quiet socket is not recycled while markets are closed');
  assert.match(yp.status().message, /markets closed/);
  yp.stop();
});

test('YahooHttp: a 429 cools the browser profile down and falls back to plain headers', async () => {
  const clock = new ManualClock(WED);
  const log: Array<{ url: string; ua: string | null; cookie: string | null }> = [];
  const fetchImpl: FetchFn = async (url, init) => {
    const h = new Headers(init?.headers);
    log.push({ url, ua: h.get('user-agent'), cookie: h.get('cookie') });
    if (url.startsWith('https://fc.yahoo.com')) return new Response(null, { status: 404, headers: { 'set-cookie': 'A3=d=abc; Domain=.yahoo.com; Path=/' } });
    if (h.get('user-agent')) return new Response('Too Many Requests', { status: 429 });
    return json(chartJson({ regularMarketPrice: 1 }, []));
  };
  const http = new YahooHttp({ fetch: fetchImpl, clock, log: quiet, signal: new AbortController().signal, spacingMs: 0 });
  const res = (await http.chart('NQ=F', { range: '1d', interval: '1m' })) as { chart: { result: unknown[] } };
  assert.equal(res.chart.result.length, 1);
  assert.deepEqual(
    log.map((l) => [l.url.split('?')[0], l.ua != null, l.cookie]),
    [
      ['https://fc.yahoo.com/', true, null],
      ['https://query1.finance.yahoo.com/v8/finance/chart/NQ%3DF', true, 'A3=d=abc'],
      ['https://query1.finance.yahoo.com/v8/finance/chart/NQ%3DF', false, null],
    ],
  );
  await http.chart('NQ=F', { range: '1d', interval: '1m' });
  assert.equal(log.length, 4, 'second request goes straight to the working profile');
  assert.equal(log[3].ua, null);
});

test('history: 4h aggregated from 60m, 1m history paged in 7-day windows', async () => {
  const calls: URL[] = [];
  const fetchImpl: FetchFn = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const p1 = Number(u.searchParams.get('period1'));
    const p2 = Number(u.searchParams.get('period2'));
    const step = u.searchParams.get('interval') === '60m' ? 3600 : 60;
    const rows: Array<[number, number, number, number, number, number]> = [];
    // Only the last 9 hours / a few minutes per window have data.
    const from = Math.max(p1, p2 - (step === 3600 ? 9 * 3600 : 300));
    for (let t = Math.ceil(from / step) * step; t < p2; t += step) rows.push([t, 100, 101, 99, 100.5, 10]);
    return json(chartJson({}, rows));
  };
  const { clock, yp } = setup(WED, fetchImpl);
  const end = WED + 3600_000;
  const fourH = await yp.history(NQ, '4h', end, 2);
  assert.equal(calls[0].searchParams.get('interval'), '60m');
  assert.equal(fourH.length, 2);
  assert.deepEqual(fourH.map((b) => [new Date(b.time * 1000).toISOString().slice(11, 16), b.volume]), [
    ['08:00', 40],
    ['12:00', 40],
  ]);
  calls.length = 0;
  const h = await yp.history1m(NQ, clock.now() - 10 * 86_400_000, clock.now());
  assert.equal(calls.length, 2);
  for (const u of calls) assert.ok(Number(u.searchParams.get('period2')) - Number(u.searchParams.get('period1')) <= 7 * 86400);
  assert.ok(h.length > 0 && h.every((b, i) => i === 0 || b.time > h[i - 1].time));
});
