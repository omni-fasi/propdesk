// Journal: trade log + analytics over the same filtered set of closed trades.
// #/journal?tab=trades|analytics&account=&range=&from=&to=&symbol=&side=&result=&mood=&setup=&review=&sort=&dir=

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, NotebookPen, RefreshCw } from 'lucide-react';
import type { Trade } from '@shared/types';
import { SETUP_GRADES } from '@shared/journal';
import { calendarDayOf } from '@shared/time';
import { useApp } from '@/store/app';
import { useNow } from '@/store/hooks';
import { fmtPct } from '@/lib/format';
import { navigate, setParams, useRoute } from '@/lib/router';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { EmptyState, Spinner } from '@/components/ui/Misc';
import { Page, Panel } from '@/components/ui/Panel';
import { Segmented } from '@/components/ui/Tabs';
import { resolveAccountParam } from './AccountFilter';
import { Analytics } from './Analytics';
import { FiltersBar } from './Filters';
import { activeFilterCount, CLEAR_FILTERS, filterParams, inKeyRange, matchesFilters, parseFilters, rangeKeys, serverWindow, type JournalFilters } from './filters';
import { fmtProfitFactor, fmtR, plural } from './labels';
import { computeKpis, normalizeSetup } from './stats';
import { TradeDrawer } from './TradeDrawer';
import { DEFAULT_SORT, parseSort, sortTrades, TradeTable, type SortState } from './TradeTable';
import { useJournalTrades } from './useTrades';

type Tab = 'trades' | 'analytics';

