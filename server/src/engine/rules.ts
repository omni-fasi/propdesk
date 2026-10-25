// Challenge-rule math and messages (pure). See SPEC §5.

import type { Account, AccountLock, AccountRules, InstrumentSpec, SessionState, ZonedTime } from '../../../shared/types.ts';
import { notional, round2 } from '../../../shared/risk.ts';
import { DAY_MS, NEW_YORK, nextWeekdayTimeAt, tradingDayBounds, zonedParts, zonedTimeToUtc } from '../../../shared/time.ts';
import { ASSET_CLASS_LABELS } from '../../../shared/instruments.ts';
import { money, plural } from './naming.ts';

const EPS = 1e-9;

// ───────────────────────────── max loss / daily loss ─────────────────────────────

/** Trailing threshold for a high-water mark: min(lockAt, hwm − amount), never below `current`. */
export function trailedThreshold(rules: AccountRules, hwm: number, current: number | null): number | null {
  const ml = rules.maxLoss;
  if (!ml) return null;
  if (ml.mode === 'static') return round2(rules.startingBalance - ml.amount);
  const cand = round2(Math.min(ml.lockAt ?? Infinity, hwm - ml.amount));
  return current == null ? cand : Math.max(current, cand);
}

export function initialThreshold(rules: AccountRules): number | null {
  return trailedThreshold(rules, rules.startingBalance, null);
}

/** Equity level at which the daily loss rule fires (dayStartBalance − amount). */
export function dailyLossThreshold(a: Account): number | null {
  return a.rules.dailyLoss ? round2(a.dayStartBalance - a.rules.dailyLoss.amount) : null;
}

// ───────────────────────────── locks ─────────────────────────────

export function isLockActive(lock: AccountLock | null, now: number): lock is AccountLock {
  return lock != null && (lock.until == null || lock.until > now);
}

/** Effective end of a lock; `until: null` means the next rollover (`dayEnd`). */
export function lockEnd(lock: AccountLock, dayEnd: number): number {
  return lock.until ?? dayEnd;
}

export const LOCK_TITLES: Record<AccountLock['reason'], string> = {
  daily_loss: 'Daily loss limit hit — trading locked',
  tilt_cooldown: 'Tilt guard — cooldown',
  max_trades: 'Max trades for today reached',
  personal_loss_limit: 'Personal daily stop hit',
  break: 'Taking a break',
};

export const UNLOCK_MESSAGES: Record<AccountLock['reason'], string> = {
  daily_loss: 'New trading day — your daily loss limit has reset.',
  tilt_cooldown: 'Cooldown over. Breathe, re-read your plan, then trade.',
  max_trades: 'New trading day — your trade count has reset.',
  personal_loss_limit: 'New trading day — your personal daily stop has reset.',
  break: 'Break over. Welcome back — trade your plan.',
};

/** Locks that last until the next rollover and are cleared by it. */
export const DAY_LOCKS: ReadonlySet<AccountLock['reason']> = new Set(['daily_loss', 'max_trades', 'personal_loss_limit']);

// ───────────────────────────── time / sessions ─────────────────────────────

const etFormatter = new Intl.DateTimeFormat('en-US', { timeZone: NEW_YORK, weekday: 'short', hour: 'numeric', minute: '2-digit' });
const nbsp = /[  ]/g;

/** "Sun 6:00 PM" (America/New_York). */
export function fmtEt(ts: number): string {
  return etFormatter.format(ts).replace(nbsp, ' ');
}

/** "4:10 PM ET" for New York times, "4:10 PM (Europe/London)" otherwise. */
export function fmtZoned(z: ZonedTime): string {
  const h12 = z.hour % 12 === 0 ? 12 : z.hour % 12;
  const t = `${h12}:${String(z.minute).padStart(2, '0')} ${z.hour < 12 ? 'AM' : 'PM'}`;
  return z.tz === NEW_YORK ? `${t} ET` : `${t} (${z.tz})`;
}

export function marketClosedMessage(s: SessionState): string {
  return s.nextChange == null ? 'Market closed' : `Market closed — opens ${fmtEt(s.nextChange)} ET`;
}

/** The flat-by instant inside trading day `day`, or null (no flatBy / weekend day). */
export function flatByInDay(rules: AccountRules, day: string): number | null {
  if (!rules.flatBy) return null;
  const b = tradingDayBounds(day, rules.rollover);
  const at = nextWeekdayTimeAt(b.start - 1, rules.flatBy);
  return at < b.end ? at : null;
}

const WEEKEND_FLAT: ZonedTime = { hour: 16, minute: 55, tz: NEW_YORK };

