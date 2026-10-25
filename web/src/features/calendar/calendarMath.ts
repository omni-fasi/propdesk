// Pure calendar helpers: month grids, daily aggregation across accounts, lock periods, summaries, heat intensity.

import { LOCK_FLAGS, type AccountEvent, type DailyStat, type EventKind, type LockReason, type ZonedTime } from '@shared/types';
import { addDays, addMonths, daysInMonth, monthKeyOf, tradingDayBounds, tradingDayOf, weekdayOfKey } from '@shared/time';

export type DayFlag = DailyStat['flags'][number];

export interface DayAgg {
  day: string;
  net: number;
  gross: number;
  fees: number;
  trades: number;
  wins: number;
  losses: number;
  fills: number;
  flags: DayFlag[];
  /** Per-account rows (one in single-account mode). */
  rows: DailyStat[];
}

const round2 = (x: number) => Math.round(x * 100) / 100 || 0;

/** Sum DailyStat rows per day (union of flags). Works for one account or many. */
export function aggregateDaily(rows: readonly DailyStat[]): Map<string, DayAgg> {
  const map = new Map<string, DayAgg>();
  for (const r of rows) {
    let d = map.get(r.day);
    if (!d) map.set(r.day, (d = { day: r.day, net: 0, gross: 0, fees: 0, trades: 0, wins: 0, losses: 0, fills: 0, flags: [], rows: [] }));
    d.net += r.netPnl;
    d.gross += r.grossPnl;
    d.fees += r.fees;
    d.trades += r.trades;
    d.wins += r.wins;
    d.losses += r.losses;
    d.fills += r.fills;
    for (const f of r.flags ?? []) if (!d.flags.includes(f)) d.flags.push(f);
    d.rows.push(r);
  }
  for (const d of map.values()) {
    d.net = round2(d.net);
    d.gross = round2(d.gross);
    d.fees = round2(d.fees);
  }
  return map;
}

export interface LockSpan {
  accountId: string;
  /** The day flag the lock left (break, tilt, daily_loss, locked). */
  flag: DayFlag;
  from: number;
  to: number;
  /** It lasted until the next trading day. */
  untilDayEnd: boolean;
  message: string;
}

/** Events that end an account (and any lock with it). */
const ENDED: ReadonlySet<EventKind> = new Set(['breach', 'passed', 'phase_passed']);

/**
 * When each lock of trading day `day` was in force, from the events around it (any accounts). Locks can't be
 * lifted early, so one runs from its 'locked' event to its own end or the end of the trading day, cut short
 * only if the account ended.
 */
