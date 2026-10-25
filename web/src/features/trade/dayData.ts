// Today's fills / closed trades / events of the active account: fetched once per (account, trading day)
// and merged with the live arrays the socket keeps in the app store.

import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import type { Account, AccountEvent, Fill, Trade } from '@shared/types';
import { tradingDayBounds } from '@shared/time';
import { api, errorMessage } from '@/api/client';
import { useBus } from '@/api/bus';
import { useApp } from '@/store/app';

interface DayState {
  key: string | null;
  accountId: string | null;
  dayStart: number;
  fills: Fill[];
  trades: Trade[];
  events: AccountEvent[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  load(account: Account, force?: boolean): Promise<void>;
}

export function dayStartOf(account: Account): number {
  try {
    return tradingDayBounds(account.tradingDay, account.rules.rollover).start;
  } catch {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
}

export const useDay = create<DayState>((set, get) => ({
  key: null,
  accountId: null,
  dayStart: 0,
  fills: [],
  trades: [],
  events: [],
  status: 'idle',
  error: null,

  async load(account, force) {
    const key = `${account.id}|${account.tradingDay}`;
    if (!force && get().key === key && get().status !== 'error') return;
    const dayStart = dayStartOf(account);
    const sameAccount = get().accountId === account.id;
    set({
      key,
      accountId: account.id,
      dayStart,
      status: 'loading',
      error: null,
      ...(sameAccount ? {} : { fills: [], trades: [], events: [] }),
    });
    const [fills, trades, events] = await Promise.allSettled([
      api.fills({ accountId: account.id, from: dayStart, limit: 2000 }),
      api.trades({ accountId: account.id, from: dayStart, status: 'closed', limit: 1000 }),
      api.events({ accountId: account.id, limit: 150 }),
    ]);
    if (get().key !== key) return;
    const failed = [fills, trades, events].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    set({
      fills: fills.status === 'fulfilled' ? fills.value : get().fills,
      trades: trades.status === 'fulfilled' ? trades.value : get().trades,
      events: events.status === 'fulfilled' ? events.value : get().events,
      status: failed ? 'error' : 'ready',
      error: failed ? errorMessage(failed.reason) : null,
    });
  },
}));

/** Keep the day data loaded for the account (mount once on the trade page). */
export function useDayDataLoader(account: Account | null): void {
  const id = account?.id;
  const day = account?.tradingDay;
  useEffect(() => {
    if (account) void useDay.getState().load(account);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, day]);
  useBus('resynced', () => {
    if (account) void useDay.getState().load(account, true);
  });
}

function dedupe<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
}

export function useTodayFills(accountId: string | null): Fill[] {
  const fetched = useDay((s) => s.fills);
  const fetchedFor = useDay((s) => s.accountId);
  const dayStart = useDay((s) => s.dayStart);
  const recent = useApp((s) => s.recentFills);
  return useMemo(() => {
    if (!accountId) return [];
    const live = recent.filter((f) => f.accountId === accountId && f.ts >= dayStart);
    const base = fetchedFor === accountId ? fetched : [];
    return dedupe([...live, ...base]).sort((a, b) => b.ts - a.ts);
  }, [accountId, fetched, fetchedFor, dayStart, recent]);
}

export function useTodayTrades(accountId: string | null): Trade[] {
  const fetched = useDay((s) => s.trades);
  const fetchedFor = useDay((s) => s.accountId);
  const dayStart = useDay((s) => s.dayStart);
  const recent = useApp((s) => s.recentTrades);
  return useMemo(() => {
    if (!accountId) return [];
    const live = recent.filter((t) => t.accountId === accountId && t.status === 'closed' && (t.closedAt ?? 0) >= dayStart);
    const base = fetchedFor === accountId ? fetched.filter((t) => t.status === 'closed') : [];
    return dedupe([...live, ...base]).sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  }, [accountId, fetched, fetchedFor, dayStart, recent]);
}

export function useAccountEvents(accountId: string | null): AccountEvent[] {
  const fetched = useDay((s) => s.events);
  const fetchedFor = useDay((s) => s.accountId);
  const live = useApp((s) => s.events);
  return useMemo(() => {
    if (!accountId) return [];
    const mine = live.filter((e) => e.accountId === accountId || e.accountId == null);
    const base = fetchedFor === accountId ? fetched : [];
    return dedupe([...mine, ...base])
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 200);
  }, [accountId, fetched, fetchedFor, live]);
}

/** Most recent closed trade of the account (live first, then today's history) — for the revenge guard. */
export function lastClosedTrade(accountId: string): Trade | null {
  const recent = useApp.getState().recentTrades.filter((t) => t.accountId === accountId && t.status === 'closed');
  const day = useDay.getState();
  const fetched = day.accountId === accountId ? day.trades : [];
  let best: Trade | null = null;
  for (const t of [...recent, ...fetched]) {
    if (t.status !== 'closed' || t.closedAt == null) continue;
    if (!best || t.closedAt > (best.closedAt ?? 0)) best = t;
  }
  return best;
}
