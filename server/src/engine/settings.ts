// Settings: defaults + persisted values, and validated partial updates (PUT /settings).

import type { Settings, TiltSettings, Timeframe } from '../../../shared/types.ts';
import { FILL_SOUNDS, TIMEFRAMES, TV_SOUNDS } from '../../../shared/types.ts';
import { DEFAULT_SETTINGS } from '../../../shared/journal.ts';
import { INSTRUMENT_MAP } from '../../../shared/instruments.ts';
import { EngineError, fail } from './errors.ts';
import { asObj, bool, isObj, nullableNum, num, oneOf, optText, str } from './validation.ts';

type Field<K extends keyof Settings> = (v: unknown) => Settings[K];

function watchlist(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 200) fail('invalid', 'Watchlist must be a list of symbols');
  // Unknown symbols are dropped silently (the catalog may change between versions).
  return [...new Set(v.map((s) => str(s, 'Watchlist symbol', 32)))].filter((s) => s in INSTRUMENT_MAP);
}

function tiltPatch(base: TiltSettings, v: unknown): TiltSettings {
  const t = asObj(v, 'tilt');
  const out = { ...base };
  if ('enabled' in t) out.enabled = bool(t.enabled, 'Tilt guard');
  if ('maxConsecutiveLosses' in t) out.maxConsecutiveLosses = num(t.maxConsecutiveLosses, 'Max losses in a row', { int: true, min: 0, max: 100 });
  if ('cooldownMinutes' in t) out.cooldownMinutes = num(t.cooldownMinutes, 'Cooldown minutes', { min: 1, max: 24 * 60 });
  if ('maxTradesPerDay' in t) out.maxTradesPerDay = nullableNum(t.maxTradesPerDay, 'Max trades per day', { int: true, min: 1, max: 1000 });
  if ('personalDailyLoss' in t) out.personalDailyLoss = nullableNum(t.personalDailyLoss, 'Personal daily loss', { min: 0, gt: true, max: 10_000_000 });
  return out;
}

const FIELDS: { [K in Exclude<keyof Settings, 'tilt'>]: Field<K> } = {
  onboarded: (v) => bool(v, 'onboarded'),
  traderName: (v) => optText(v, 'Name', 60),
  hourlyWage: (v) => nullableNum(v, 'Hourly wage', { min: 0, max: 100_000 }),
  showWorkHours: (v) => bool(v, 'showWorkHours'),
  sounds: (v) => bool(v, 'sounds'),
  fillSound: (v) => oneOf(v, FILL_SOUNDS, 'fillSound'),
  alertSound: (v) => (v == null ? null : oneOf(v, TV_SOUNDS, 'alertSound')),
  volume: (v) => num(v, 'Volume', { min: 0, max: 1 }),
  notifications: (v) => bool(v, 'notifications'),
  confirmOrders: (v) => oneOf(v, ['always', 'risky', 'never'] as const, 'confirmOrders'),
  riskyPct: (v) => num(v, 'riskyPct', { min: 0, max: 1 }),
  requireStopLoss: (v) => bool(v, 'requireStopLoss'),
  emotionCheckin: (v) => oneOf(v, ['required', 'optional', 'off'] as const, 'emotionCheckin'),
  postTradeReview: (v) => bool(v, 'postTradeReview'),
  revengeGuard: (v) => bool(v, 'revengeGuard'),
  monthlyBudget: (v) => nullableNum(v, 'Monthly budget', { min: 0, max: 10_000_000 }),
  watchlist,
  activeAccountId: (v) => (v == null ? null : str(v, 'activeAccountId', 64)),
  chartTimeframe: (v) => oneOf(v, TIMEFRAMES, 'chartTimeframe') as Timeframe,
  lastSymbol: (v) => {
    const s = str(v, 'lastSymbol', 32);
    if (!(s in INSTRUMENT_MAP)) fail('invalid', `Unknown symbol ${s}`);
    return s;
  },
};

/** Apply a partial update. Unknown keys are ignored; invalid values throw EngineError('invalid'). */
export function applySettingsPatch(current: Settings, patch: unknown): Settings {
  const p = asObj(patch, 'settings');
  const next: Settings = { ...current, tilt: { ...current.tilt }, watchlist: [...current.watchlist] };
  for (const [key, value] of Object.entries(p)) {
    if (key === 'tilt') {
      next.tilt = tiltPatch(next.tilt, value);
    } else if (key in FIELDS) {
      const k = key as keyof typeof FIELDS;
      (next as unknown as Record<string, unknown>)[k] = FIELDS[k](value);
    }
  }
  return next;
}

/** Defaults overlaid with whatever valid values were persisted (invalid / missing ones fall back to defaults). */
export function mergeSettings(stored: unknown): Settings {
  const base: Settings = { ...DEFAULT_SETTINGS, tilt: { ...DEFAULT_SETTINGS.tilt }, watchlist: [...DEFAULT_SETTINGS.watchlist] };
  if (!isObj(stored)) return base;
  let out = base;
  for (const [key, value] of Object.entries(stored)) {
    try {
      out = applySettingsPatch(out, { [key]: value });
    } catch (err) {
      if (!(err instanceof EngineError)) throw err;
    }
  }
  return out;
}
