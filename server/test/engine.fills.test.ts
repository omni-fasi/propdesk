import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectCode, MIN, c2 } from './helpers.ts';

test('market orders fill at ask / bid with per-contract commission; marks long at bid', async () => {
  const h = await setup();
  const id = h.practice();
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  const o = h.order(id, { symbol: 'MNQ', side: 'buy', qty: 2 });
  assert.equal(o.status, 'filled');
  assert.equal(o.fillPrice, 25000.25);
  const pos = h.engine.bootstrap().positions[0];
  assert.equal(pos.qty, 2);
  assert.equal(pos.avgPrice, 25000.25);
  assert.equal(pos.markPrice, 25000); // long marked at the bid
  assert.equal(pos.openPnl, -1); // (25000 − 25000.25) × 2 × $2
  let s = h.engine.snapshot(id)!;
  assert.equal(s.balance, 49998.76); // 2 × $0.62
  assert.equal(s.equity, 49997.76);

  h.quote('MNQ', 25010, 25010.25, 25010);
  s = h.engine.snapshot(id)!;
  assert.equal(s.openPnl, 39);
  h.order(id, { symbol: 'MNQ', side: 'sell', qty: 2 });
  s = h.engine.snapshot(id)!;
  assert.equal(s.balance, 50036.52); // +39 − 1.24 − 1.24
  assert.equal(s.openPnl, 0);
  assert.equal(h.engine.bootstrap().positions.length, 0);
  const [tr] = h.engine.listTrades({ status: 'closed', limit: 10, offset: 0 });
  assert.equal(tr.direction, 'long');
  assert.equal(tr.grossPnl, 39);
  assert.equal(tr.fees, 2.48);
  assert.equal(tr.netPnl, 36.52);
  assert.equal(tr.exitReason, 'manual');
  assert.equal(tr.avgEntry, 25000.25);
  assert.equal(tr.avgExit, 25010);
  const fills = h.engine.listFills({ limit: 10 });
  assert.equal(fills.length, 2);
  assert.ok(fills.every((f) => f.fee === 1.24 && f.liquidity === 'taker'));
  h.close();
});

test('percent commission: taker on market, maker on resting limits; shorts marked at ask', async () => {
  const h = await setup();
  const id = h.practice(100_000);
  h.quote('BTCUSD', 80000, 80000.1);
  h.order(id, { symbol: 'BTCUSD', side: 'sell', qty: 0.5 });
  let pos = h.engine.bootstrap().positions[0];
  assert.equal(pos.qty, -0.5);
  assert.equal(pos.avgPrice, 80000);
  assert.equal(pos.markPrice, 80000.1); // short marked at the ask
  assert.equal(h.engine.snapshot(id)!.balance, 100_000 - 20); // 0.5 × 80000 × 0.05%

  // Resting buy limit fills at the limit price (maker) once the ask trades down to it.
  const lim = h.order(id, { symbol: 'BTCUSD', side: 'buy', type: 'limit', price: 79900, qty: 0.5 });
  assert.equal(lim.status, 'working');
  assert.equal(lim.reduceOnly, true); // reduces the short
  h.quote('BTCUSD', 79905, 79905.1);
  assert.equal(h.engine.bootstrap().orders.length, 1);
  h.quote('BTCUSD', 79850, 79850.1); // ask through the limit
  assert.equal(h.engine.bootstrap().orders.length, 0);
  const fills = h.engine.listFills({ limit: 10 });
  assert.equal(fills[0].price, 79900);
  assert.equal(fills[0].liquidity, 'maker');
  assert.equal(fills[0].fee, 7.99); // 0.5 × 79900 × 0.02%
  assert.equal(fills[0].realizedPnl, 50); // (80000 − 79900) × 0.5
  const [tr] = h.engine.listTrades({ status: 'closed', limit: 5, offset: 0 });
  assert.equal(tr.exitReason, 'limit');
  assert.equal(tr.netPnl, c2(50 - 20 - 7.99));
  h.close();
});

