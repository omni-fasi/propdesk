import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  dayKeysBetween,
  nextRolloverAt,
  nextWeekdayTimeAt,
  sessionState,
  tradingDayBounds,
  tradingDayOf,
  weekdayOfKey,
  zonedParts,
  zonedTimeToUtc,
} from './time.ts';

const NY17 = { hour: 17, minute: 0, tz: 'America/New_York' };
const TOR0 = { hour: 0, minute: 0, tz: 'America/Toronto' };
const ny = (y: number, mo: number, d: number, h: number, mi = 0) => zonedTimeToUtc(y, mo, d, h, mi, 'America/New_York');

test('zonedTimeToUtc round-trips across DST', () => {
  // 2026-03-08 is the US spring-forward day, 2026-11-01 fall-back.
  for (const [y, m, d, h] of [[2026, 3, 7, 12], [2026, 3, 9, 12], [2026, 10, 31, 12], [2026, 11, 2, 12], [2026, 7, 1, 17]] as const) {
    const ts = ny(y, m, d, h);
    const p = zonedParts(ts, 'America/New_York');
    assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute], [y, m, d, h, 0]);
  }
  assert.equal(ny(2026, 7, 1, 17), Date.UTC(2026, 6, 1, 21)); // EDT = UTC-4
  assert.equal(ny(2026, 12, 1, 17), Date.UTC(2026, 11, 1, 22)); // EST = UTC-5
});

test('tradingDayOf with 17:00 NY rollover', () => {
  assert.equal(tradingDayOf(ny(2026, 10, 21, 16, 59), NY17), '2026-10-21'); // Wed before close
  assert.equal(tradingDayOf(ny(2026, 10, 21, 17, 0), NY17), '2026-10-22'); // Wed 17:00 → Thu
  assert.equal(tradingDayOf(ny(2026, 10, 25, 18, 0), NY17), '2026-10-26'); // Sun evening → Mon
  assert.equal(tradingDayOf(ny(2026, 10, 23, 9, 30), NY17), '2026-10-23'); // Fri morning
});

test('tradingDayOf with local midnight', () => {
  const ts = zonedTimeToUtc(2026, 10, 24, 23, 59, 'America/Toronto');
  assert.equal(tradingDayOf(ts, TOR0), '2026-10-24');
  assert.equal(tradingDayOf(ts + 60_000, TOR0), '2026-10-25');
});

test('tradingDayBounds and nextRolloverAt agree', () => {
  const b = tradingDayBounds('2026-10-22', NY17);
  assert.equal(b.start, ny(2026, 10, 21, 17));
  assert.equal(b.end, ny(2026, 10, 22, 17));
  assert.equal(nextRolloverAt(b.start, NY17), b.end);
  assert.equal(nextRolloverAt(b.start - 1, NY17), b.start);
  const m = tradingDayBounds('2026-10-24', TOR0);
  assert.equal(m.end - m.start, 86_400_000);
  // DST fall-back day is 25 hours long.
  const fb = tradingDayBounds('2026-11-01', TOR0);
  assert.equal(fb.end - fb.start, 25 * 3_600_000);
});

test('day key helpers', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(weekdayOfKey('2026-10-24'), 6); // Saturday
  assert.deepEqual(dayKeysBetween('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
});

test('CME session', () => {
  const sat = sessionState('cme', ny(2026, 10, 24, 1, 28));
  assert.equal(sat.open, false);
  assert.equal(sat.label, 'Weekend');
  assert.equal(sat.nextChange, ny(2026, 10, 25, 18));
  const wed = sessionState('cme', ny(2026, 10, 21, 10));
  assert.equal(wed.open, true);
  assert.equal(wed.nextChange, ny(2026, 10, 21, 17));
  const brk = sessionState('cme', ny(2026, 10, 21, 17, 30));
  assert.equal(brk.open, false);
  assert.equal(brk.label, 'Daily break');
  assert.equal(brk.nextChange, ny(2026, 10, 21, 18));
  const fri = sessionState('cme', ny(2026, 10, 23, 16, 59));
  assert.equal(fri.open, true);
  assert.equal(fri.nextChange, ny(2026, 10, 23, 17));
  assert.equal(sessionState('24x7', Date.now()).open, true);
  assert.equal(sessionState('fx', ny(2026, 10, 25, 17, 1)).open, true);
});

test('nextWeekdayTimeAt skips weekends', () => {
  const t = { hour: 16, minute: 10, tz: 'America/New_York' };
  assert.equal(nextWeekdayTimeAt(ny(2026, 10, 23, 17), t), ny(2026, 10, 26, 16, 10)); // Fri after → Mon
  assert.equal(nextWeekdayTimeAt(ny(2026, 10, 21, 9), t), ny(2026, 10, 21, 16, 10));
});
