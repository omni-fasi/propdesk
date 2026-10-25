import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage } from '../../shared/api.ts';
import { INSTRUMENTS } from '../../shared/instruments.ts';
import { createFakeMarketHub } from '../src/market/fake.ts';
import { silentLogger } from '../src/log.ts';
import { startServer } from '../src/server.ts';
import { tempDir } from './helpers.ts';

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 3000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 15));
  }
}

test('REST + WebSocket smoke test on a real server', async () => {
  const tmp = tempDir();
  const market = createFakeMarketHub({ instruments: INSTRUMENTS });
  const srv = await startServer({ port: 0, dataDir: tmp.dir, market, log: silentLogger, staticDir: null, detectSuspend: false });
  const base = `${srv.url}/api`;
  const call = async (method: string, path: string, body?: unknown, raw?: string) => {
    const res = await fetch(base + path, {
      method,
      headers: body !== undefined || raw ? { 'content-type': 'application/json' } : {},
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const msgs: ServerMessage[] = [];
  const ws = new WebSocket(`${srv.url.replace('http', 'ws')}/ws`);
  ws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)) as ServerMessage);
  try {
    let r = await call('GET', '/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);

    r = await call('GET', '/bootstrap');
    assert.equal(r.status, 200);
    for (const k of ['serverTime', 'version', 'localTz', 'settings', 'instruments', 'presets', 'accounts', 'snapshots', 'positions', 'orders', 'openTrades', 'events', 'wallet', 'feeds', 'quotes']) {
      assert.ok(k in r.body, k);
    }
    assert.equal(r.body.instruments.length, INSTRUMENTS.length);

    await waitFor(() => msgs.find((m) => m.type === 'hello'));
    ws.send(JSON.stringify({ type: 'subscribe', symbols: ['BTCUSD', 'NOPE'] }));
    ws.send(JSON.stringify({ type: 'chart', symbol: 'BTCUSD' }));
    await waitFor(() => market.retained().includes('BTCUSD'));
    market.push('BTCUSD', { bid: 80000, ask: 80000.1, last: 80000 });
    const qm = await waitFor(() => msgs.find((m) => m.type === 'quotes'));
    assert.equal(qm.type === 'quotes' && qm.quotes[0].symbol, 'BTCUSD');
    await waitFor(() => msgs.find((m) => m.type === 'candle'));

    // errors are {error, code}
    r = await call('POST', '/accounts', { kind: 'nope' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'invalid');
    r = await call('POST', '/orders', undefined, '{not json');
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'invalid');
    r = await call('GET', '/nope');
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'not_found');
    r = await call('DELETE', '/orders/missing');
    assert.equal(r.status, 404);

    r = await call('POST', '/accounts', { kind: 'evaluation', presetId: 'allday-1step-25k' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'insufficient_funds');
    r = await call('POST', '/wallet/deposit', { amount: 500 });
    assert.equal(r.body.summary.balance, 500);
    r = await call('POST', '/accounts', { kind: 'evaluation', presetId: 'allday-1step-25k' });
    assert.equal(r.status, 200);
    const id: string = r.body.id;
    await waitFor(() => msgs.find((m) => m.type === 'wallet'));

    r = await call('POST', '/orders', { accountId: id, symbol: 'BTCUSD', side: 'buy', type: 'market', qty: 0.01, sl: 79000, tags: { mood: 'calm' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'filled');
    await waitFor(() => msgs.find((m) => m.type === 'fill'));
    await waitFor(() => msgs.find((m) => m.type === 'position'));
    await waitFor(() => msgs.find((m) => m.type === 'snapshot' && m.snapshot.accountId === id));
    r = await call('POST', '/orders', { accountId: id, symbol: 'MNQ', side: 'buy', type: 'market', qty: 1 });
    assert.equal(r.body.code, 'rule_violation');

    r = await call('PATCH', '/positions/bracket', { accountId: id, symbol: 'BTCUSD', tp: 81000 });
    assert.equal(r.body.length, 1);
    assert.equal(r.body[0].tp, 81000);
    assert.equal(r.body[0].sl, 79000);
    r = await call('GET', '/trades?status=open');
    assert.equal(r.body.length, 1);
    r = await call('POST', '/positions/close', { accountId: id, symbol: 'BTCUSD' });
    assert.deepEqual(r.body, { ok: true });
    r = await call('GET', `/trades?accountId=${id}`);
    assert.equal(r.body.length, 1);
    const tradeId: string = r.body[0].id;
    assert.equal(r.body[0].tags.mood, 'calm');
    r = await call('PATCH', `/trades/${tradeId}`, { review: { followedPlan: true, rating: 5, mistakes: [], moodAfter: 'calm', note: null } });
    assert.equal(r.body.review.rating, 5);
    await waitFor(() => msgs.find((m) => m.type === 'trade' && m.trade.review?.rating === 5));
    r = await call('GET', `/trades/${tradeId}`);
    assert.equal(r.body.id, tradeId);
    assert.equal((await call('GET', '/trades/missing')).status, 404);
    r = await call('GET', '/fills?limit=1');
    assert.equal(r.body.length, 1);
    r = await call('GET', `/daily?accountId=${id}&from=2000-01-01&to=2100-01-01`);
    assert.equal(r.body.length, 1);
    assert.equal(r.body[0].fills, 2);
    r = await call('GET', `/equity?accountId=${id}`);
    assert.ok(r.body.length >= 2);
    assert.equal((await call('GET', '/equity')).status, 400);
    r = await call('GET', '/events?limit=50');
    assert.ok(r.body.some((e: { kind: string }) => e.kind === 'account_created'));
    r = await call('GET', '/candles?symbol=BTCUSD&tf=5m&limit=10');
    assert.equal(r.body.length, 10);
    r = await call('GET', `/candles?symbol=BTCUSD&end=${Math.floor(Date.now() / 1000) + 600}&limit=3`);
    assert.equal(r.status, 200);
    assert.equal((await call('GET', '/candles?symbol=NOPE')).status, 400);
    assert.equal((await call('GET', '/quotes')).body[0].symbol, 'BTCUSD');

    r = await call('PUT', '/settings', { tilt: { maxConsecutiveLosses: 5 }, volume: 0.3, bogus: 1 });
    assert.equal(r.body.tilt.maxConsecutiveLosses, 5);
    assert.equal(r.body.tilt.enabled, true); // deep merge keeps the rest
    assert.equal(r.body.volume, 0.3);
    await waitFor(() => msgs.find((m) => m.type === 'settings'));
    assert.equal((await call('PUT', '/settings', { volume: 3 })).status, 400);
    r = await call('PUT', '/settings', { fillSound: 'alarm_clock', alertSound: null });
    assert.equal(r.body.fillSound, 'alarm_clock');
    assert.equal(r.body.alertSound, null);
    assert.equal((await call('PUT', '/settings', { fillSound: 'mt5-click' })).status, 400);
    assert.equal((await call('PUT', '/settings', { alertSound: 'order_filled' })).status, 400); // alerts: TradingView sounds only

    r = await call('PUT', '/notes/2026-10-24', { text: 'Stayed patient', accountId: null, mood: 'calm' });
    assert.equal(r.body.accountId, null);
    r = await call('GET', '/notes?from=2026-10-01&to=2026-10-31');
    assert.equal(r.body.length, 1);
    assert.equal((await call('PUT', '/notes/2026-13-01', { text: 'x' })).status, 400);

    r = await call('POST', `/accounts/${id}/break`, { minutes: 10 });
    assert.equal(r.body.lock.reason, 'break');
    r = await call('POST', '/orders', { accountId: id, symbol: 'BTCUSD', side: 'buy', type: 'market', qty: 0.01 });
    assert.equal(r.body.code, 'locked');
    assert.equal((await call('GET', `/accounts/${id}/payout-eligibility`)).body.eligible, false);
    r = await call('PATCH', `/accounts/${id}`, { name: 'My 25K' });
    assert.equal(r.body.name, 'My 25K');

    ws.send(JSON.stringify({ type: 'ping', t: 42 }));
    const pong = await waitFor(() => msgs.find((m) => m.type === 'pong'));
    assert.equal(pong.type === 'pong' && pong.t, 42);
  } finally {
    ws.close();
    await srv.close();
    tmp.cleanup();
  }
  assert.equal(market.retained().length, 0); // ws:<id> and engine retentions released
});

test('serves the built web app with SPA fallback, without shadowing /api', async () => {
  const tmp = tempDir();
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const web = join(tmp.dir, 'dist');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>PropDesk</title>');
  writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1)');
  const market = createFakeMarketHub({ instruments: INSTRUMENTS });
  const srv = await startServer({ port: 0, dataDir: ':memory:', market, log: silentLogger, staticDir: web, detectSuspend: false });
  try {
    const get = (p: string) => fetch(srv.url + p);
    let res = await get('/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    res = await get('/trade/MNQ'); // client-side route
    assert.match(await res.text(), /PropDesk/);
    res = await get('/assets/app.js');
    assert.match(res.headers.get('content-type') ?? '', /javascript/);
    assert.match(res.headers.get('cache-control') ?? '', /immutable/);
    assert.equal((await get('/assets/missing.js')).status, 404);
    assert.equal((await get('/../../etc/passwd')).status, 200); // normalized by the URL parser → SPA index, never outside root
    res = await get('/api/health');
    assert.equal(((await res.json()) as { ok: boolean }).ok, true);
    assert.equal((await get('/api/nothing')).status, 404);
  } finally {
    await srv.close();
    tmp.cleanup();
  }
});
