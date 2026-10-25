// Categorical P&L breakdowns: rows with a diverging bar (green right / red left of zero) + the numbers.

import type { ReactNode } from 'react';
import clsx from 'clsx';
import { fmtMoney, fmtPct, pnlTone } from '@/lib/format';
import { Money } from '@/components/ui/Money';
import { fmtR } from './labels';
import { hourLabel, type Group } from './stats';

function scaleOf(groups: readonly Group[]) {
  let pos = 0;
  let neg = 0;
  for (const g of groups) {
    if (g.net > 0) pos = Math.max(pos, g.net);
    else neg = Math.max(neg, -g.net);
  }
  return { pos, neg };
}

/** Horizontal bar for one row. Mixed signs → centered zero; one sign → bars grow from the left edge. */
function Bar({ value, pos, neg }: { value: number; pos: number; neg: number }) {
  const mixed = pos > 0 && neg > 0;
  const total = mixed ? pos + neg : Math.max(pos, neg);
  if (total <= 0) return <div className="h-2.5" />;
  const zero = mixed ? (neg / total) * 100 : 0;
  const width = (Math.abs(value) / total) * 100;
  const positive = value > 0;
  return (
    <div className="relative h-2.5">
      {mixed && <div className="absolute inset-y-[-3px] w-px bg-line-strong" style={{ left: `${zero}%` }} />}
      {Math.abs(value) >= 0.005 && (
        <div
          className={clsx('absolute inset-y-0', positive ? 'bg-profit' : 'bg-loss', mixed && !positive ? 'rounded-l-[3px]' : 'rounded-r-[3px]')}
          style={mixed ? (positive ? { left: `${zero}%`, width: `${width}%` } : { left: `${zero - width}%`, width: `${width}%` }) : { left: 0, width: `${width}%` }}
        />
      )}
    </div>
  );
}

export interface BreakdownProps {
  groups: readonly Group[];
  /** Label cell renderer (defaults to emoji + label). */
  renderLabel?: (g: Group) => ReactNode;
  /** Show the average R column. */
  showR?: boolean;
  /** Rows with zero trades are dimmed instead of hidden. */
  emptyText?: string;
  /** Header for the count column. */
  countLabel?: string;
  /** Grouping key that is drawn as a separate comparison row (e.g. "No mistakes"). */
  separateKey?: string;
}

export function Breakdown({ groups, renderLabel, showR, emptyText = 'No trades', countLabel = 'Trades', separateKey }: BreakdownProps) {
  if (groups.length === 0 || groups.every((g) => g.trades === 0)) return <div className="py-6 text-center text-xs text-faint">{emptyText}</div>;
  const scaled = groups.filter((g) => g.key !== separateKey);
  const { pos, neg } = scaleOf(groups);
  const cols = showR ? 'grid-cols-[minmax(84px,1.1fr)_minmax(60px,1.6fr)_88px_44px_44px_72px_52px]' : 'grid-cols-[minmax(84px,1.1fr)_minmax(60px,1.6fr)_88px_44px_44px_72px]';
  const row = (g: Group) => (
    <div key={g.key} className={clsx('grid items-center gap-3 py-1.5 text-[13px]', cols, g.trades === 0 && 'opacity-40')}>
      <div className="min-w-0 truncate text-fg" title={g.label}>
        {renderLabel ? (
          renderLabel(g)
        ) : (
          <>
            {g.emoji && <span className="mr-1.5">{g.emoji}</span>}
            {g.label}
          </>
        )}
      </div>
      <Bar value={g.net} pos={pos} neg={neg} />
      <Money value={g.net} sign colored className="text-right font-medium" />
      <span className="tnum text-right text-muted">{g.trades}</span>
      <span className="tnum text-right text-muted">{g.winRate == null ? '—' : fmtPct(g.winRate, 0)}</span>
      <span className={clsx('tnum text-right', pnlTone(g.avg, 'text-faint'))}>{g.avg == null ? '—' : fmtMoney(g.avg, { sign: true })}</span>
      {showR && <span className={clsx('tnum text-right', pnlTone(g.avgR, 'text-faint'))}>{fmtR(g.avgR, 1)}</span>}
    </div>
  );
  const separate = groups.filter((g) => g.key === separateKey);
  return (
    <div>
      <div className={clsx('grid gap-3 border-b border-line pb-1.5 text-2xs font-medium uppercase tracking-wider text-faint', cols)}>
        <span />
        <span />
        <span className="text-right">Net</span>
        <span className="text-right">{countLabel}</span>
        <span className="text-right">Win</span>
        <span className="text-right">Avg</span>
        {showR && <span className="text-right">Avg R</span>}
      </div>
      <div className="divide-y divide-line/50">{scaled.map(row)}</div>
      {separate.length > 0 && <div className="mt-1 border-t border-line-strong pt-1">{separate.map(row)}</div>}
    </div>
  );
}

/** 24 columns (local hour the trade was opened): green up / red down from a zero line. */
export function HourColumns({ groups }: { groups: readonly Group[] }) {
  const { pos, neg } = scaleOf(groups);
  const total = pos + neg;
  const zeroTop = total > 0 ? (pos / total) * 100 : 50;
  if (groups.every((g) => g.trades === 0)) return <div className="py-6 text-center text-xs text-faint">No trades</div>;
  return (
    <div>
      <div className="relative flex h-32 items-stretch gap-[2px]">
        <div className="pointer-events-none absolute inset-x-0 h-px bg-line-strong" style={{ top: `${zeroTop}%` }} />
        {groups.map((g) => {
          const h = total > 0 ? (Math.abs(g.net) / total) * 100 : 0;
          const up = g.net > 0;
          const h2 = Number(g.key);
          return (
            <div
              key={g.key}
              className="group relative flex-1 rounded-sm transition-colors hover:bg-panel-3/60"
              title={
                g.trades
                  ? `${hourLabel(h2)}–${hourLabel((h2 + 1) % 24)} · ${fmtMoney(g.net, { sign: true })} · ${g.trades} trade${g.trades === 1 ? '' : 's'} · ${g.winRate == null ? '—' : fmtPct(g.winRate, 0)} win`
                  : `${hourLabel(h2)}–${hourLabel((h2 + 1) % 24)} · no trades`
              }
            >
              {g.trades > 0 && Math.abs(g.net) >= 0.005 && (
                <div
                  className={clsx('absolute inset-x-[18%]', up ? 'rounded-t-[3px] bg-profit' : 'rounded-b-[3px] bg-loss')}
                  style={up ? { bottom: `${100 - zeroTop}%`, height: `${Math.max(h, 1.5)}%` } : { top: `${zeroTop}%`, height: `${Math.max(h, 1.5)}%` }}
                />
              )}
              {g.trades > 0 && Math.abs(g.net) < 0.005 && <div className="absolute inset-x-[18%] h-0.5 bg-muted" style={{ top: `calc(${zeroTop}% - 1px)` }} />}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-[2px] text-[10px] text-faint">
        {groups.map((g) => (
          <span key={g.key} className="tnum flex-1 text-center">
            {Number(g.key) % 3 === 0 ? String(g.key).padStart(2, '0') : ''}
          </span>
        ))}
      </div>
    </div>
  );
}
