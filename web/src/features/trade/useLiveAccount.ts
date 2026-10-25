// Live account figures between (throttled) server snapshots: open P&L re-marked from quotes, and the
// equity, day P&L and rule buffers that follow from it.

import { useCallback, useMemo } from 'react';
import type { Account, AccountSnapshot, Quote } from '@shared/types';
import { useApp } from '@/store/app';
import { livePositionPnl, useAccountPositions } from '@/store/hooks';
import { useMarket } from '@/store/market';
import { accountMetrics, type AccountMetrics } from '@/lib/rules';

/** Σ open P&L of an account's positions at live quotes (cents). 0 without positions. */
export function useLiveOpenPnl(accountId: string | null | undefined): number {
  const positions = useAccountPositions(accountId);
  const instrumentMap = useApp((s) => s.instrumentMap);
  const select = useCallback(
    (s: { quotes: Record<string, Quote> }) => {
      let sum = 0;
      for (const p of positions) sum += livePositionPnl(p, instrumentMap[p.symbol], s.quotes[p.symbol]).openPnl;
      return Math.round(sum * 100) / 100;
    },
    [positions, instrumentMap],
  );
  return useMarket(select);
}

export interface LiveFigures {
  balance: number;
  equity: number;
  openPnl: number;
  dayPnl: number;
  dayRealized: number;
  maxLossThreshold: number | null;
  maxLossBuffer: number | null;
  dailyLossThreshold: number | null;
  dailyLossBuffer: number | null;
}

export function liveFigures(account: Account, snap: AccountSnapshot | null, openPnl: number): LiveFigures {
  const r = account.rules;
  const balance = snap?.balance ?? account.balance;
  const equity = balance + openPnl;
  const dayRealized = snap?.dayRealized ?? 0;
  let mlThreshold = snap?.maxLossThreshold ?? account.maxLossThreshold;
  if (r.maxLoss && mlThreshold != null && r.maxLoss.mode === 'trailing_intraday') {
    // The intraday threshold trails peak equity tick by tick and never moves down.
    mlThreshold = Math.max(mlThreshold, Math.min(r.maxLoss.lockAt ?? Infinity, equity - r.maxLoss.amount));
  }
  const dailyThreshold = snap?.dailyLossThreshold ?? (r.dailyLoss ? account.dayStartBalance - r.dailyLoss.amount : null);
  return {
    balance,
    equity,
    openPnl,
    dayPnl: dayRealized + openPnl,
    dayRealized,
    maxLossThreshold: r.maxLoss ? mlThreshold : null,
    maxLossBuffer: r.maxLoss && mlThreshold != null ? equity - mlThreshold : null,
    dailyLossThreshold: dailyThreshold,
    dailyLossBuffer: dailyThreshold != null ? equity - dailyThreshold : null,
  };
}

/** Snapshot-shaped live view for accountMetrics(). */
function liveSnapshot(account: Account, snap: AccountSnapshot | null, f: LiveFigures): AccountSnapshot {
  return {
    accountId: account.id,
    ts: snap?.ts ?? 0,
    status: snap?.status ?? account.status,
    balance: f.balance,
    equity: f.equity,
    openPnl: f.openPnl,
    dayRealized: f.dayRealized,
    dayPnl: f.dayPnl,
    tradingDay: snap?.tradingDay ?? account.tradingDay,
    maxLossThreshold: f.maxLossThreshold,
    maxLossBuffer: f.maxLossBuffer,
    dailyLossThreshold: f.dailyLossThreshold,
    dailyLossBuffer: f.dailyLossBuffer,
    profit: f.balance - account.rules.startingBalance,
    targetProgress: snap?.targetProgress ?? null,
    tradingDays: snap?.tradingDays ?? account.tradingDays,
    bestDay: snap?.bestDay ?? 0,
    consistencyOk: snap?.consistencyOk ?? null,
    exposure: snap?.exposure ?? 0,
    contracts: snap?.contracts ?? 0,
    marginUsed: snap?.marginUsed ?? 0,
    dayTrades: snap?.dayTrades ?? 0,
    consecutiveLosses: snap?.consecutiveLosses ?? 0,
    lock: snap?.lock ?? account.lock,
    passBlockers: snap?.passBlockers ?? [],
  };
}

export interface LiveAccount {
  figures: LiveFigures;
  metrics: AccountMetrics;
  snapshot: AccountSnapshot;
}

export function useLiveAccount(account: Account | null): LiveAccount | null {
  const snap = useApp((s) => (account ? (s.snapshots[account.id] ?? null) : null));
  const openPnl = useLiveOpenPnl(account?.id);
  return useMemo(() => {
    if (!account) return null;
    const figures = liveFigures(account, snap, openPnl);
    const snapshot = liveSnapshot(account, snap, figures);
    return { figures, snapshot, metrics: accountMetrics(account, snapshot) };
  }, [account, snap, openPnl]);
}
