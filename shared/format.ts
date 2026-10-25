// Display formatting shared by server messages and the UI.

import type { InstrumentSpec } from './types.ts';

const MINUS = '−';

const usd2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export interface MoneyOptions {
  /** Show + for positive values. */
  sign?: boolean;
  /** Drop cents. */
  whole?: boolean;
  /** $1.2K style. */
  compact?: boolean;
}

/** $1,234.56 · −$80.00 · +$12.50 (sign option). */
export function fmtMoney(n: number, opts: MoneyOptions = {}): string {
  if (!Number.isFinite(n)) return '—';
  const v = Math.abs(n) < 0.005 ? 0 : n;
  const abs = Math.abs(v);
  const body = opts.compact && abs >= 10_000 ? compactFmt.format(abs) : opts.whole ? usd0.format(Math.round(abs)) : usd2.format(abs);
  const prefix = v < 0 ? MINUS : opts.sign && v > 0 ? '+' : '';
  return `${prefix}$${body}`;
}

export function fmtSignedMoney(n: number, opts: Omit<MoneyOptions, 'sign'> = {}): string {
  return fmtMoney(n, { ...opts, sign: true });
}

/** 0.1234 → 12.3% */
export function fmtPct(fraction: number, digits = 1, sign = false): string {
  if (!Number.isFinite(fraction)) return '—';
  const v = fraction * 100;
  const s = Math.abs(v).toFixed(digits);
  const prefix = v < 0 && Number(s) !== 0 ? MINUS : sign && v > 0 ? '+' : '';
  return `${prefix}${s}%`;
}

/** 10 → '10×', 2.5 → '2.5×' (leverage: position value per $1 of account). */
export function fmtLeverage(leverage: number): string {
  return `${Number(leverage.toFixed(2))}×`;
}

export function fmtNumber(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return '—';
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return n < 0 ? `${MINUS}${s}` : s;
}

export function fmtPrice(spec: Pick<InstrumentSpec, 'pricePrecision'>, price: number | null | undefined): string {
  if (price == null || !Number.isFinite(price)) return '—';
  return price.toLocaleString('en-US', { minimumFractionDigits: spec.pricePrecision, maximumFractionDigits: spec.pricePrecision });
}

export function fmtQty(spec: Pick<InstrumentSpec, 'qtyPrecision'>, qty: number): string {
  return Math.abs(qty).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: spec.qtyPrecision });
}

/** "2 contracts", "1 lot", "0.05 BTC" … */
export function fmtQtyWithUnit(spec: Pick<InstrumentSpec, 'qtyPrecision' | 'unitLabel'>, qty: number): string {
  const q = fmtQty(spec, qty);
  const plural = ['contracts', 'lots', 'shares'].includes(spec.unitLabel);
  const unit = plural && Math.abs(qty) === 1 ? spec.unitLabel.slice(0, -1) : spec.unitLabel;
  return `${q} ${unit}`;
}

/** 45s · 12m 05s · 2h 14m · 3d 4h */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** 14:59 · 1:02:03 */
export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** Hours of work an amount represents at an hourly wage, or null. */
export function workHours(amount: number, hourlyWage: number | null | undefined): number | null {
  if (!hourlyWage || hourlyWage <= 0 || !Number.isFinite(amount) || Math.abs(amount) < 0.005) return null;
  return Math.abs(amount) / hourlyWage;
}

/** "≈ 6.5 h of work" · "≈ 25 min of work" · "≈ 3.2 days of work" (8 h days). */
export function fmtWorkHours(amount: number, hourlyWage: number | null | undefined): string | null {
  const h = workHours(amount, hourlyWage);
  if (h == null) return null;
  if (h < 1) return `≈ ${Math.max(1, Math.round(h * 60))} min of work`;
  if (h < 40) return `≈ ${h < 10 ? h.toFixed(1) : Math.round(h)} h of work`;
  return `≈ ${(h / 8).toFixed(1)} days of work`;
}
