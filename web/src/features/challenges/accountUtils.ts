// Pure helpers about accounts, attempts and their cost.

import type { Account, ChallengePreset, ExitReason, LockReason } from '@shared/types';
import { PRESET_MAP } from '@shared/presets';
import { nextRolloverAt } from '@shared/time';

export function presetOf(account: Account | null | undefined, presets: ChallengePreset[]): ChallengePreset | null {
  if (!account?.presetId) return null;
  return presets.find((p) => p.id === account.presetId) ?? PRESET_MAP[account.presetId] ?? null;
}

export function presetById(id: string, presets: ChallengePreset[]): ChallengePreset | null {
  return presets.find((p) => p.id === id) ?? PRESET_MAP[id] ?? null;
}

export function isFinalPhase(a: Account): boolean {
  return a.kind === 'evaluation' && a.phase >= a.phaseCount;
}

function children(id: string, accounts: Record<string, Account>): Account[] {
  return Object.values(accounts)
    .filter((a) => a.parentId === id)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** The next phase created automatically when `a` passed a non-final phase. */
export function nextPhaseOf(a: Account, accounts: Record<string, Account>): Account | null {
  return children(a.id, accounts).find((c) => c.kind === 'evaluation' && c.phase === a.phase + 1) ?? null;
}

/** The funded account activated from a passed final phase. */
export function fundedOf(a: Account, accounts: Record<string, Account>): Account | null {
  return children(a.id, accounts).find((c) => c.kind === 'funded') ?? null;
}

/** The new attempt bought after `a` failed. */
export function retryOf(a: Account, accounts: Record<string, Account>): Account | null {
  if (a.status !== 'failed') return null;
  return children(a.id, accounts).find((c) => c.kind === 'evaluation') ?? null;
}

/**
 * What this attempt cost from the wallet: the account's own fee plus the fees of the earlier phases it
 * continued from (phase 1 → phase 2 → funded). Walking stops at a failed parent — that was a previous attempt.
 */
export function attemptCost(account: Account, accounts: Record<string, Account>): number {
  let total = account.fee;
  let cur = account;
  const seen = new Set([account.id]);
  while (cur.parentId) {
    const parent = accounts[cur.parentId];
    if (!parent || seen.has(parent.id) || parent.status !== 'passed') break;
    total += parent.fee;
    seen.add(parent.id);
    cur = parent;
  }
  return total;
}

/** Price of a new attempt after failing, or null when the account can't be retried (custom, funded, practice). */
export function retryPrice(a: Account, presets: ChallengePreset[]): number | null {
  if (a.kind !== 'evaluation' || a.status !== 'failed') return null;
  const p = presetOf(a, presets);
  if (!p) return null;
  return p.resetFee ?? p.fee;
}

/** Activation fee of a passed final phase that has a funded stage, or null. */
export function activationPrice(a: Account, presets: ChallengePreset[]): number | null {
  if (a.status !== 'passed' || !isFinalPhase(a)) return null;
  const p = presetOf(a, presets);
  if (!p?.funded) return null;
  return p.activationFee;
}

/** When a lock lifts: its own `until`, or the account's next trading-day rollover. */
export function lockEndsAt(account: Account, now: number): number | null {
  const lock = account.lock;
  if (!lock) return null;
  if (lock.until != null) return lock.until;
  try {
    return nextRolloverAt(now, account.rules.rollover);
  } catch {
    return null;
  }
}

export const LOCK_LABELS: Record<LockReason, string> = {
  daily_loss: 'Daily loss limit',
  tilt_cooldown: 'Tilt cooldown',
  max_trades: 'Max trades for today',
  personal_loss_limit: 'Personal daily stop',
  break: 'On a break',
};

export const EXIT_LABELS: Record<ExitReason, string> = {
  manual: 'Closed manually',
  stop_loss: 'Stop-loss hit',
  take_profit: 'Take-profit hit',
  limit: 'Limit exit',
  reversal: 'Reversed',
  breach: 'Liquidated on breach',
  daily_loss: 'Liquidated on daily loss',
  auto_flatten: 'Auto-flattened',
  passed: 'Closed on pass',
};

/** "3d 4h", "45m" … between two instants. */
export function lifespan(from: number, to: number): string {
  const ms = Math.max(0, to - from);
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function shortSize(n: number): string {
  return n >= 1000 && n % 1000 === 0 ? `${n / 1000}K` : n.toLocaleString('en-US');
}