test('marketable limit fills immediately at the touch as taker', async () => {
  const h = await setup();
  const id = h.practice(100_000);
  h.quote('BTCUSD', 80000, 80000.1);
  const o = h.order(id, { symbol: 'BTCUSD', side: 'buy', type: 'limit', price: 80100, qty: 0.1 });
  assert.equal(o.status, 'filled');
  assert.equal(o.type, 'limit');
  assert.equal(o.price, 80100);
  assert.equal(o.fillPrice, 80000.1);
  assert.equal(h.engine.listFills({ limit: 1 })[0].liquidity, 'taker');
  h.close();
});

test("stop orders: bidask triggers on ask, fills at the current price (slippage)", async () => {
  const h = await setup();
  const id = h.practice(100_000);
  h.quote('BTCUSD', 80000, 80000.1);
  expectCode(() => h.order(id, { symbol: 'BTCUSD', side: 'buy', type: 'stop', price: 79000, qty: 0.1 }), 'invalid', /above the current price/);
  const o = h.order(id, { symbol: 'BTCUSD', side: 'buy', type: 'stop', price: 80500, qty: 0.1 });
  assert.equal(o.status, 'working');
  h.quote('BTCUSD', 80400, 80499.9);
  assert.equal(h.engine.bootstrap().orders.length, 1);
  h.quote('BTCUSD', 80600, 80600.5); // gap through the stop
  const pos = h.engine.bootstrap().positions[0];
  assert.equal(pos.avgPrice, 80600.5);
  assert.equal(h.engine.listFills({ limit: 1 })[0].liquidity, 'taker');
  h.close();
});

test("'last' model: stops trigger on the trade price, limits need a trade-through or 3 s at the price", async () => {
  const h = await setup();
  const id = h.practice();
  h.quote('MNQ', 25000, 25000.25, 25000);
  const stop = h.order(id, { symbol: 'MNQ', side: 'buy', type: 'stop', price: 25010, qty: 1 });
  h.quote('MNQ', 25009.75, 25010, 25009.75); // ask at the stop but last below → no trigger
  assert.equal(h.engine.bootstrap().orders.find((o) => o.id === stop.id)?.status, 'working');
  h.quote('MNQ', 25010, 25010.25, 25010.25);
  assert.equal(h.engine.bootstrap().positions[0].avgPrice, 25010.25); // filled at the ask after the trigger

  // Sell limit above the market (reduce-only exit).
  const lim = h.order(id, { symbol: 'MNQ', side: 'sell', type: 'limit', price: 25020, qty: 1 });
  h.quote('MNQ', 25020, 25020.25, 25020); // touch
  h.clock.t += 2_000;
  h.quote('MNQ', 25020, 25020.25, 25020); // 2 s at the price — not yet
  assert.equal(h.engine.bootstrap().orders.length, 1);
  h.clock.t += 1_500;
  h.quote('MNQ', 25020, 25020.25, 25020); // 3.5 s at the price → fills at the limit
  assert.equal(h.engine.bootstrap().orders.length, 0);
  assert.equal(h.engine.bootstrap().positions.length, 0);
  const fill = h.engine.listFills({ limit: 1 })[0];
  assert.equal(fill.orderId, lim.id);
  assert.equal(fill.price, 25020);
  assert.equal(fill.liquidity, 'maker');

  // Trade-through fills immediately.
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 1 });
  h.order(id, { symbol: 'MNQ', side: 'sell', type: 'limit', price: 25030, qty: 1 });
  h.quote('MNQ', 25030.25, 25030.5, 25030.25);
  assert.equal(h.engine.bootstrap().positions.length, 0);
  h.close();
});