export function dayLockSpans(events: readonly AccountEvent[], day: string, rolloverOf: (accountId: string) => ZonedTime | undefined): LockSpan[] {
  const byAccount = new Map<string, AccountEvent[]>();
  for (const e of events) {
    const r = e.accountId ? rolloverOf(e.accountId) : undefined;
    if (!e.accountId || !r || (e.kind !== 'locked' && !ENDED.has(e.kind)) || tradingDayOf(e.ts, r) !== day) continue;
    const list = byAccount.get(e.accountId) ?? [];
    list.push(e);
    byAccount.set(e.accountId, list);
  }
  const out: LockSpan[] = [];
  for (const [accountId, list] of byAccount) {
    list.sort((a, b) => a.ts - b.ts);
    const dayEnd = tradingDayBounds(day, rolloverOf(accountId)!).end;
    const endedAt = list.find((e) => ENDED.has(e.kind))?.ts ?? Infinity;
    for (const e of list) {
      const reason = e.data?.reason as LockReason | undefined;
      if (e.kind !== 'locked' || !reason || !(reason in LOCK_FLAGS)) continue;
      const until = typeof e.data?.until === 'number' ? e.data.until : null;
      const end = until ?? dayEnd;
      out.push({ accountId, flag: LOCK_FLAGS[reason], from: e.ts, to: Math.min(end, endedAt), untilDayEnd: until == null && end <= endedAt, message: e.message });
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

/** A day counts as traded when something was filled or closed (rollover-only rows don't). */
export function isTraded(d: DayAgg | undefined): d is DayAgg {
  return !!d && (d.fills > 0 || d.trades > 0 || Math.abs(d.net) >= 0.005);
}

export interface MonthGridModel {
  month: string;
  /** First and last day keys shown (Sunday before the 1st … Saturday after the last day). */
  start: string;
  end: string;
  weeks: string[][];
}

/** Sun–Sat weeks covering the month. */
export function monthGrid(month: string): MonthGridModel {
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const last = `${month}-${String(daysInMonth(y, m)).padStart(2, '0')}`;
  const start = addDays(first, -weekdayOfKey(first));
  const end = addDays(last, 6 - weekdayOfKey(last));
  const weeks: string[][] = [];
  for (let k = start; k <= end; k = addDays(k, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(k, i)));
  return { month, start, end, weeks };
}

export interface PeriodSummary {
  net: number;
  gross: number;
  fees: number;
  tradingDays: number;
  greenDays: number;
  redDays: number;
  flatDays: number;
  trades: number;
  wins: number;
  losses: number;
  /** Wins / closed trades. */
  winRate: number | null;
  best: DayAgg | null;
  worst: DayAgg | null;
  /** Net / trading days. */
  avgDay: number | null;
  avgGreen: number | null;
  avgRed: number | null;
}

export function summarize(days: Iterable<DayAgg>): PeriodSummary {
  let net = 0;
  let gross = 0;
  let fees = 0;
  let tradingDays = 0;
  let green = 0;
  let red = 0;
  let greenSum = 0;
  let redSum = 0;
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let best: DayAgg | null = null;
  let worst: DayAgg | null = null;
  for (const d of days) {
    net += d.net;
    gross += d.gross;
    fees += d.fees;
    trades += d.trades;
    wins += d.wins;
    losses += d.losses;
    if (!isTraded(d)) continue;
    tradingDays++;
    if (d.net >= 0.005) {
      green++;
      greenSum += d.net;
    } else if (d.net <= -0.005) {
      red++;
      redSum += d.net;
    }
    if (!best || d.net > best.net) best = d;
    if (!worst || d.net < worst.net) worst = d;
  }
  return {
    net: round2(net),
    gross: round2(gross),
    fees: round2(fees),
    tradingDays,
    greenDays: green,
    redDays: red,
    flatDays: tradingDays - green - red,
    trades,
    wins,
    losses,
    winRate: trades ? wins / trades : null,
    best,
    worst,
    avgDay: tradingDays ? net / tradingDays : null,
    avgGreen: green ? greenSum / green : null,
    avgRed: red ? redSum / red : null,
  };
}

/** Days of `month` from an aggregate map. */
export function daysOfMonth(map: Map<string, DayAgg>, month: string): DayAgg[] {
  return [...map.values()].filter((d) => monthKeyOf(d.day) === month);
}

/** Largest |net| among traded days (the tint scale). */
export function maxAbsNet(days: Iterable<DayAgg>): number {
  let m = 0;
  for (const d of days) if (isTraded(d)) m = Math.max(m, Math.abs(d.net));
  return m;
}

/** Background alpha for a day tint: subtle, square-root scaled, capped. */
export function tintAlpha(net: number, maxAbs: number): number {
  if (maxAbs <= 0 || Math.abs(net) < 0.005) return 0;
  return Math.min(0.2, 0.045 + 0.155 * Math.sqrt(Math.min(1, Math.abs(net) / maxAbs)));
}

/** Quantized heat level 1–4 (0 = no P&L) for the year heatmap. */
export function heatLevel(net: number, maxAbs: number): 0 | 1 | 2 | 3 | 4 {
  if (maxAbs <= 0 || Math.abs(net) < 0.005) return 0;
  return Math.max(1, Math.min(4, Math.ceil((Math.abs(net) / maxAbs) * 4))) as 1 | 2 | 3 | 4;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isMonthKey(s: string | null | undefined): s is string {
  return !!s && MONTH_RE.test(s);
}

export function isDayKey(s: string | null | undefined): s is string {
  return !!s && DAY_RE.test(s);
}

export function yearMonths(year: number): string[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
}

export { addMonths };
