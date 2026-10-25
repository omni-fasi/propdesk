// Human-readable rule summaries and rule-progress metrics shared by the trade header and account cards.

import type { Account, AccountRules, AccountSnapshot, DrawdownMode } from '@shared/types';
import { ASSET_CLASS_LABELS } from '@shared/instruments';
import { fmtLeverage, fmtMoney, fmtPct } from '@shared/format';

export const DRAWDOWN_LABELS: Record<DrawdownMode, { short: string; long: string }> = {
  static: { short: 'Static', long: 'Static — the failure level never moves' },
  trailing_intraday: { short: 'Intraday trailing', long: 'Trails your peak equity in real time, including open profit' },
  trailing_eod: { short: 'EOD trailing', long: 'Trails your highest end-of-day balance' },
};

function fmtZoned(t: { hour: number; minute: number; tz: string }): string {
  const h12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
  const tz = t.tz === 'America/New_York' ? 'ET' : t.tz === 'local' ? 'local time' : t.tz;
  return `${h12}:${String(t.minute).padStart(2, '0')} ${t.hour < 12 ? 'AM' : 'PM'} ${tz}`;
}

/** One sentence per rule, in display order. */
export function rulesSummary(r: AccountRules): string[] {
  const out: string[] = [];
  out.push(`Starting balance ${fmtMoney(r.startingBalance, { whole: true })}`);
  if (r.profitTarget != null) out.push(`Profit target +${fmtMoney(r.profitTarget, { whole: true })} (${fmtPct(r.profitTarget / r.startingBalance, 0)})`);
  if (r.maxLoss) {
    const lock = r.maxLoss.mode !== 'static' && r.maxLoss.lockAt != null ? `, stops trailing at ${fmtMoney(r.maxLoss.lockAt, { whole: true })}` : '';
    out.push(`Max loss ${fmtMoney(r.maxLoss.amount, { whole: true })} · ${DRAWDOWN_LABELS[r.maxLoss.mode].short.toLowerCase()}${lock}`);
  }
  if (r.dailyLoss) out.push(`Daily loss limit ${fmtMoney(r.dailyLoss.amount, { whole: true })} — ${r.dailyLoss.action === 'fail' ? 'fails the account' : 'locks trading until the next day'}`);
  if (r.minTradingDays > 0) out.push(`Minimum ${r.minTradingDays} trading day${r.minTradingDays === 1 ? '' : 's'}`);
  if (r.maxCalendarDays != null) out.push(`Time limit ${r.maxCalendarDays} days`);
  if (r.consistencyPct != null) out.push(`Best day ≤ ${fmtPct(r.consistencyPct, 0)} of total profit`);
  if (r.maxContracts != null) out.push(`Max ${r.maxContracts} contracts (${r.maxContracts * 10} micros)`);
  if (r.leverage) {
    const lev = Object.entries(r.leverage)
      .map(([k, v]) => `${ASSET_CLASS_LABELS[k as keyof typeof ASSET_CLASS_LABELS]} ${fmtLeverage(v)}`)
      .join(' · ');
    if (lev) out.push(`Leverage ${lev}`);
  }
  if (r.fees === 'off') out.push('No trading fees (switched off on this account)');
  out.push(r.allowedClasses ? `Markets: ${r.allowedClasses.map((c) => ASSET_CLASS_LABELS[c]).join(', ')}` : 'All markets');
  if (r.flatBy) out.push(`Futures auto-flattened at ${fmtZoned(r.flatBy)}`);
  if (r.noWeekendHolding) out.push('No holding over the weekend');
  out.push(`Trading day resets at ${fmtZoned(r.rollover)}`);
  return out;
}

export interface BufferMetric {
  /** $ left before the rule fires. */
  buffer: number;
  /** Rule size in $. */
  amount: number;
  /** buffer / amount, clamped 0..1 — feed to <Meter tone="risk" />. */
  remaining: number;
  threshold: number;
}

export interface AccountMetrics {
  maxLoss: BufferMetric | null;
  dailyLoss: BufferMetric | null;
  target: { profit: number; target: number; progress: number } | null;
  days: { done: number; required: number } | null;
  consistency: { ok: boolean | null; bestDay: number; limitPct: number } | null;
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** Rule progress for an account; the snapshot (live) wins over account fields when present. */
export function accountMetrics(account: Account, snap: AccountSnapshot | null | undefined): AccountMetrics {
  const r = account.rules;
  const balance = snap?.balance ?? account.balance;
  const equity = snap?.equity ?? balance;
  const profit = balance - r.startingBalance;

  let maxLoss: BufferMetric | null = null;
  const mlThreshold = snap?.maxLossThreshold ?? account.maxLossThreshold;
  if (r.maxLoss && mlThreshold != null) {
    const buffer = snap?.maxLossBuffer ?? equity - mlThreshold;
    maxLoss = { buffer, amount: r.maxLoss.amount, remaining: clamp01(buffer / r.maxLoss.amount), threshold: mlThreshold };
  }

  let dailyLoss: BufferMetric | null = null;
  if (r.dailyLoss) {
    const threshold = snap?.dailyLossThreshold ?? account.dayStartBalance - r.dailyLoss.amount;
    const buffer = snap?.dailyLossBuffer ?? equity - threshold;
    dailyLoss = { buffer, amount: r.dailyLoss.amount, remaining: clamp01(buffer / r.dailyLoss.amount), threshold };
  }

  return {
    maxLoss,
    dailyLoss,
    target: r.profitTarget != null ? { profit, target: r.profitTarget, progress: clamp01(profit / r.profitTarget) } : null,
    days: r.minTradingDays > 0 ? { done: snap?.tradingDays ?? account.tradingDays, required: r.minTradingDays } : null,
    consistency: r.consistencyPct != null ? { ok: snap?.consistencyOk ?? null, bestDay: snap?.bestDay ?? 0, limitPct: r.consistencyPct } : null,
  };
}