/** When positions must be flat before the weekend: Friday at flatBy, or 16:55 ET. */
export function weekendFlatTime(rules: AccountRules): ZonedTime {
  return rules.flatBy ?? WEEKEND_FLAT;
}

/** Next Friday instant strictly after `ts` at wall time `z`. */
export function nextFridayAt(ts: number, z: ZonedTime): number {
  let t = ts;
  for (let i = 0; i < 6; i++) {
    t = nextWeekdayTimeAt(t, z);
    if (zonedParts(t, z.tz).weekday === 5) return t;
  }
  return ts + 7 * DAY_MS;
}

/** Sunday 18:00 ET following a Friday instant (CME / weekend reopen). */
function sundayReopenAfter(friday: number): number {
  const p = zonedParts(friday, NEW_YORK);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + ((7 - p.weekday) % 7 || 7)));
  return zonedTimeToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 18, 0, NEW_YORK);
}

/** noWeekendHolding: new entries are blocked from the Friday flat time until Sunday 18:00 ET. */
export function inWeekendBlock(rules: AccountRules, t: number): boolean {
  if (!rules.noWeekendHolding) return false;
  const fri = nextFridayAt(t - 7 * DAY_MS, weekendFlatTime(rules));
  return fri <= t && t < sundayReopenAfter(fri);
}

// ───────────────────────────── exposure ─────────────────────────────

/**
 * Margin of a position: |notional| / leverage[class] (missing class = 1:1), 0 without a leverage table.
 * Futures are governed by the contract limit instead (per-contract margin in reality), so they use no
 * notional margin whenever the account has a maxContracts rule.
 */
export function marginFor(rules: AccountRules, spec: InstrumentSpec, qty: number, price: number): number {
  if (!rules.leverage) return 0;
  if (spec.assetClass === 'futures' && rules.maxContracts != null) return 0;
  return notional(spec, qty, price) / (rules.leverage[spec.assetClass] ?? 1);
}

export function maxContractsMessage(max: number): string {
  const micros = Number((max * 10).toFixed(2));
  return `Max position size is ${plural(Number(max.toFixed(2)), 'contract')} (${micros} micros)`;
}

export function classNotAllowedMessage(rules: AccountRules, spec: InstrumentSpec): string {
  const allowed = (rules.allowedClasses ?? []).map((c) => ASSET_CLASS_LABELS[c]).join(', ');
  return `${ASSET_CLASS_LABELS[spec.assetClass]} can't be traded on this account (allowed: ${allowed})`;
}

// ───────────────────────────── passing ─────────────────────────────

export function consistencyOk(rules: AccountRules, bestDay: number, profit: number): boolean | null {
  if (rules.consistencyPct == null) return null;
  return bestDay <= rules.consistencyPct * Math.max(0, profit) + 0.005;
}

/**
 * Why an evaluation has not passed yet, besides the profit target itself
 * ("Close your open positions to lock in the pass", "Trade 1 more day (2 required)", consistency).
 */
export function passBlockers(a: Account, x: { openPositions: number; openPnl: number; bestDay: number }): string[] {
  const r = a.rules;
  if (a.kind !== 'evaluation' || a.status !== 'active' || r.profitTarget == null) return [];
  const out: string[] = [];
  const profit = a.balance - r.startingBalance;
  const reached = profit >= r.profitTarget - EPS || profit + x.openPnl >= r.profitTarget - EPS;
  if (x.openPositions > 0 && reached) out.push('Close your open positions to lock in the pass');
  if (a.tradingDays < r.minTradingDays) {
    const n = r.minTradingDays - a.tradingDays;
    out.push(`Trade ${plural(n, 'more day')} (${r.minTradingDays} required)`);
  }
  if (r.consistencyPct != null && profit > 0 && consistencyOk(r, x.bestDay, profit) === false) {
    out.push(
      `Best day is ${Math.round((x.bestDay / profit) * 100)}% of profit — max ${Math.round(r.consistencyPct * 100)}%. Keep trading to dilute it.`,
    );
  }
  return out;
}

/** All pass conditions hold. */
export function canPass(a: Account, openPositions: number, bestDay: number): boolean {
  const r = a.rules;
  if (a.kind !== 'evaluation' || a.status !== 'active' || r.profitTarget == null || openPositions > 0) return false;
  const profit = a.balance - r.startingBalance;
  if (profit < r.profitTarget - EPS) return false;
  if (a.tradingDays < r.minTradingDays) return false;
  return consistencyOk(r, bestDay, profit) !== false;
}

export function targetText(r: AccountRules): string {
  return r.profitTarget == null ? 'no target' : `+${money(r.profitTarget)}`;
}
