// Account names and small text helpers for event messages.

import type { ChallengePreset, InstrumentSpec } from '../../../shared/types.ts';
import { fmtMoney, fmtPrice, fmtQtyWithUnit } from '../../../shared/format.ts';

/** 50000 → '50K', 1500 → '1.5K', 2000000 → '2M'. */
export function sizeLabel(n: number): string {
  const fmt = (x: number) => String(Number(x.toFixed(1)));
  if (n >= 1_000_000) return `${fmt(n / 1_000_000)}M`;
  if (n >= 1_000) return `${fmt(n / 1_000)}K`;
  return fmt(n);
}

/** "Futures 50K", "2-Step 50K · Phase 2", "Futures 50K · Attempt 3". phaseIndex is 0-based. */
export function presetAccountName(preset: ChallengePreset, phaseIndex: number, attempt: number): string {
  let name = preset.name;
  if (preset.phases.length > 1) name += ` · ${preset.phases[phaseIndex]?.name ?? `Phase ${phaseIndex + 1}`}`;
  if (attempt > 1) name += ` · Attempt ${attempt}`;
  return name;
}

export const practiceName = (balance: number) => `Live ${sizeLabel(balance)}`;
export const customName = (balance: number) => `Custom ${sizeLabel(balance)}`;

/** "Futures 50K · Funded" (drops the phase / attempt suffixes of the evaluation name). */
export function fundedName(preset: ChallengePreset | null, evaluationName: string): string {
  return `${preset ? preset.name : evaluationName.split(' · ')[0]} · Funded`;
}

export const signed = (n: number) => fmtMoney(n, { sign: true });
export const money = (n: number) => fmtMoney(n);
export const moneyWhole = (n: number) => fmtMoney(n, { whole: true });
export const px = (spec: InstrumentSpec, p: number) => fmtPrice(spec, p);
export const qtyText = (spec: InstrumentSpec, q: number) => fmtQtyWithUnit(spec, q);

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