test('every entry opens its own position; orders the other way close the oldest first, one fill per position', async () => {
  const h = await setup();
  const id = h.practice();
  h.quote('MES', 6800, 6800.25, 6800.25);
  h.order(id, { symbol: 'MES', side: 'buy', qty: 1 });
  h.quote('MES', 6810, 6810.25, 6810.25);
  h.order(id, { symbol: 'MES', side: 'buy', qty: 3 });
  let positions = h.engine.bootstrap().positions;
  assert.deepEqual(
    positions.map((p) => [p.qty, p.avgPrice]),
    [
      [1, 6800.25],
      [3, 6810.25],
    ],
  );
  assert.equal(h.engine.bootstrap().openTrades.length, 2);
  assert.notEqual(positions[0].tradeId, positions[1].tradeId);
  let s = h.engine.snapshot(id)!;
  assert.equal(s.contracts, 0.4); // 4 micros, summed over both positions

  // Sell 2: closes the oldest position (1) and 1 of the second.
  h.quote('MES', 6820, 6820.25, 6820);
  const sell = h.order(id, { symbol: 'MES', side: 'sell', qty: 2 });
  assert.equal(sell.role, 'exit');
  positions = h.engine.bootstrap().positions;
  assert.deepEqual(
    positions.map((p) => [p.qty, p.avgPrice]),
    [[2, 6810.25]],
  );
  const fills = h.engine.listFills({ limit: 2 });
  assert.ok(fills.every((f) => f.orderId === sell.id && f.qty === 1));
  assert.equal(c2(fills[0].realizedPnl + fills[1].realizedPnl), c2((6820 - 6800.25) * 5 + (6820 - 6810.25) * 5));
  assert.equal(c2(fills[0].fee + fills[1].fee), 1.24);
  const [first] = h.engine.listTrades({ status: 'closed', limit: 5, offset: 0 });
  assert.equal(first.avgEntry, 6800.25);
  assert.equal(first.exitReason, 'manual');
  const open = h.engine.bootstrap().openTrades[0];
  assert.equal(open.entryQty, 3);
  assert.equal(open.exitQty, 1);
  s = h.engine.snapshot(id)!;
  assert.equal(s.dayTrades, 1);

  // Flip: sell 5 against the long 2 → closes it and opens a short 3 at the fill price.
  h.order(id, { symbol: 'MES', side: 'sell', qty: 5 });
  positions = h.engine.bootstrap().positions;
  assert.equal(positions.length, 1);
  assert.equal(positions[0].qty, -3);
  assert.equal(positions[0].avgPrice, 6820);
  const flip = h.engine.listFills({ limit: 2 });
  const closing = flip.find((f) => f.realizedPnl !== 0)!;
  const opening = flip.find((f) => f.realizedPnl === 0)!;
  assert.equal(closing.qty, 2);
  assert.equal(opening.qty, 3);
  assert.equal(c2(closing.fee + opening.fee), 3.1); // 5 × 0.62 split 2/3
  assert.notEqual(closing.tradeId, opening.tradeId);
  const [closed] = h.engine.listTrades({ status: 'closed', limit: 5, offset: 0 });
  assert.equal(closed.exitReason, 'reversal');
  assert.equal(closed.entryQty, 3);
  assert.equal(closed.exitQty, 3);
  const [short] = h.engine.listTrades({ status: 'open', limit: 5, offset: 0 });
  assert.equal(short.direction, 'short');
  assert.equal(short.entryQty, 3);
  h.close();
});

test('three sells with their own brackets stay three positions (they used to merge into one)', async () => {
  const h = await setup();
  const id = h.practice();
  h.quote('SOLUSD', 102.4, 102.41);
  h.order(id, { symbol: 'SOLUSD', side: 'sell', qty: 100, sl: 102.69, tp: 101.65 });
  h.quote('SOLUSD', 102.47, 102.48);
  h.order(id, { symbol: 'SOLUSD', side: 'sell', qty: 100, sl: 102.76, tp: 101.72 });
  h.quote('SOLUSD', 102.43, 102.44);
  h.order(id, { symbol: 'SOLUSD', side: 'sell', qty: 100, sl: 102.72, tp: 101.68 });
  const positions = h.engine.bootstrap().positions;
  assert.deepEqual(
    positions.map((p) => [p.qty, p.avgPrice, p.sl, p.tp]),
    [
      [-100, 102.4, 102.69, 101.65],
      [-100, 102.47, 102.76, 101.72],
      [-100, 102.43, 102.72, 101.68],
    ],
  );
  // 102.70 on the ask: only the first position's stop (102.69) triggers.
  h.quote('SOLUSD', 102.69, 102.7);
  assert.deepEqual(
    h.engine.bootstrap().positions.map((p) => p.avgPrice),
    [102.47, 102.43],
  );
  const [stopped] = h.engine.listTrades({ status: 'closed', limit: 5, offset: 0 });
  assert.equal(stopped.avgEntry, 102.4);
  assert.equal(stopped.exitReason, 'stop_loss');
  assert.equal(stopped.grossPnl, -30);
  // 101.68 on the ask: the third position's target (101.68) and the second's (101.72) fill; nothing left.
  h.quote('SOLUSD', 101.67, 101.68);
  assert.equal(h.engine.bootstrap().positions.length, 0);
  const targets = h.engine.listFills({ limit: 2 });
  assert.deepEqual(targets.map((f) => [f.role, f.price]).sort(), [
    ['take_profit', 101.68],
    ['take_profit', 101.72],
  ]);
  h.close();
});

