// Closed trades for the journal: server paging (limit/offset), "load all" for analytics, live updates.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Trade } from '@shared/types';
import { api, errorMessage } from '@/api/client';
import { useBus } from '@/api/bus';
import { closeTime } from './stats';

export const PAGE_SIZE = 250;
const BULK_PAGE = 5000;
const MAX_BULK_PAGES = 20;

export interface TradesQueryKey {
  accountId: string;
  from?: number;
  to?: number;
}

export interface JournalTrades {
  trades: Trade[];
  /** Nothing to show yet (first load). */
  loading: boolean;
  /** Reloading while previous rows stay on screen (dim them, don't flash a skeleton). */
  refreshing: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  loadMore(): void;
  /** Fetch every remaining page (analytics needs the complete set). */
  loadAll(): void;
  reload(): void;
  /** Insert or replace a trade (after a journal edit, or a live close). */
  upsert(t: Trade): void;
}

interface State {
  key: string;
  trades: Trade[];
  hasMore: boolean;
  error: string | null;
  loading: boolean;
  loadingMore: boolean;
}

const byCloseDesc = (a: Trade, b: Trade) => closeTime(b) - closeTime(a) || b.openedAt - a.openedAt;

function mergeUnique(base: Trade[], extra: Trade[]): Trade[] {
  const seen = new Set(base.map((t) => t.id));
  const out = [...base];
  for (const t of extra) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

export function useJournalTrades(q: TradesQueryKey): JournalTrades {
  const key = `${q.accountId}|${q.from ?? ''}|${q.to ?? ''}`;
  const [state, setState] = useState<State>({ key: '', trades: [], hasMore: false, error: null, loading: true, loadingMore: false });
  const [nonce, setNonce] = useState(0);
  const keyRef = useRef(key);
  keyRef.current = key;
  const queryRef = useRef(q);
  queryRef.current = q;
  const countRef = useRef(0);
  countRef.current = state.key === key ? state.trades.length : 0;
  const busyRef = useRef(false);

  const fetchPage = useCallback((offset: number, limit: number) => {
    const cur = queryRef.current;
    return api.trades({ accountId: cur.accountId, from: cur.from, to: cur.to, status: 'closed', limit, offset });
  }, []);

  // (Re)load the first page whenever the query changes.
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchPage(0, PAGE_SIZE)
      .then((rows) => {
        if (cancelled) return;
        setState({ key, trades: [...rows].sort(byCloseDesc), hasMore: rows.length >= PAGE_SIZE, error: null, loading: false, loadingMore: false });
      })
      .catch((e) => {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error: errorMessage(e) }));
      });
    return () => {
      cancelled = true;
    };
  }, [key, nonce, fetchPage]);

  const loadPages = useCallback(
    async (limit: number, maxPages: number) => {
      if (busyRef.current) return;
      const startKey = keyRef.current;
      busyRef.current = true;
      setState((s) => ({ ...s, loadingMore: true }));
      let offset = countRef.current;
      try {
        for (let page = 0; page < maxPages; page++) {
          const rows = await fetchPage(offset, limit);
          if (keyRef.current !== startKey) return;
          offset += rows.length;
          const more = rows.length >= limit;
          setState((s) => (s.key === startKey ? { ...s, trades: mergeUnique(s.trades, rows).sort(byCloseDesc), hasMore: more } : s));
          if (!more) break;
        }
      } catch (e) {
        if (keyRef.current === startKey) setState((s) => ({ ...s, error: errorMessage(e) }));
      } finally {
        busyRef.current = false;
        setState((s) => ({ ...s, loadingMore: false }));
      }
    },
    [fetchPage],
  );

  const loadMore = useCallback(() => void loadPages(PAGE_SIZE, 1), [loadPages]);
  const loadAll = useCallback(() => void loadPages(BULK_PAGE, MAX_BULK_PAGES), [loadPages]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const upsert = useCallback((t: Trade) => {
    setState((s) => {
      const i = s.trades.findIndex((x) => x.id === t.id);
      if (i >= 0) {
        const trades = [...s.trades];
        trades[i] = t;
        return { ...s, trades };
      }
      const cur = queryRef.current;
      if (t.status !== 'closed' || s.key !== keyRef.current) return s;
      if (cur.accountId !== 'all' && t.accountId !== cur.accountId) return s;
      const ts = closeTime(t);
      if ((cur.from != null && ts < cur.from) || (cur.to != null && ts > cur.to)) return s;
      return { ...s, trades: [t, ...s.trades].sort(byCloseDesc) };
    });
  }, []);

  // Live: trades that close — or whose journal is edited elsewhere (post-trade review) — show up here.
  useBus('trade', (t) => {
    if (t.status === 'closed') upsert(t);
  });
  useBus('resynced', () => reload());

  const current = state.key === key;
  return {
    trades: state.trades,
    loading: state.loading && state.trades.length === 0,
    refreshing: state.loading && state.trades.length > 0,
    loadingMore: state.loadingMore,
    hasMore: current && !state.loading && state.hasMore,
    error: state.error,
    loadMore,
    loadAll,
    reload,
    upsert,
  };
}