function SummaryLine({ trades, total, filtered }: { trades: Trade[]; total: number; filtered: boolean }) {
  const k = useMemo(() => computeKpis(trades), [trades]);
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-muted">
      <span className="tnum">
        <span className="font-semibold text-fg">{plural(k.trades, 'trade')}</span>
        {filtered && <span className="text-faint"> of {total.toLocaleString('en-US')} in range</span>}
      </span>
      <span className="flex items-center gap-1.5">
        Net <Money value={k.net} sign colored className="font-semibold" />
      </span>
      <span className="tnum">
        Win rate <span className="text-fg">{k.winRate == null ? '—' : fmtPct(k.winRate, 0)}</span>
      </span>
      <span className="tnum">
        Profit factor <span className="text-fg">{fmtProfitFactor(k.profitFactor)}</span>
      </span>
      <span className="tnum">
        Avg R <span className="text-fg">{fmtR(k.avgR)}</span>
      </span>
      <span className="tnum">
        Fees <Money value={-k.fees} className="text-fg" />
      </span>
    </div>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-loss/30 bg-loss/5 px-3 py-2 text-[13px]">
      <span className="flex items-center gap-2 text-fg">
        <AlertTriangle size={14} className="text-loss" /> Couldn’t load your trades — {message}
      </span>
      <Button size="sm" variant="secondary" icon={<RefreshCw size={13} />} onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

export function JournalPage() {
  const { params } = useRoute();
  const accounts = useApp((s) => s.accounts);
  const instruments = useApp((s) => s.instrumentMap);
  const localTz = useApp((s) => s.localTz);
  const now = useNow(60_000);
  const today = calendarDayOf(now, localTz);

  const tab: Tab = params.get('tab') === 'analytics' ? 'analytics' : 'trades';
  const parsed = useMemo(() => parseFilters(params), [params]);
  const account = resolveAccountParam(parsed.account, accounts);
  const filters: JournalFilters = useMemo(() => ({ ...parsed, account }), [parsed, account]);
  const sortKey = params.get('sort');
  const sortDir = params.get('dir');
  const sort = useMemo(() => parseSort(sortKey, sortDir), [sortKey, sortDir]);

  const { fromKey, toKey } = rangeKeys(filters, today);
  const win = serverWindow(fromKey, toKey);
  const data = useJournalTrades({ accountId: account, from: win.from, to: win.to });

  const inRange = useMemo(() => data.trades.filter((t) => inKeyRange(t.tradingDay, fromKey, toKey)), [data.trades, fromKey, toKey]);
  const filtered = useMemo(() => inRange.filter((t) => matchesFilters(t, filters)), [inRange, filters]);
  const sorted = useMemo(() => sortTrades(filtered, sort, accounts), [filtered, sort, accounts]);
  const symbols = useMemo(() => [...new Set(inRange.map((t) => t.symbol))], [inRange]);
  const customSetups = useMemo(() => {
    const grades: readonly string[] = SETUP_GRADES;
    return [...new Set(inRange.map((t) => normalizeSetup(t.tags?.setup)).filter((s): s is string => s != null && !grades.includes(s)))].sort();
  }, [inRange]);
  const narrowing = activeFilterCount(filters) > 0;

  // Analytics needs every trade of the range, not just the first page.
  const { hasMore, loadingMore, loadAll } = data;
  useEffect(() => {
    if (tab === 'analytics' && hasMore && !loadingMore) loadAll();
  }, [tab, hasMore, loadingMore, loadAll]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? (sorted.find((t) => t.id === selectedId) ?? data.trades.find((t) => t.id === selectedId) ?? null) : null;
  const idx = selected ? sorted.findIndex((t) => t.id === selected.id) : -1;
  const onSelect = useCallback((t: Trade) => setSelectedId(t.id), []);

  const update = (patch: Partial<JournalFilters>) => setParams(filterParams(patch));
  const onSort = (s: SortState) => setParams({ sort: s.key === DEFAULT_SORT.key && s.dir === DEFAULT_SORT.dir ? null : s.key, dir: s.key === DEFAULT_SORT.key && s.dir === DEFAULT_SORT.dir ? null : s.dir });
  const hasAccounts = Object.keys(accounts).length > 0;

  const tabs = (
    <Segmented<Tab>
      size="md"
      value={tab}
      onChange={(v) => setParams({ tab: v === 'trades' ? null : v })}
      options={[
        { value: 'trades', label: 'Trade log' },
        { value: 'analytics', label: 'Analytics' },
      ]}
    />
  );

  return (
    <Page
      title="Journal"
      subtitle="Every closed trade, what you felt, and what it cost or paid."
      actions={
        <>
          {(data.refreshing || data.loadingMore) && <Spinner size={14} className="text-faint" />}
          {tabs}
        </>
      }
      className={tab === 'trades' ? 'flex flex-col' : undefined}
    >
      <div className={tab === 'trades' ? 'flex min-h-0 flex-1 flex-col gap-3' : 'flex flex-col gap-3'}>
        <FiltersBar filters={filters} onChange={update} symbols={symbols} customSetups={customSetups} />
        {data.error && <ErrorBanner message={data.error} onRetry={data.reload} />}

        {tab === 'trades' ? (
          <>
            {!data.loading && inRange.length > 0 && <SummaryLine trades={filtered} total={inRange.length} filtered={narrowing} />}
            <Panel padded={false} className="min-h-[340px] flex-1">
              {!data.loading && sorted.length === 0 ? (
                inRange.length > 0 ? (
                  <EmptyState
                    title="No trades match these filters"
                    description={`${plural(inRange.length, 'trade')} in this range are hidden by your filters.`}
                    action={
                      <Button variant="secondary" onClick={() => update(CLEAR_FILTERS)}>
                        Clear filters
                      </Button>
                    }
                  />
                ) : data.error ? null : (
                  <EmptyState
                    icon={<NotebookPen />}
                    title={filters.range === 'all' ? 'Your trade log is empty' : 'No closed trades in this period'}
                    description={
                      hasAccounts
                        ? 'Every trade you close lands here with its chart, fills and P&L — and the mood and plan you logged. Review each one: that is where the progress is.'
                        : 'Create a challenge or a live account, take your first trade, and it will be logged here automatically.'
                    }
                    action={
                      hasAccounts ? (
                        <div className="flex gap-2">
                          {filters.range !== 'all' && (
                            <Button variant="secondary" onClick={() => update({ range: 'all' })}>
                              Show all time
                            </Button>
                          )}
                          <Button variant="primary" onClick={() => navigate('trade')}>
                            Go to the trading terminal
                          </Button>
                        </div>
                      ) : (
                        <Button variant="primary" onClick={() => navigate('challenges', { new: 1 })}>
                          Create an account
                        </Button>
                      )
                    }
                  />
                )
              ) : (
                <TradeTable
                  className="h-full"
                  trades={sorted}
                  accounts={accounts}
                  instruments={instruments}
                  showAccount={account === 'all'}
                  sort={sort}
                  onSort={onSort}
                  onSelect={onSelect}
                  selectedId={selectedId}
                  loading={data.loading}
                  dim={data.refreshing}
                  footer={
                    data.hasMore && (
                      <div className="flex items-center justify-center gap-3 border-t border-line py-3 text-xs text-faint">
                        <span className="tnum">Showing the newest {data.trades.length.toLocaleString('en-US')} trades of this range</span>
                        <Button size="sm" variant="secondary" loading={data.loadingMore} onClick={data.loadMore}>
                          Load more
                        </Button>
                        {sort.key !== 'closed' && <span>Sorting applies to loaded trades</span>}
                      </div>
                    )
                  }
                />
              )}
            </Panel>
          </>
        ) : (
          <Analytics trades={filtered} loading={data.loading} partial={data.hasMore || data.loadingMore} onSelectTrade={onSelect} hasFilters={narrowing} />
        )}
      </div>

      <TradeDrawer
        trade={selected}
        onClose={() => setSelectedId(null)}
        onUpdated={data.upsert}
        onPrev={idx > 0 ? () => setSelectedId(sorted[idx - 1].id) : undefined}
        onNext={idx >= 0 && idx < sorted.length - 1 ? () => setSelectedId(sorted[idx + 1].id) : undefined}
      />
    </Page>
  );
}