test('closing one position by id leaves the others; flatten closes all of them in one execution', async () => {
  const h = await setup();
  const id = h.practice(100_000);
  h.quote('SOLUSD', 100, 100.01);
  h.order(id, { symbol: 'SOLUSD', side: 'sell', qty: 10, sl: 101, tp: 98 });
  h.order(id, { symbol: 'SOLUSD', side: 'sell', qty: 20, sl: 101.5, tp: 97 });
  h.order(id, { symbol: 'SOLUSD', side: 'sell', qty: 30, sl: 102, tp: 96 });
  const [a, b, c] = h.engine.bootstrap().positions;
  h.engine.closePosition({ accountId: id, symbol: 'SOLUSD', tradeId: b.tradeId });
  assert.deepEqual(
    h.engine.bootstrap().positions.map((p) => p.qty),
    [-10, -30],
  );
  const closedB = h.engine.getTrade(b.tradeId);
  assert.equal(closedB.status, 'closed');
  assert.equal(closedB.exitQty, 20);
  h.engine.closePosition({ accountId: id, symbol: 'SOLUSD', tradeId: c.tradeId, qty: 5 });
  assert.deepEqual(
    h.engine.bootstrap().positions.map((p) => [p.qty, p.sl]),
    [
      [-10, 101],
      [-25, 102],
    ],
  );
  expectCode(() => h.engine.closePosition({ accountId: id, symbol: 'SOLUSD', tradeId: b.tradeId }), 'not_found');
  // A reduce-only exit is capped to all positions together (35).
  const exit = h.order(id, { symbol: 'SOLUSD', side: 'buy', type: 'limit', price: 95, qty: 35 });
  assert.equal(exit.reduceOnly, true);
  h.engine.flattenAccount(id);
  assert.equal(h.engine.bootstrap().positions.length, 0);
  assert.equal(h.store.getOrder(exit.id)?.status, 'cancelled');
  const last = h.engine.listFills({ limit: 2 });
  assert.equal(last[0].orderId, last[1].orderId); // one flatten order, a fill per position
  assert.deepEqual(last.map((f) => f.tradeId).sort(), [a.tradeId, c.tradeId].sort());
  assert.equal(h.engine.listTrades({ status: 'closed', limit: 10, offset: 0 }).length, 3);
  h.close();
});

test('reverse = one 2× market execution in the opposite direction', async () => {
  const h = await setup();
  const id = h.practice();
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 2, sl: 24990, tp: 25050 });
  h.quote('MNQ', 24995, 24995.25, 24995);
  h.engine.reversePosition({ accountId: id, symbol: 'MNQ' });
  const pos = h.engine.bootstrap().positions[0];
  assert.equal(pos.qty, -2);
  assert.equal(pos.avgPrice, 24995);
  assert.equal(pos.sl, null); // a flip clears the old bracket
  assert.equal(pos.tp, null);
  const orders = h.store.listWorkingOrders();
  assert.equal(orders.length, 0);
  const [closed] = h.engine.listTrades({ status: 'closed', limit: 1, offset: 0 });
  assert.equal(closed.exitReason, 'reversal');
  assert.equal(closed.grossPnl, (24995 - 25000.25) * 2 * 2);
  h.close();
});

