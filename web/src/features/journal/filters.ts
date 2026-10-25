// Journal filters: parsed from / written to the URL (#/journal?…), applied to closed trades.
//
// Date ranges work on TRADING DAYS (trade.tradingDay), exactly like the calendar, so a trade taken at
// 18:30 ET on Wednesday in a 17:00-rollover account belongs to Thursday in both places.
// The server only filters by account and a time window (with a ±1 day margin); everything else is client-side.

import type { Mood, Trade } from '@shared/types';
import { MOOD_MAP } from '@shared/journal';
import { addDays, parseDayKey, weekdayOfKey } from '@shared/time';
import { isReviewed, normalizeSetup, resultOf, type TradeResult } from './stats';

export type RangePreset = 'today' | 'week' | 'month' | '30d' | 'year' | 'all' | 'custom';

export const RANGE_OPTIONS: Array<{ value: RangePreset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'year', label: 'This year' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom range' },
];

export const DEFAULT_RANGE: RangePreset = '30d';

export type SideFilter = 'long' | 'short';
export type ReviewFilter = 'reviewed' | 'unreviewed';
export type MoodFilter = Mood | 'none';

export interface JournalFilters {
  /** 'all' or an account id. */
  account: string;
  range: RangePreset;
  /** Custom range day keys (inclusive). */
  from: string | null;
  to: string | null;
  symbol: string | null;
  side: SideFilter | null;
  result: TradeResult | null;
  mood: MoodFilter | null;
  /** A setup grade / free-text setup, or 'none' (not graded). */
  setup: string | null;
  review: ReviewFilter | null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDayKey(s: string | null | undefined): s is string {
  if (!s || !DAY_RE.test(s)) return false;
  const { year, month, day } = parseDayKey(s);
  return year > 1970 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function oneOf<T extends string>(v: string | null, allowed: readonly T[]): T | null {
  return v != null && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

export function parseFilters(p: URLSearchParams): JournalFilters {
  const range = oneOf(p.get('range'), RANGE_OPTIONS.map((o) => o.value)) ?? DEFAULT_RANGE;
  const mood = p.get('mood');
  return {
    account: p.get('account') || 'all',
    range,
    from: isDayKey(p.get('from')) ? p.get('from') : null,
    to: isDayKey(p.get('to')) ? p.get('to') : null,
    symbol: p.get('symbol') || null,
    side: oneOf(p.get('side'), ['long', 'short'] as const),
    result: oneOf(p.get('result'), ['win', 'loss', 'be'] as const),
    mood: mood === 'none' || (mood != null && mood in MOOD_MAP) ? (mood as MoodFilter) : null,
    setup: p.get('setup') || null,
    review: oneOf(p.get('review'), ['reviewed', 'unreviewed'] as const),
  };
}

/** URL params for a filter patch; default values are removed from the URL. */
export function filterParams(patch: Partial<JournalFilters>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(patch) as Array<[keyof JournalFilters, string | null | undefined]>) {
    if (k === 'account') out.account = v && v !== 'all' ? v : null;
    else if (k === 'range') out.range = v && v !== DEFAULT_RANGE ? v : null;
    else out[k] = v ?? null;
  }
  if (patch.range && patch.range !== 'custom') {
    out.from = null;
    out.to = null;
  }
  return out;
}

/** Number of narrowing filters besides account and date range. */
export function activeFilterCount(f: JournalFilters): number {
  return [f.symbol, f.side, f.result, f.mood, f.setup, f.review].filter((v) => v != null).length;
}

export const CLEAR_FILTERS: Partial<JournalFilters> = { symbol: null, side: null, result: null, mood: null, setup: null, review: null };

/** Inclusive trading-day bounds of the range; null = open-ended. Ranges ending "now" have no upper bound
 *  (a 17:00-rollover account already trades "tomorrow" in the evening). */
export function rangeKeys(f: Pick<JournalFilters, 'range' | 'from' | 'to'>, today: string): { fromKey: string | null; toKey: string | null } {
  switch (f.range) {
    case 'today':
      return { fromKey: today, toKey: null };
    case 'week':
      return { fromKey: addDays(today, -weekdayOfKey(today)), toKey: null };
    case 'month':
      return { fromKey: `${today.slice(0, 7)}-01`, toKey: null };
    case '30d':
      return { fromKey: addDays(today, -29), toKey: null };
    case 'year':
      return { fromKey: `${today.slice(0, 4)}-01-01`, toKey: null };
    case 'all':
      return { fromKey: null, toKey: null };
    case 'custom': {
      let fromKey = f.from;
      let toKey = f.to;
      if (fromKey && toKey && fromKey > toKey) [fromKey, toKey] = [toKey, fromKey];
      return { fromKey, toKey };
    }
  }
}

function localMidnight(key: string): number {
  const { year, month, day } = parseDayKey(key);
  return new Date(year, month - 1, day).getTime();
}

/** Server time window (ms) covering the trading-day range with a one-day margin on both sides. */
export function serverWindow(fromKey: string | null, toKey: string | null): { from?: number; to?: number } {
  return {
    from: fromKey ? localMidnight(addDays(fromKey, -1)) : undefined,
    to: toKey ? localMidnight(addDays(toKey, 2)) - 1 : undefined,
  };
}

export function inKeyRange(day: string, fromKey: string | null, toKey: string | null): boolean {
  return (fromKey == null || day >= fromKey) && (toKey == null || day <= toKey);
}

export function matchesFilters(t: Trade, f: JournalFilters): boolean {
  if (f.symbol && t.symbol !== f.symbol) return false;
  if (f.side && t.direction !== f.side) return false;
  if (f.result && resultOf(t.netPnl) !== f.result) return false;
  if (f.mood) {
    const m = t.tags?.mood ?? null;
    if (f.mood === 'none' ? m != null : m !== f.mood) return false;
  }
  if (f.setup) {
    const s = normalizeSetup(t.tags?.setup);
    if (f.setup === 'none' ? s != null : s !== f.setup) return false;
  }
  if (f.review === 'reviewed' && !isReviewed(t)) return false;
  if (f.review === 'unreviewed' && isReviewed(t)) return false;
  return true;
}

/** Human summary of the range for subtitles: "Last 30 days", "Oct 1 – Oct 24". */
export function rangeLabel(f: Pick<JournalFilters, 'range' | 'from' | 'to'>, fmtKey: (k: string) => string): string {
  if (f.range !== 'custom') return RANGE_OPTIONS.find((o) => o.value === f.range)?.label ?? '';
  if (f.from && f.to) return f.from === f.to ? fmtKey(f.from) : `${fmtKey(f.from < f.to ? f.from : f.to)} – ${fmtKey(f.from < f.to ? f.to : f.from)}`;
  if (f.from) return `Since ${fmtKey(f.from)}`;
  if (f.to) return `Until ${fmtKey(f.to)}`;
  return 'Custom range';
}
