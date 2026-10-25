// Daily stats for a visible day range (month grid or year), aggregated per day, refreshed live.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DailyStat, EventKind } from '@shared/types';
import { api, errorMessage } from '@/api/client';
import { useBus } from '@/api/bus';
import { aggregateDaily, type DayAgg } from './calendarMath';

/** Small in-memory cache so flipping back and forth between months is instant (revalidated on show). */
const cache = new Map<string, DailyStat[]>();
const CACHE_MAX = 24;

function remember(key: string, rows: DailyStat[]) {
  cache.delete(key);
  cache.set(key, rows);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

/** Debounced callback with a stable identity; the latest `fn` runs. */
export function useDebouncedCallback(fn: () => void, ms: number): () => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      fnRef.current();
    }, ms);
  }, [ms]);
}

/** Account events that change a day's flags / numbers. */
const REFRESH_EVENTS: EventKind[] = ['breach', 'passed', 'phase_passed', 'locked', 'payout', 'day_rollover', 'catch_up', 'auto_flatten'];

/**
 * Calls `onChange` (debounced) whenever something that affects `accountId`'s daily P&L in [from, to] happens:
 * fills, closed trades, rule events, or a resync after a reconnect.
 */
export function useLiveDayRefresh(accountId: string, from: string, to: string, onChange: () => void, ms = 700): void {
  const refresh = useDebouncedCallback(onChange, ms);
  const relevant = (acc: string | null, day?: string) => (accountId === 'all' || acc === accountId) && (day == null || (day >= from && day <= to));
  useBus('fill', (f) => relevant(f.accountId, f.tradingDay) && refresh());
  useBus('tradeClosed', (t) => relevant(t.accountId, t.tradingDay) && refresh());
  useBus('event', (e) => REFRESH_EVENTS.includes(e.kind) && relevant(e.accountId) && refresh());
  useBus('resynced', () => refresh());
}

export interface DailyData {
  /** Aggregated per day; null until the first load of this range. */
  days: Map<string, DayAgg> | null;
  loading: boolean;
  /** Revalidating while showing cached / previous numbers. */
  refreshing: boolean;
  error: string | null;
  reload: () => void;
}

export function useDailyStats(accountId: string, from: string, to: string): DailyData {
  const key = `${accountId}|${from}|${to}`;
  const [state, setState] = useState<{ key: string; rows: DailyStat[] | null; error: string | null; loading: boolean }>(() => ({
    key,
    rows: cache.get(key) ?? null,
    error: null,
    loading: true,
  }));
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((s) => (s.key === key ? { ...s, loading: true } : { key, rows: cache.get(key) ?? null, error: null, loading: true }));
    api
      .daily({ accountId, from, to })
      .then((rows) => {
        if (cancelled) return;
        remember(key, rows);
        setState({ key, rows, error: null, loading: false });
      })
      .catch((e) => {
        if (!cancelled) setState((s) => ({ ...s, key, loading: false, error: errorMessage(e) }));
      });
    return () => {
      cancelled = true;
    };
  }, [key, accountId, from, to, nonce]);

  const reload = useCallback(() => {
    cache.clear();
    setNonce((n) => n + 1);
  }, []);
  useLiveDayRefresh(accountId, from, to, reload);

  const rows = state.key === key ? state.rows : (cache.get(key) ?? null);
  const days = useMemo(() => (rows ? aggregateDaily(rows) : null), [rows]);
  return {
    days,
    loading: days == null && (state.loading || state.key !== key),
    refreshing: days != null && state.loading,
    error: state.key === key ? state.error : null,
    reload,
  };
}