test('position stop-loss: triggers on the bid, fills at the current bid after a gap; take-profit at its price', async () => {
  const h = await setup();
  const id = h.practice(100_000);
  h.quote('BTCUSD', 80000, 80000.1);
  h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: 0.2, sl: 79500, tp: 81000 });
  let pos = h.engine.bootstrap().positions[0];
  assert.equal(pos.sl, 79500);
  assert.equal(pos.tp, 81000);
  h.quote('BTCUSD', 79600, 79600.1);
  assert.equal(h.engine.bootstrap().positions.length, 1);
  h.quote('BTCUSD', 79300, 79300.1); // gapped through the stop
  assert.equal(h.engine.bootstrap().positions.length, 0);
  const fill = h.engine.listFills({ limit: 1 })[0];
  assert.equal(fill.role, 'stop_loss');
  assert.equal(fill.price, 79300); // slippage: current bid, not the stop price
  assert.equal(fill.orderId, null);
  const [tr] = h.engine.listTrades({ status: 'closed', limit: 1, offset: 0 });
  assert.equal(tr.exitReason, 'stop_loss');
  assert.equal(tr.initialStop, 79500);
  assert.equal(tr.riskAmount, c2((80000.1 - 79500) * 0.2));
  assert.equal(tr.rMultiple, c2(tr.netPnl / tr.riskAmount!));
  assert.ok(tr.mae <= tr.grossPnl);
  const hit = h.events('stop_hit');
  assert.equal(hit.length, 1);
  assert.match(hit[0].message, /79,300\.0/);

  // take-profit
  h.quote('BTCUSD', 80000, 80000.1);
  h.order(id, { symbol: 'BTCUSD', side: 'sell', qty: 0.2, sl: 80500, tp: 79000 });
  h.quote('BTCUSD', 78900, 78900.1);
  const tp = h.engine.listFills({ limit: 1 })[0];
  assert.equal(tp.role, 'take_profit');
  assert.equal(tp.price, 79000);
  assert.equal(tp.liquidity, 'maker');
  assert.equal(h.events('target_hit').length, 1);
  h.close();
});

test('each position keeps its own bracket: partial closes keep it, setBracket by id or for all', async () => {
  const h = await setup();
  const id = h.practice();
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 3, sl: 24980, tp: 25040 });
  h.engine.closePosition({ accountId: id, symbol: 'MNQ', qty: 1 });
  let [pos] = h.engine.bootstrap().positions;
  assert.equal(pos.qty, 2);
  assert.equal(pos.sl, 24980);
  assert.equal(pos.tp, 25040);
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 1 }); // a second position, no bracket
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 1, sl: 24990, tp: 25020 }); // a third, with its own
  let positions = h.engine.bootstrap().positions;
  assert.deepEqual(
    positions.map((p) => [p.qty, p.sl, p.tp]),
    [
      [2, 24980, 25040],
      [1, null, null],
      [1, 24990, 25020],
    ],
  );
  // One position's bracket; invalid side rejected.
  const second = positions[1].tradeId;
  expectCode(() => h.engine.setBracket({ accountId: id, symbol: 'MNQ', tradeId: second, sl: 25010 }), 'invalid', /below the price/);
  expectCode(() => h.engine.setBracket({ accountId: id, symbol: 'MNQ', tradeId: 'nope', sl: 24985 }), 'not_found');
  const changed = h.engine.setBracket({ accountId: id, symbol: 'MNQ', tradeId: second, sl: 24985 });
  assert.equal(changed.length, 1);
  assert.equal(changed[0].sl, 24985);
  assert.deepEqual(
    h.engine.bootstrap().positions.map((p) => p.sl),
    [24980, 24985, 24990],
  );
  // The third position's stop: only it closes, for its own size.
  h.quote('MNQ', 24990, 24990.25, 24990);
  positions = h.engine.bootstrap().positions;
  assert.deepEqual(
    positions.map((p) => p.qty),
    [2, 1],
  );
  const stop = h.engine.listFills({ limit: 1 })[0];
  assert.equal(stop.role, 'stop_loss');
  assert.equal(stop.qty, 1);
  // Without an id: every position of the symbol.
  pos = positions[0];
  const all = h.engine.setBracket({ accountId: id, symbol: 'MNQ', tp: 25030 });
  assert.equal(all.length, 2);
  assert.deepEqual(
    h.engine.bootstrap().positions.map((p) => [p.sl, p.tp]),
    [
      [pos.sl, 25030],
      [24985, 25030],
    ],
  );
  h.quote('MNQ', 25030.25, 25030.5, 25030.25); // trade-through: both targets fill
  assert.equal(h.engine.bootstrap().positions.length, 0);
  assert.deepEqual(
    h.engine.listFills({ limit: 2 }).map((f) => [f.role, f.qty]),
    [
      ['take_profit', 1],
      ['take_profit', 2],
    ],
  );
  h.close();
});

