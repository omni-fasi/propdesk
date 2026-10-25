// Defensive validation of untrusted input. Every failure throws EngineError('invalid', <human message>).

import type { AccountRules, AssetClass, DrawdownMode, Mood, TradeReview, TradeTags, ZonedTime } from '../../../shared/types.ts';
import { LOCAL_MIDNIGHT } from '../../../shared/presets.ts';
import { MOOD_MAP } from '../../../shared/journal.ts';
import { EMPTY_TAGS } from '../store.ts';
import { fail } from './errors.ts';

export type Obj = Record<string, unknown>;

export const ASSET_CLASSES: readonly AssetClass[] = ['futures', 'crypto', 'metals', 'energy', 'stocks', 'forex'];
const DRAWDOWN_MODES: readonly DrawdownMode[] = ['static', 'trailing_intraday', 'trailing_eod'];

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asObj(v: unknown, what: string): Obj {
  if (!isObj(v)) fail('invalid', `${what} must be an object`);
  return v;
}

export interface NumOpts {
  min?: number;
  max?: number;
  int?: boolean;
  /** min is exclusive (value must be > min). */
  gt?: boolean;
}

export function num(v: unknown, what: string, o: NumOpts = {}): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail('invalid', `${what} must be a number`);
  if (o.int && !Number.isInteger(v)) fail('invalid', `${what} must be a whole number`);
  if (o.min != null && (o.gt ? v <= o.min : v < o.min)) fail('invalid', `${what} must be ${o.gt ? 'greater than' : 'at least'} ${o.min}`);
  if (o.max != null && v > o.max) fail('invalid', `${what} must be at most ${o.max}`);
  return v;
}

/** undefined / null → null. */
export function nullableNum(v: unknown, what: string, o: NumOpts = {}): number | null {
  return v == null ? null : num(v, what, o);
}

export function str(v: unknown, what: string, max = 200): string {
  if (typeof v !== 'string') fail('invalid', `${what} must be a string`);
  if (v.length > max) fail('invalid', `${what} is too long (max ${max} characters)`);
  return v;
}

/** Trimmed string, '' / undefined / null → null. */
export function optText(v: unknown, what: string, max: number): string | null {
  if (v == null) return null;
  const t = str(v, what, max).trim();
  return t === '' ? null : t;
}

export function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') fail('invalid', `${what} must be true or false`);
  return v;
}

export function oneOf<T extends string>(v: unknown, values: readonly T[], what: string): T {
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) fail('invalid', `${what} must be one of: ${values.join(', ')}`);
  return v as T;
}

