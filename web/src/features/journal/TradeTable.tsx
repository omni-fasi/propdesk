// Dense, sortable trade log.

import { memo, useMemo, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, CircleCheck } from 'lucide-react';
import clsx from 'clsx';
import type { Account, InstrumentSpec, Trade } from '@shared/types';
import { fmtDate, fmtDuration, fmtTime, pnlTone } from '@/lib/format';
import { Money } from '@/components/ui/Money';
import { Skeleton } from '@/components/ui/Misc';
import { accountName, directionClass, directionLabel, exitReasonClass, exitReasonLabel, fmtR, fmtTradePrice, fmtTradeQty, moodEmoji, moodLabel } from './labels';
import { closeTime, holdTime, isReviewed, normalizeSetup } from './stats';

export type SortKey = 'closed' | 'account' | 'symbol' | 'side' | 'qty' | 'net' | 'r' | 'hold' | 'mae' | 'mfe' | 'exit' | 'mood' | 'setup' | 'review';
export type SortDir = 'asc' | 'desc';
export interface SortState {
  key: SortKey;
  dir: SortDir;
}

export const DEFAULT_SORT: SortState = { key: 'closed', dir: 'desc' };
const SORT_KEYS: SortKey[] = ['closed', 'account', 'symbol', 'side', 'qty', 'net', 'r', 'hold', 'mae', 'mfe', 'exit', 'mood', 'setup', 'review'];

export function parseSort(key: string | null, dir: string | null): SortState {
  const k = SORT_KEYS.includes(key as SortKey) ? (key as SortKey) : DEFAULT_SORT.key;
  return { key: k, dir: dir === 'asc' || dir === 'desc' ? dir : k === DEFAULT_SORT.key ? DEFAULT_SORT.dir : 'desc' };
}

type SortValue = number | string | null;

function sortValue(t: Trade, key: SortKey, accounts: Record<string, Account>): SortValue {
  switch (key) {
    case 'closed':
      return closeTime(t);
    case 'account':
      return accountName(accounts, t.accountId).toLowerCase();
    case 'symbol':
      return t.symbol;
    case 'side':
      return t.direction;
    case 'qty':
      return t.maxQty;
    case 'net':
      return t.netPnl;
    case 'r':
      return t.rMultiple;
    case 'hold':
      return holdTime(t);
    case 'mae':
      return t.mae;
    case 'mfe':
      return t.mfe;
    case 'exit':
      return t.exitReason;
    case 'mood':
      return t.tags?.mood ?? null;
    case 'setup':
      return normalizeSetup(t.tags?.setup);
    case 'review':
      return isReviewed(t) ? 1 : 0;
  }
}

/** Sorted copy; nulls always last; ties broken by close time (newest first). */
export function sortTrades(trades: readonly Trade[], sort: SortState, accounts: Record<string, Account>): Trade[] {
  const mult = sort.dir === 'asc' ? 1 : -1;
  return [...trades].sort((a, b) => {
    const va = sortValue(a, sort.key, accounts);
    const vb = sortValue(b, sort.key, accounts);
    if (va == null && vb != null) return 1;
    if (vb == null && va != null) return -1;
    if (va != null && vb != null && va !== vb) return (va < vb ? -1 : 1) * mult;
    return closeTime(b) - closeTime(a);
  });
}

interface Column {
  key: SortKey | 'entry' | 'exitPrice';
  label: string;
  title?: string;
  align?: 'left' | 'right' | 'center';
  sortable?: boolean;
  className?: string;
  render: (t: Trade, ctx: RowCtx) => ReactNode;
}

interface RowCtx {
  accounts: Record<string, Account>;
  instruments: Record<string, InstrumentSpec>;
}

const thisYear = new Date().getFullYear();

