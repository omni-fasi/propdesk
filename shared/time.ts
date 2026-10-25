// Time-zone aware helpers (Intl based, no dependencies): trading days, rollovers, market sessions.
// Day keys are 'YYYY-MM-DD' strings; month keys are 'YYYY-MM'.

import type { SessionKind, SessionState, ZonedTime } from './types.ts';

export const NEW_YORK = 'America/New_York';
export const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** 'local' → the machine time zone. */
export function resolveTz(tz: string): string {
  return tz === 'local' ? localTimeZone() : tz;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(ts: number, tz: string): ZonedParts {
  const out: Record<string, string> = {};
  for (const p of formatter(resolveTz(tz)).formatToParts(new Date(ts))) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS[out.weekday] ?? 0,
  };
}

/** Offset of `tz` from UTC at instant `ts`, in ms (local wall clock − UTC). */
export function tzOffset(ts: number, tz: string): number {
  const p = zonedParts(ts, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** The instant at which the wall clock in `tz` shows the given date and time. */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const off1 = tzOffset(guess, tz);
  let ts = guess - off1;
  const off2 = tzOffset(ts, tz);
  if (off2 !== off1) ts = guess - off2;
  return ts;
}

export function dayKey(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseDayKey(key: string): { year: number; month: number; day: number } {
  const [y, m, d] = key.split('-').map(Number);
  return { year: y, month: m, day: d };
}

export function addDays(key: string, n: number): string {
  const { year, month, day } = parseDayKey(key);
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return dayKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** 0 = Sunday … 6 = Saturday */
export function weekdayOfKey(key: string): number {
  const { year, month, day } = parseDayKey(key);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function monthKeyOf(key: string): string {
  return key.slice(0, 7);
}

export function addMonths(monthKey: string, n: number): string {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Inclusive list of day keys. */
export function dayKeysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let k = from; k <= to; k = addDays(k, 1)) out.push(k);
  return out;
}

/** Calendar date of `ts` in `tz`. */
export function calendarDayOf(ts: number, tz: string): string {
  const p = zonedParts(ts, tz);
  return dayKey(p.year, p.month, p.day);
}

function shiftMinutes(r: ZonedTime): number {
  return (24 * 60 - (r.hour * 60 + r.minute)) % (24 * 60);
}

/**
 * Trading day of `ts` for a rollover. With a 17:00 rollover the trading day D spans
 * [D-1 17:00, D 17:00) — e.g. Wednesday 18:00 belongs to Thursday. With 00:00 it is the calendar date.
 */
export function tradingDayOf(ts: number, r: ZonedTime): string {
  const p = zonedParts(ts, r.tz);
  const wall = new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute + shiftMinutes(r)));
  return dayKey(wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate());
}

/** [start, end) instants of a trading day. */
export function tradingDayBounds(key: string, r: ZonedTime): { start: number; end: number } {
  const tz = resolveTz(r.tz);
  const startKey = shiftMinutes(r) === 0 ? key : addDays(key, -1);
  const s = parseDayKey(startKey);
  const e = parseDayKey(addDays(startKey, 1));
  return {
    start: zonedTimeToUtc(s.year, s.month, s.day, r.hour, r.minute, tz),
    end: zonedTimeToUtc(e.year, e.month, e.day, r.hour, r.minute, tz),
  };
}

/** Next instant strictly after `ts` at which the trading day changes. */
export function nextRolloverAt(ts: number, r: ZonedTime): number {
  const tz = resolveTz(r.tz);
  const p = zonedParts(ts, tz);
  let cand = zonedTimeToUtc(p.year, p.month, p.day, r.hour, r.minute, tz);
  if (cand <= ts) {
    const t = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    cand = zonedTimeToUtc(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), r.hour, r.minute, tz);
  }
  return cand;
}

/** Next instant strictly after `ts` when the wall clock in t.tz shows t.hour:t.minute on a weekday (Mon–Fri). */
export function nextWeekdayTimeAt(ts: number, t: ZonedTime): number {
  const tz = resolveTz(t.tz);
  const p = zonedParts(ts, tz);
  for (let i = 0; i < 8; i++) {
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + i));
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const cand = zonedTimeToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), t.hour, t.minute, tz);
    if (cand > ts) return cand;
  }
  return ts + 7 * DAY_MS;
}

// ───────────────────────────── Market sessions ─────────────────────────────

function stateAt(kind: SessionKind, ts: number): { open: boolean; label: string } {
  if (kind === '24x7') return { open: true, label: 'Open 24/7' };
  const p = zonedParts(ts, NEW_YORK);
  const w = p.weekday;
  if (kind === 'cme') {
    if (w === 6) return { open: false, label: 'Weekend' };
    if (w === 0) return p.hour >= 18 ? { open: true, label: 'Open' } : { open: false, label: 'Weekend' };
    if (w === 5) return p.hour < 17 ? { open: true, label: 'Open' } : { open: false, label: 'Weekend' };
    return p.hour === 17 ? { open: false, label: 'Daily break' } : { open: true, label: 'Open' };
  }
  // fx: Sun 17:00 → Fri 17:00 ET
  if (w === 6) return { open: false, label: 'Weekend' };
  if (w === 0) return p.hour >= 17 ? { open: true, label: 'Open' } : { open: false, label: 'Weekend' };
  if (w === 5) return p.hour < 17 ? { open: true, label: 'Open' } : { open: false, label: 'Weekend' };
  return { open: true, label: 'Open' };
}

export function isMarketOpen(kind: SessionKind, ts: number): boolean {
  return stateAt(kind, ts).open;
}

export function sessionState(kind: SessionKind, ts: number): SessionState {
  const cur = stateAt(kind, ts);
  if (kind === '24x7') return { open: true, nextChange: null, label: cur.label };
  const p = zonedParts(ts, NEW_YORK);
  let next: number | null = null;
  for (let i = 0; i <= 4 && next === null; i++) {
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + i));
    for (const hour of [17, 18]) {
      const t = zonedTimeToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, 0, NEW_YORK);
      if (t > ts && stateAt(kind, t).open !== cur.open) {
        next = t;
        break;
      }
    }
  }
  return { open: cur.open, nextChange: next, label: cur.label };
}
