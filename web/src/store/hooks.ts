// Derived, render-safe selectors. Each hook selects stable store slices and memoizes derived values.

import { useEffect, useMemo, useState } from 'react';
import type { Account, AccountSnapshot, InstrumentSpec, Order, Position, Quote, SessionState } from '@shared/types';
import { pnl } from '@shared/risk';
import { sessionState } from '@shared/time';
import { useApp, serverNow } from './app';
import { useMarket } from './market';

export function useActiveAccount(): Account | null {
  return useApp((s) => (s.activeAccountId ? s.accounts[s.activeAccountId] ?? null : null));
}

export function useActiveSnapshot(): AccountSnapshot | null {
  return useApp((s) => (s.activeAccountId ? s.snapshots[s.activeAccountId] ?? null : null));
}

export function useAccount(id: string | null | undefined): Account | null {
  return useApp((s) => (id ? s.accounts[id] ?? null : null));
}

export function useSnapshot(id: string | null | undefined): AccountSnapshot | null {
  return useApp((s) => (id ? s.snapshots[id] ?? null : null));
}

const KIND_ORDER = { funded: 0, evaluation: 1, practice: 2 } as const;
const STATUS_ORDER = { active: 0, passed: 1, failed: 2, closed: 3 } as const;

/** Non-archived accounts: active first, then funded → evaluation → practice, newest first. */
export function useAccountList(opts: { includeArchived?: boolean } = {}): Account[] {
  const accounts = useApp((s) => s.accounts);
  return useMemo(
    () =>
      Object.values(accounts)
        .filter((a) => opts.includeArchived || !a.archived)
        .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.createdAt - a.createdAt),
    [accounts, opts.includeArchived],
  );
}

export function useAccountPositions(accountId: string | null | undefined): Position[] {
  const positions = useApp((s) => s.positions);
  return useMemo(
    () => (accountId ? Object.values(positions).filter((p) => p.accountId === accountId).sort((a, b) => a.openedAt - b.openedAt) : []),
    [positions, accountId],
  );
}

/**
 * An account's positions in one symbol seen as one (they are always on the same side): total size, average
 * entry, summed P&L; a stop / target only when they all share it. null when flat.
 */
export function combinePositions(list: readonly Position[]): Position | null {
  if (list.length <= 1) return list[0] ?? null;
  let qty = 0;
  let cost = 0;
  let openPnl = 0;
  for (const p of list) {
    qty += p.qty;
    cost += p.avgPrice * Math.abs(p.qty);
    openPnl += p.openPnl;
  }
  const shared = (k: 'sl' | 'tp') => (list.every((p) => p[k] === list[0][k]) ? list[0][k] : null);
  const abs = Math.abs(qty);
  return {
    ...list[0],
    qty: Number(qty.toFixed(10)),
    avgPrice: abs > 0 ? cost / abs : list[0].avgPrice,
    openPnl,
    sl: shared('sl'),
    tp: shared('tp'),
    openedAt: Math.min(...list.map((p) => p.openedAt)),
  };
}

/** Working orders of an account, newest first. */
export function useAccountOrders(accountId: string | null | undefined): Order[] {
  const orders = useApp((s) => s.orders);
  return useMemo(
    () => (accountId ? Object.values(orders).filter((o) => o.accountId === accountId).sort((a, b) => b.createdAt - a.createdAt) : []),
    [orders, accountId],
  );
}

export function useInstrument(symbol: string | null | undefined): InstrumentSpec | undefined {
  return useApp((s) => (symbol ? s.instrumentMap[symbol] : undefined));
}

/** Live mark and open P&L of a position from a quote (bid for longs, ask for shorts). */
export function livePositionPnl(position: Position, spec: InstrumentSpec | undefined, quote: Quote | undefined): { mark: number; openPnl: number } {
  if (!spec || !quote) return { mark: position.markPrice, openPnl: position.openPnl };
  const long = position.qty > 0;
  const mark = long ? quote.bid : quote.ask;
  return { mark, openPnl: pnl(spec, long ? 1 : -1, Math.abs(position.qty), position.avgPrice, mark) };
}

export function usePositionPnl(position: Position): { mark: number; openPnl: number } {
  const spec = useInstrument(position.symbol);
  const quote = useMarket((s) => s.quotes[position.symbol]);
  return livePositionPnl(position, spec, quote);
}

/** Ticking server-corrected clock. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const id = setInterval(() => setNow(serverNow()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Market session of an instrument, refreshed every 15 s. */
export function useSession(symbol: string | null | undefined): SessionState | null {
  const spec = useInstrument(symbol);
  const now = useNow(15_000);
  return useMemo(() => (spec ? sessionState(spec.session, now) : null), [spec, now]);
}

/** Lock that is currently in force (expired locks are ignored even before the server clears them). */
export function activeLock(account: Account | null, now: number) {
  const lock = account?.lock;
  if (!lock) return null;
  if (lock.until != null && lock.until <= now) return null;
  return lock;
}