const COLUMNS: Column[] = [
  {
    key: 'closed',
    label: 'Closed',
    sortable: true,
    render: (t) => {
      const ts = closeTime(t);
      return (
        <span className="tnum whitespace-nowrap">
          <span className="text-fg">{fmtDate(ts, { year: new Date(ts).getFullYear() !== thisYear })}</span> <span className="text-muted">{fmtTime(ts, { seconds: false })}</span>
        </span>
      );
    },
  },
  {
    key: 'account',
    label: 'Account',
    sortable: true,
    className: 'max-w-44',
    render: (t, c) => <span className="block truncate text-muted">{accountName(c.accounts, t.accountId)}</span>,
  },
  { key: 'symbol', label: 'Symbol', sortable: true, render: (t) => <span className="font-semibold text-fg">{t.symbol}</span> },
  { key: 'side', label: 'Side', sortable: true, render: (t) => <span className={clsx('font-medium', directionClass(t))}>{directionLabel(t)}</span> },
  { key: 'qty', label: 'Qty', title: 'Largest position size during the trade', align: 'right', sortable: true, render: (t, c) => <span className="tnum">{fmtTradeQty(c.instruments, t.symbol, t.maxQty)}</span> },
  { key: 'entry', label: 'Avg entry', align: 'right', render: (t, c) => <span className="tnum text-muted">{fmtTradePrice(c.instruments, t.symbol, t.avgEntry)}</span> },
  { key: 'exitPrice', label: 'Avg exit', align: 'right', render: (t, c) => <span className="tnum text-muted">{fmtTradePrice(c.instruments, t.symbol, t.avgExit)}</span> },
  { key: 'net', label: 'Net P&L', align: 'right', sortable: true, render: (t) => <Money value={t.netPnl} sign colored className="font-semibold" /> },
  { key: 'r', label: 'R', title: 'Net P&L ÷ initial risk', align: 'right', sortable: true, render: (t) => <span className={clsx('tnum', pnlTone(t.rMultiple, 'text-faint'))}>{fmtR(t.rMultiple)}</span> },
  { key: 'hold', label: 'Hold', align: 'right', sortable: true, render: (t) => <span className="tnum text-muted">{fmtDuration(holdTime(t))}</span> },
  {
    key: 'mae',
    label: 'MAE',
    title: 'Maximum adverse excursion — worst open P&L during the trade',
    align: 'right',
    sortable: true,
    render: (t) => <Money value={t.mae} className={t.mae < -0.005 ? 'text-loss/80' : 'text-faint'} />,
  },
  {
    key: 'mfe',
    label: 'MFE',
    title: 'Maximum favorable excursion — best open P&L during the trade',
    align: 'right',
    sortable: true,
    render: (t) => <Money value={t.mfe} className={t.mfe > 0.005 ? 'text-profit/80' : 'text-faint'} />,
  },
  { key: 'exit', label: 'Exit', sortable: true, render: (t) => <span className={clsx('whitespace-nowrap', exitReasonClass(t.exitReason))}>{exitReasonLabel(t.exitReason)}</span> },
  {
    key: 'mood',
    label: 'Mood',
    align: 'center',
    sortable: true,
    render: (t) =>
      t.tags?.mood ? (
        <span title={moodLabel(t.tags.mood)} className="text-sm leading-none">
          {moodEmoji(t.tags.mood)}
        </span>
      ) : (
        <span className="text-faint">·</span>
      ),
  },
  {
    key: 'setup',
    label: 'Setup',
    sortable: true,
    className: 'max-w-28',
    render: (t) => {
      const s = normalizeSetup(t.tags?.setup);
      return s ? <span className="block truncate text-fg">{s}</span> : <span className="text-faint">—</span>;
    },
  },
  {
    key: 'review',
    label: 'Review',
    align: 'center',
    sortable: true,
    render: (t) =>
      isReviewed(t) ? (
        <span title={t.review?.followedPlan === false ? 'Reviewed · plan broken' : 'Reviewed'} className="inline-flex text-fg">
          <CircleCheck size={15} />
        </span>
      ) : (
        <span title="Not reviewed yet" className="inline-block size-1.5 rounded-full bg-faint" />
      ),
  },
];

const alignClass = (a: Column['align']) => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left');

const Row = memo(function Row({ trade, ctx, columns, selected, onSelect }: { trade: Trade; ctx: RowCtx; columns: Column[]; selected: boolean; onSelect: (t: Trade) => void }) {
  return (
    <tr
      onClick={() => onSelect(trade)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(trade);
        }
      }}
      tabIndex={0}
      aria-selected={selected}
      className={clsx('h-8 cursor-pointer border-b border-line/70 transition-colors focus:outline-none focus-visible:bg-panel-3', selected ? 'bg-panel-3' : 'hover:bg-panel-2')}
    >
      {columns.map((c) => (
        <td key={c.key} className={clsx('px-2.5 first:pl-3 last:pr-3', alignClass(c.align), c.className)}>
          {c.render(trade, ctx)}
        </td>
      ))}
    </tr>
  );
});

export interface TradeTableProps {
  trades: Trade[];
  accounts: Record<string, Account>;
  instruments: Record<string, InstrumentSpec>;
  showAccount: boolean;
  sort: SortState;
  onSort: (s: SortState) => void;
  onSelect: (t: Trade) => void;
  selectedId: string | null;
  loading?: boolean;
  dim?: boolean;
  /** The table scrolls inside this box (sticky header); give it a height via flex or max-h. */
  className?: string;
  footer?: ReactNode;
}

export function TradeTable({ trades, accounts, instruments, showAccount, sort, onSort, onSelect, selectedId, loading, dim, className, footer }: TradeTableProps) {
  const columns = useMemo(() => (showAccount ? COLUMNS : COLUMNS.filter((c) => c.key !== 'account')), [showAccount]);
  const ctx = useMemo<RowCtx>(() => ({ accounts, instruments }), [accounts, instruments]);
  return (
    <div className={clsx('min-h-0 overflow-auto transition-opacity', dim && 'opacity-60', className)}>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="h-8 border-b border-line">
            {columns.map((c) => {
              const active = sort.key === c.key;
              const sortable = c.sortable && c.key !== 'entry' && c.key !== 'exitPrice';
              return (
                <th
                  key={c.key}
                  scope="col"
                  title={c.title}
                  aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={clsx('sticky top-0 z-10 whitespace-nowrap bg-panel px-2.5 text-2xs font-medium uppercase tracking-wider first:pl-3 last:pr-3', alignClass(c.align), active ? 'text-fg' : 'text-faint')}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => onSort({ key: c.key as SortKey, dir: active ? (sort.dir === 'asc' ? 'desc' : 'asc') : c.key === 'symbol' || c.key === 'account' || c.key === 'exit' || c.key === 'setup' ? 'asc' : 'desc' })}
                      className={clsx('inline-flex items-center gap-1 uppercase hover:text-fg', c.align === 'right' && 'flex-row-reverse')}
                    >
                      {c.label}
                      {active && (sort.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: 8 }, (_, i) => (
                <tr key={i} className="h-8 border-b border-line/70">
                  {columns.map((c) => (
                    <td key={c.key} className="px-2.5 first:pl-3 last:pr-3">
                      <Skeleton className="h-3 w-full max-w-16" />
                    </td>
                  ))}
                </tr>
              ))
            : trades.map((t) => <Row key={t.id} trade={t} ctx={ctx} columns={columns} selected={t.id === selectedId} onSelect={onSelect} />)}
        </tbody>
      </table>
      {footer}
    </div>
  );
}
