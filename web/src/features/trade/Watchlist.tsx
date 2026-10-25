// Watchlist: settings.watchlist grouped by instrument group, live prices with tick flashes, change %,
// closed-market marker, position badge; search to add any catalog instrument; remove on hover.

import { memo, useMemo, useState, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import { Moon, Plus, Search, X } from 'lucide-react';
import type { InstrumentSpec } from '@shared/types';
import { sessionState } from '@shared/time';
import { useQuoteSubscription } from '@/api/socket';
import { fmtPct, fmtPrice, fmtQty, pnlTone } from '@/lib/format';
import { useApp } from '@/store/app';
import { useNow } from '@/store/hooks';
import { useQuote, useTickDir } from '@/store/market';
import { toast } from '@/components/ui/Toast';
import { errorMessage } from '@/api/client';
import { useTrade } from './store';
import { useFlash } from './useFlash';

const GROUP_ORDER = ['Index futures', 'Energy & metals futures', 'Crypto', 'Metals & energy', 'Stocks & ETFs', 'Forex'];

function saveWatchlist(list: string[]) {
  useApp
    .getState()
    .updateSettings({ watchlist: list })
    .catch((e) => toast({ tone: 'loss', title: 'Watchlist not saved', description: errorMessage(e) }));
}

const Row = memo(function Row({ spec, selected, closed, onSelect, onRemove }: { spec: InstrumentSpec; selected: boolean; closed: boolean; onSelect: () => void; onRemove: () => void }) {
  const q = useQuote(spec.symbol);
  const dir = useTickDir(spec.symbol);
  const flash = useFlash(q?.last, dir);
  const accountId = useApp((s) => s.activeAccountId);
  const posQty = useApp((s) => {
    let q = 0;
    if (accountId) for (const p of Object.values(s.positions)) if (p.accountId === accountId && p.symbol === spec.symbol) q += p.qty;
    return Number(q.toFixed(10));
  });
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect()}
      className={clsx(
        'group relative flex h-10 cursor-pointer items-center gap-2 border-l-2 pl-2.5 pr-2 transition-colors',
        selected ? 'border-fg bg-panel-3' : 'border-transparent hover:bg-panel-2',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-semibold text-fg">{spec.symbol}</span>
          {posQty !== 0 && (
            <span className={clsx('tnum rounded px-1 text-[10px] font-semibold leading-4', posQty > 0 ? 'bg-profit/15 text-profit' : 'bg-loss/15 text-loss')}>
              {posQty > 0 ? 'L' : 'S'} {fmtQty(spec, posQty)}
            </span>
          )}
          {closed && <Moon size={11} className="text-faint" aria-label="Market closed" />}
        </div>
        <div className="truncate text-2xs text-faint">{spec.name}</div>
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <span ref={flash} className={clsx('num rounded px-1 text-[13px]', closed ? 'text-muted' : 'text-fg')}>
          {q ? fmtPrice(spec, q.last) : '—'}
        </span>
        <span className={clsx('tnum pr-1 text-2xs', pnlTone(q?.changePct, 'text-faint'))}>{q?.changePct != null ? fmtPct(q.changePct, 2, true) : ''}</span>
      </div>
      <button
        type="button"
        aria-label={`Remove ${spec.symbol} from the watchlist`}
        title="Remove from watchlist"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="absolute right-0.5 top-0.5 hidden size-4 items-center justify-center rounded text-faint hover:bg-panel-3 hover:text-fg group-hover:flex"
      >
        <X size={11} />
      </button>
    </div>
  );
});

export function Watchlist() {
  const watchlist = useApp((s) => s.settings.watchlist);
  const instruments = useApp((s) => s.instruments);
  const instrumentMap = useApp((s) => s.instrumentMap);
  const selected = useTrade((s) => s.symbol);
  const selectSymbol = useTrade((s) => s.selectSymbol);
  const [query, setQuery] = useState('');
  const now = useNow(30_000);

  const symbols = useMemo(() => watchlist.filter((s) => instrumentMap[s]), [watchlist, instrumentMap]);
  useQuoteSubscription('trade-watchlist', symbols);

  const groups = useMemo(() => {
    const by = new Map<string, InstrumentSpec[]>();
    for (const s of symbols) {
      const spec = instrumentMap[s];
      const list = by.get(spec.group) ?? [];
      list.push(spec);
      by.set(spec.group, list);
    }
    return [...by.entries()].sort((a, b) => (GROUP_ORDER.indexOf(a[0]) + 99) % 99 - ((GROUP_ORDER.indexOf(b[0]) + 99) % 99));
  }, [symbols, instrumentMap]);

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) return [];
    return instruments
      .filter((i) => i.symbol.toLowerCase().includes(q) || i.name.toLowerCase().includes(q) || i.group.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.symbol.toLowerCase().startsWith(q)) - Number(!b.symbol.toLowerCase().startsWith(q)))
      .slice(0, 30);
  }, [instruments, q]);

  const add = (symbol: string) => {
    if (!watchlist.includes(symbol)) saveWatchlist([...watchlist, symbol]);
  };
  const remove = (symbol: string) => saveWatchlist(watchlist.filter((s) => s !== symbol));
  const pick = (symbol: string) => {
    selectSymbol(symbol);
    setQuery('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && results[0]) {
      add(results[0].symbol);
      pick(results[0].symbol);
    } else if (e.key === 'Escape') setQuery('');
  };

  return (
    <aside className="flex w-[240px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex h-10 shrink-0 items-center border-b border-line px-2">
        <div className="relative flex w-full items-center">
          <Search size={13} className="pointer-events-none absolute left-2 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search symbols…"
            aria-label="Search instruments"
            className="h-7 w-full rounded-md border border-line bg-panel-2 pl-7 pr-6 text-[13px] text-fg placeholder:text-faint focus:border-fg/50 focus:outline-none"
          />
          {query && (
            <button className="absolute right-1.5 text-faint hover:text-fg" onClick={() => setQuery('')} aria-label="Clear search">
              <X size={12} />
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {q ? (
          results.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted">No instrument matches “{query}”.</div>
          ) : (
            results.map((i) => {
              const inList = watchlist.includes(i.symbol);
              return (
                <div key={i.symbol} className="group flex h-10 items-center gap-2 px-2.5 hover:bg-panel-2">
                  <button className="min-w-0 flex-1 text-left" onClick={() => pick(i.symbol)}>
                    <div className="text-[13px] font-semibold text-fg">{i.symbol}</div>
                    <div className="truncate text-2xs text-faint">
                      {i.name} · {i.group}
                    </div>
                  </button>
                  {inList ? (
                    <span className="text-2xs text-faint">Added</span>
                  ) : (
                    <button
                      className="flex h-6 items-center gap-1 rounded border border-line-strong px-1.5 text-2xs text-muted hover:border-fg hover:text-fg"
                      onClick={() => add(i.symbol)}
                      title="Add to watchlist"
                    >
                      <Plus size={11} /> Add
                    </button>
                  )}
                </div>
              );
            })
          )
        ) : symbols.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs leading-relaxed text-muted">Your watchlist is empty. Search above to add futures, crypto, metals, stocks or forex.</div>
        ) : (
          groups.map(([group, specs]) => (
            <div key={group}>
              <div className="sticky top-0 z-10 bg-panel px-3 pb-1 pt-2.5 text-2xs font-semibold uppercase tracking-wider text-faint">{group}</div>
              {specs.map((spec) => (
                <Row
                  key={spec.symbol}
                  spec={spec}
                  selected={spec.symbol === selected}
                  closed={!sessionState(spec.session, now).open}
                  onSelect={() => selectSymbol(spec.symbol)}
                  onRemove={() => remove(spec.symbol)}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
