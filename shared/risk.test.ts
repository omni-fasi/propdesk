import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getInstrument } from './instruments.ts';
import {
  ceilToStep,
  commissionFor,
  contractsEquivalent,
  decimalsOf,
  floorToStep,
  notional,
  offsetTicks,
  pnl,
  qtyForRisk,
  riskAmount,
  round2,
  roundPrice,
  roundQty,
  roundTripCommission,
  tickValue,
  validateBracket,
} from './risk.ts';
import { fmtCountdown, fmtDuration, fmtMoney, fmtPct, fmtQtyWithUnit, fmtWorkHours } from './format.ts';

const MNQ = getInstrument('MNQ')!;
const NQ = getInstrument('NQ')!;
const BTC = getInstrument('BTCUSD')!;
const EUR = getInstrument('EURUSD')!;
const DOGE = getInstrument('DOGEUSD')!;

test('decimals and step rounding', () => {
  assert.equal(decimalsOf(0.25), 2);
  assert.equal(decimalsOf(0.00001), 5);
  assert.equal(decimalsOf(1), 0);
  assert.equal(roundPrice(MNQ, 25012.37), 25012.25);
  assert.equal(roundPrice(MNQ, 25012.38), 25012.5);
  assert.equal(roundPrice(EUR, 1.162345), 1.16235);
  assert.equal(roundPrice(DOGE, 0.1912345), 0.19123);
  assert.equal(floorToStep(0.0299999, 0.001), 0.029);
  assert.equal(floorToStep(0.03, 0.001), 0.03);
  assert.equal(ceilToStep(0.0301, 0.001), 0.031);
  assert.equal(roundQty(BTC, 0.0157), 0.015);
  assert.equal(roundQty(MNQ, 2.9), 2);
});

test('P&L, notional and tick value', () => {
  assert.equal(pnl(MNQ, 1, 2, 25000, 25010), 40); // 10 pts × $2 × 2
  assert.equal(pnl(NQ, -1, 1, 25000, 25010), -200);
  assert.equal(round2(pnl(BTC, 1, 0.01, 80000, 80500)), 5);
  assert.equal(round2(pnl(EUR, 1, 1, 1.16, 1.161)), 100); // 10 pips × $10
  assert.equal(notional(MNQ, 2, 25000), 100000);
  assert.equal(tickValue(MNQ), 0.5);
  assert.equal(tickValue(NQ, 2), 10);
  assert.equal(round2(tickValue(EUR)), 1);
});

test('commissions', () => {
  assert.equal(commissionFor(MNQ.commission, MNQ, 3, 25000, 'taker'), 1.86);
  assert.equal(commissionFor(BTC.commission, BTC, 0.1, 80000, 'taker'), 4); // 8,000 × 0.05%
  assert.equal(commissionFor(BTC.commission, BTC, 0.1, 80000, 'maker'), 1.6);
  assert.equal(commissionFor(EUR.commission, EUR, 2, 1.16, 'taker'), 6);
  assert.equal(roundTripCommission(MNQ, 1, 25000), 1.24);
});

test('risk sizing', () => {
  assert.equal(riskAmount(MNQ, 2, 25000, 24980), 80);
  assert.equal(qtyForRisk(MNQ, 100, 25000, 24980), 2); // $40 per contract
  assert.equal(qtyForRisk(MNQ, 39, 25000, 24980), 0); // can't afford one
  assert.equal(qtyForRisk(BTC, 50, 80000, 79500), 0.1);
  assert.equal(qtyForRisk(BTC, 50, 80000, 80000), 0);
  assert.equal(offsetTicks(MNQ, 25000, 8, -1), 24998);
  assert.equal(contractsEquivalent(MNQ, 10), 1);
  assert.equal(contractsEquivalent(BTC, 10), 0);
});

test('bracket validation', () => {
  assert.equal(validateBracket(1, 100, 99, 101), null);
  assert.match(validateBracket(1, 100, 101, null) ?? '', /below/);
  assert.match(validateBracket(-1, 100, 99, null) ?? '', /above/);
  assert.match(validateBracket(-1, 100, 101, 100.5) ?? '', /below/);
});

test('formatting', () => {
  assert.equal(fmtMoney(1234.5), '$1,234.50');
  assert.equal(fmtMoney(-80), '−$80.00');
  assert.equal(fmtMoney(12.5, { sign: true }), '+$12.50');
  assert.equal(fmtMoney(-0.001, { sign: true }), '$0.00');
  assert.equal(fmtMoney(50000, { whole: true }), '$50,000');
  assert.equal(fmtPct(0.1234), '12.3%');
  assert.equal(fmtPct(-0.05, 0, true), '−5%');
  assert.equal(fmtQtyWithUnit(MNQ, 1), '1 contract');
  assert.equal(fmtQtyWithUnit(MNQ, 3), '3 contracts');
  assert.equal(fmtQtyWithUnit(BTC, 0.015), '0.015 BTC');
  assert.equal(fmtQtyWithUnit(EUR, 1), '1 lot');
  assert.equal(fmtDuration(45_000), '45s');
  assert.equal(fmtDuration(3_725_000), '1h 02m');
  assert.equal(fmtCountdown(899_100), '15:00');
  assert.equal(fmtWorkHours(-130, 20), '≈ 6.5 h of work');
  assert.equal(fmtWorkHours(5, 20), '≈ 15 min of work');
  assert.equal(fmtWorkHours(100, null), null);
  assert.equal(fmtWorkHours(0, 25), null);
});
