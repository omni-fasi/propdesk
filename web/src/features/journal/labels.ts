// Labels and small formatters shared by the Journal and the P&L Calendar.

import type { Account, ExitReason, InstrumentSpec, Mood, Trade } from '@shared/types';
import { MOOD_MAP } from '@shared/journal';
import { getInstrument } from '@shared/instruments';
import { fmtNumber, fmtPrice, fmtQty } from '@/lib/format';

const MINUS = '−';

export const EXIT_REASON_LABELS: Record<ExitReason, string> = {
  manual: 'Manual',
  stop_loss: 'Stop loss',
  take_profit: 'Take profit',
  limit: 'Limit',
  reversal: 'Reversed',
  breach: 'Max-loss breach',
  daily_loss: 'Daily loss limit',
  auto_flatten: 'Auto-flatten',
  passed: 'Target reached',
};

export function exitReasonLabel(reason: ExitReason | null | undefined): string {
  return reason ? (EXIT_REASON_LABELS[reason] ?? reason) : '—';
}

/** Exits forced by a rule get a semantic color; everything else stays neutral. */
export function exitReasonClass(reason: ExitReason | null | undefined): string {
  if (reason === 'breach' || reason === 'daily_loss') return 'text-loss';
  if (reason === 'auto_flatten') return 'text-warn';
  return 'text-muted';
}

/** +1.25R · −0.80R · — */
export function fmtR(r: number | null | undefined, digits = 2): string {
  if (r == null || !Number.isFinite(r)) return '—';
  const s = Math.abs(r).toFixed(digits);
  const zero = Number(s) === 0;
  return `${r < 0 && !zero ? MINUS : r > 0 && !zero ? '+' : ''}${s}R`;
}

/** Profit factor: 1.85 · ∞ (no losses) · — (nothing to compare). */
export function fmtProfitFactor(pf: number | null | undefined): string {
  if (pf == null || Number.isNaN(pf)) return '—';
  if (!Number.isFinite(pf)) return '∞';
  return pf.toFixed(2);
}

export function moodEmoji(mood: Mood | null | undefined): string {
  return mood ? (MOOD_MAP[mood]?.emoji ?? '') : '';
}

export function moodLabel(mood: Mood | null | undefined): string {
  return mood ? (MOOD_MAP[mood]?.label ?? mood) : 'No mood logged';
}

export function specOf(map: Record<string, InstrumentSpec>, symbol: string): InstrumentSpec | undefined {
  return map[symbol] ?? getInstrument(symbol);
}

export function fmtTradePrice(map: Record<string, InstrumentSpec>, symbol: string, price: number | null | undefined): string {
  if (price == null || !Number.isFinite(price)) return '—';
  const spec = specOf(map, symbol);
  return spec ? fmtPrice(spec, price) : fmtNumber(price, 2);
}

export function fmtTradeQty(map: Record<string, InstrumentSpec>, symbol: string, qty: number): string {
  const spec = specOf(map, symbol);
  return spec ? fmtQty(spec, qty) : String(qty);
}

export function accountName(accounts: Record<string, Account>, id: string): string {
  return accounts[id]?.name ?? 'Unknown account';
}

export function directionLabel(t: Pick<Trade, 'direction'>): string {
  return t.direction === 'long' ? 'Long' : 'Short';
}

export function directionClass(t: Pick<Trade, 'direction'>): string {
  return t.direction === 'long' ? 'text-profit' : 'text-loss';
}

const longDay = new Intl.DateTimeFormat('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** 'YYYY-MM-DD' → "Wednesday, October 14, 2026". */
export function fmtDayLong(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return longDay.format(Date.UTC(y, m - 1, d, 12));
}

/** Money for prose: whole dollars from $100 up, cents below. */
export function fmtMoneyProse(n: number, sign = true): string {
  const abs = Math.abs(n);
  const body = abs >= 100 ? Math.round(abs).toLocaleString('en-US') : abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const zero = abs < 0.005;
  return `${n < 0 && !zero ? MINUS : sign && n > 0 && !zero ? '+' : ''}$${body}`;
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? word : pluralWord}`;
}