export function isValidTimeZone(tz: string): boolean {
  if (tz === 'local') return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function zonedTime(v: unknown, what: string): ZonedTime {
  const o = asObj(v, what);
  const tz = str(o.tz, `${what}.tz`, 64);
  if (!isValidTimeZone(tz)) fail('invalid', `${what}.tz is not a known time zone`);
  return { hour: num(o.hour, `${what}.hour`, { int: true, min: 0, max: 23 }), minute: num(o.minute, `${what}.minute`, { int: true, min: 0, max: 59 }), tz };
}

export function mood(v: unknown, what: string): Mood | null {
  if (v == null) return null;
  if (typeof v !== 'string' || !(v in MOOD_MAP)) fail('invalid', `${what} is not a known mood`);
  return v as Mood;
}

/** Validate custom challenge rules (POST /accounts with `rules`). */
export function validateRules(input: unknown): AccountRules {
  const r = asObj(input, 'rules');
  const startingBalance = num(r.startingBalance, 'Starting balance', { min: 1_000, max: 10_000_000 });

  let maxLoss: AccountRules['maxLoss'] = null;
  if (r.maxLoss != null) {
    const m = asObj(r.maxLoss, 'maxLoss');
    maxLoss = {
      amount: num(m.amount, 'Max loss', { min: 0, gt: true, max: startingBalance }),
      mode: oneOf(m.mode, DRAWDOWN_MODES, 'Max loss mode'),
      lockAt: nullableNum(m.lockAt, 'Max loss lock level', { min: 0, max: startingBalance * 10 }),
    };
  }

  let dailyLoss: AccountRules['dailyLoss'] = null;
  if (r.dailyLoss != null) {
    const d = asObj(r.dailyLoss, 'dailyLoss');
    dailyLoss = {
      amount: num(d.amount, 'Daily loss limit', { min: 0, gt: true, max: startingBalance }),
      action: oneOf(d.action, ['fail', 'lock'] as const, 'Daily loss action'),
    };
  }

  let leverage: AccountRules['leverage'] = null;
  if (r.leverage != null) {
    const l = asObj(r.leverage, 'leverage');
    leverage = {};
    for (const [k, v] of Object.entries(l)) {
      const cls = oneOf(k, ASSET_CLASSES, 'Leverage asset class');
      leverage[cls] = num(v, `Leverage for ${cls}`, { min: 0, gt: true, max: 1000 });
    }
  }

  let allowedClasses: AssetClass[] | null = null;
  if (r.allowedClasses != null) {
    if (!Array.isArray(r.allowedClasses) || r.allowedClasses.length === 0) fail('invalid', 'Allowed markets must be a non-empty list');
    allowedClasses = [...new Set(r.allowedClasses.map((c) => oneOf(c, ASSET_CLASSES, 'Allowed market')))];
  }

  return {
    startingBalance,
    profitTarget: nullableNum(r.profitTarget, 'Profit target', { min: 0, gt: true, max: startingBalance * 10 }),
    maxLoss,
    dailyLoss,
    minTradingDays: r.minTradingDays == null ? 0 : num(r.minTradingDays, 'Minimum trading days', { int: true, min: 0, max: 365 }),
    maxCalendarDays: nullableNum(r.maxCalendarDays, 'Time limit (days)', { int: true, min: 1, max: 3650 }),
    consistencyPct: nullableNum(r.consistencyPct, 'Consistency rule', { min: 0, gt: true, max: 1 }),
    maxContracts: nullableNum(r.maxContracts, 'Max contracts', { min: 0, gt: true, max: 10_000 }),
    leverage,
    allowedClasses,
    flatBy: r.flatBy == null ? null : zonedTime(r.flatBy, 'flatBy'),
    noWeekendHolding: r.noWeekendHolding == null ? false : bool(r.noWeekendHolding, 'noWeekendHolding'),
    rollover: r.rollover == null ? { ...LOCAL_MIDNIGHT } : zonedTime(r.rollover, 'rollover'),
  };
}

/** Merge a partial tag update into `base` (fields that are absent stay unchanged; null clears). */
export function mergeTags(base: TradeTags, input: unknown): TradeTags {
  if (input == null) return { ...base };
  const t = asObj(input, 'tags');
  const out = { ...base };
  if ('mood' in t) out.mood = mood(t.mood, 'Mood');
  if ('setup' in t) out.setup = optText(t.setup, 'Setup', 60);
  if ('confidence' in t) out.confidence = nullableNum(t.confidence, 'Confidence', { int: true, min: 1, max: 5 });
  if ('plan' in t) out.plan = optText(t.plan, 'Plan', 2000);
  return out;
}

/** Tags from an entry order: null when nothing was provided. */
export function orderTags(input: unknown): TradeTags | null {
  if (input == null) return null;
  const tags = mergeTags(EMPTY_TAGS, input);
  return tags.mood == null && tags.setup == null && tags.confidence == null && tags.plan == null ? null : tags;
}

export function validateReview(input: unknown, now: number): TradeReview | null {
  if (input === null) return null;
  const r = asObj(input, 'review');
  let mistakes: string[] = [];
  if (r.mistakes != null) {
    if (!Array.isArray(r.mistakes) || r.mistakes.length > 30) fail('invalid', 'Mistakes must be a list (max 30)');
    mistakes = [...new Set(r.mistakes.map((m) => str(m, 'Mistake', 80).trim()).filter((m) => m !== ''))];
  }
  return {
    followedPlan: r.followedPlan == null ? null : bool(r.followedPlan, 'Followed plan'),
    rating: nullableNum(r.rating, 'Rating', { int: true, min: 1, max: 5 }),
    mistakes,
    moodAfter: mood(r.moodAfter, 'Mood after'),
    note: optText(r.note, 'Note', 5000),
    reviewedAt: now,
  };
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function isDayKey(v: unknown): v is string {
  if (typeof v !== 'string' || !DAY_KEY.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function dayKeyArg(v: unknown, what: string): string {
  if (!isDayKey(v)) fail('invalid', `${what} must be a date (YYYY-MM-DD)`);
  return v;
}