test('reduce-only exit orders are capped to the position and cancelled when it is flat', async () => {
  const h = await setup();
  const id = h.practice();
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 3 });
  const exit = h.order(id, { symbol: 'MNQ', side: 'sell', type: 'limit', price: 25050, qty: 3 });
  assert.equal(exit.reduceOnly, true);
  assert.equal(exit.role, 'exit');
  h.engine.closePosition({ accountId: id, symbol: 'MNQ', qty: 2 });
  assert.equal(h.engine.bootstrap().orders[0].qty, 1); // capped
  h.engine.closePosition({ accountId: id, symbol: 'MNQ' });
  assert.equal(h.engine.bootstrap().orders.length, 0);
  assert.equal(h.store.getOrder(exit.id)?.status, 'cancelled');
  h.close();
});

test('modify and cancel working orders', async () => {
  const h = await setup();
  const id = h.practice(100_000);
  h.quote('BTCUSD', 80000, 80000.1);
  const o = h.order(id, { symbol: 'BTCUSD', side: 'buy', type: 'limit', price: 79000, qty: 0.1, sl: 78000 });
  const m = h.engine.modifyOrder(o.id, { price: 79500.04, qty: 0.2, tp: 81000 });
  assert.equal(m.price, 79500); // rounded to the tick
  assert.equal(m.qty, 0.2);
  assert.equal(m.sl, 78000);
  assert.equal(m.tp, 81000);
  expectCode(() => h.engine.modifyOrder(o.id, { sl: 80000 }), 'invalid', /below the price/);
  // modify into a marketable price → fills now as taker
  const filled = h.engine.modifyOrder(o.id, { price: 80200 });
  assert.equal(filled.status, 'filled');
  assert.equal(filled.fillPrice, 80000.1);
  const pos = h.engine.bootstrap().positions[0];
  assert.equal(pos.sl, 78000);
  assert.equal(pos.tp, 81000);
  const o2 = h.order(id, { symbol: 'BTCUSD', side: 'buy', type: 'limit', price: 79000, qty: 0.1 });
  assert.equal(h.engine.cancelOrder(o2.id).status, 'cancelled');
  expectCode(() => h.engine.cancelOrder(o2.id), 'conflict');
  expectCode(() => h.engine.cancelOrder('nope'), 'not_found');
  h.close();
});

test('quantities must be on the step and ≥ min; prices are rounded to the tick', async () => {
  const h = await setup();
  const id = h.practice(100_000);
  h.quote('BTCUSD', 80000, 80000.1);
  expectCode(() => h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: 0.0005 }), 'invalid', /multiple of 0\.001/);
  expectCode(() => h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: 0 }), 'invalid');
  expectCode(() => h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: Number.NaN }), 'invalid');
  h.quote('MNQ', 25000, 25000.25, 25000);
  expectCode(() => h.order(id, { symbol: 'MNQ', side: 'buy', qty: 1.5 }), 'invalid');
  const o = h.order(id, { symbol: 'BTCUSD', side: 'buy', type: 'limit', price: 79000.04, qty: 0.001 });
  assert.equal(o.price, 79000);
  h.close();
});

test('trade journal: tags from the entry order, MAE/MFE, initial stop set within 10 s', async () => {
  const h = await setup();
  const id = h.practice();
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 1, tags: { mood: 'calm', setup: 'A', confidence: 4, plan: 'ORB long' } });
  h.clock.t += 5_000;
  h.engine.setBracket({ accountId: id, symbol: 'MNQ', sl: 24990 });
  h.quote('MNQ', 24992, 24992.25, 24992);
  h.quote('MNQ', 25015, 25015.25, 25015);
  h.quote('MNQ', 25010, 25010.25, 25010);
  h.engine.closePosition({ accountId: id, symbol: 'MNQ' });
  const [tr] = h.engine.listTrades({ status: 'closed', limit: 1, offset: 0 });
  assert.deepEqual(tr.tags, { mood: 'calm', setup: 'A', confidence: 4, plan: 'ORB long' });
  assert.equal(tr.initialStop, 24990);
  assert.equal(tr.riskAmount, c2((25000.25 - 24990) * 2));
  assert.equal(tr.mae, c2((24992 - 25000.25) * 2));
  assert.equal(tr.mfe, c2((25015 - 25000.25) * 2));
  // journal edits: only tags / review
  const upd = h.engine.updateTrade(tr.id, { tags: { mood: 'anxious' }, review: { followedPlan: true, rating: 4, mistakes: ['Exited too early'], moodAfter: 'calm', note: 'ok' } });
  assert.equal(upd.tags.mood, 'anxious');
  assert.equal(upd.tags.plan, 'ORB long');
  assert.equal(upd.review?.rating, 4);
  assert.equal(upd.review?.reviewedAt, h.clock.t);
  expectCode(() => h.engine.updateTrade(tr.id, { review: { followedPlan: null, rating: 9, mistakes: [], moodAfter: null, note: null } }), 'invalid');
  expectCode(() => h.engine.updateTrade(tr.id, { tags: { mood: 'zen' as never } }), 'invalid');
  assert.equal(h.engine.updateTrade(tr.id, { review: null }).review, null);
  h.close();
});

test('daily stats and equity points are written on every fill', async () => {
  const h = await setup();
  const id = h.practice();
  h.quote('MNQ', 25000, 25000.25, 25000.25);
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 1 });
  h.quote('MNQ', 24990, 24990.25, 24990);
  h.order(id, { symbol: 'MNQ', side: 'sell', qty: 1 });
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 1 });
  h.quote('MNQ', 25005, 25005.25, 25005);
  h.order(id, { symbol: 'MNQ', side: 'sell', qty: 1 });
  const [d] = h.engine.listDaily({ accountId: id });
  assert.equal(d.day, '2026-10-21');
  assert.equal(d.trades, 2);
  assert.equal(d.wins, 1);
  assert.equal(d.losses, 1);
  assert.equal(d.fills, 4);
  assert.equal(d.grossPnl, c2((24990 - 25000.25) * 2 + (25005 - 24990.25) * 2));
  assert.equal(d.fees, 2.48);
  assert.equal(d.netPnl, c2(d.grossPnl - d.fees));
  assert.equal(d.startBalance, 50_000);
  assert.equal(d.endBalance, h.engine.snapshot(id)!.balance);
  assert.equal(h.engine.listEquity(id).length, 4);
  // equity points every 60 s while a position is open
  h.order(id, { symbol: 'MNQ', side: 'buy', qty: 1 });
  h.advance(30_000);
  h.advance(31_000);
  assert.equal(h.engine.listEquity(id).length, 6);
  h.advance(MIN);
  assert.equal(h.engine.listEquity(id).length, 7);
  const snap = h.engine.snapshot(id)!;
  assert.equal(snap.dayTrades, 2);
  assert.equal(snap.dayRealized, c2(d.netPnl - 0.62));
  h.close();
});

test('practice accounts can switch trading fees off; challenge accounts cannot', async () => {
  const h = await setup();
  const id = h.engine.createAccount({ kind: 'practice', startingBalance: 50_000, fees: 'off' }).id;
  h.quote('BTCUSD', 80000, 80000.1);
  h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: 0.1 });
  h.order(id, { symbol: 'BTCUSD', side: 'sell', qty: 0.1 });
  assert.equal(h.engine.snapshot(id)!.balance, 49999.99); // the spread only: (80000 − 80000.1) × 0.1
  h.engine.updateAccount(id, { fees: 'real' });
  h.order(id, { symbol: 'BTCUSD', side: 'buy', qty: 0.1 }); // 8,000.01 × 0.05% taker
  assert.equal(h.engine.snapshot(id)!.balance, 49995.99);
  h.engine.updateAccount(id, { fees: 'off' });
  h.order(id, { symbol: 'BTCUSD', side: 'sell', qty: 0.1 });
  assert.equal(h.engine.snapshot(id)!.balance, 49995.98);
  const [last] = h.engine.listTrades({ status: 'closed', limit: 1, offset: 0 });
  assert.equal(last.fees, 4); // entry paid with fees on, exit free
  expectCode(() => h.engine.updateAccount(id, { fees: 'cheap' as never }), 'invalid');
  const ev = h.custom();
  expectCode(() => h.engine.updateAccount(ev, { fees: 'off' }), 'invalid', /only be switched off on practice/);
  h.close();
});
