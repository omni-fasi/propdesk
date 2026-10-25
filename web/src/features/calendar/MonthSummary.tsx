// Summary strip above the grid: net, trading days, green/red days, win rate, best/worst/avg day, fees,
// plus balance & target context when a single account is selected.

import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { Account, AccountSnapshot } from '@shared/types';
import { fmtDayKey, fmtMoney, fmtPct } from '@/lib/format';
import { StatusBadge } from '@/components/ui/Badge';
import { Meter } from '@/components/ui/Meter';
import { Money } from '@/components/ui/Money';
import { Skeleton } from '@/components/ui/Misc';
import type { DayAgg, PeriodSummary } from './calendarMath';

function Cell({ label, children, sub, onClick, className }: { label: string; children: ReactNode; sub?: ReactNode; onClick?: () => void; className?: string }) {
  const inner = (
    <>
      <span className="truncate text-2xs font-medium uppercase tracking-wider text-faint">{label}</span>
      <span className="mt-0.5 truncate text-base font-semibold tracking-tight text-fg">{children}</span>
      {sub != null && <span className="tnum truncate text-2xs text-muted">{sub}</span>}
    </>
  );
  const cls = clsx('flex min-w-0 flex-col px-4 py-2.5 text-left', className);
  return onClick ? (
    <button type="button" onClick={onClick} className={clsx(cls, 'transition-colors hover:bg-panel-2')}>
      {inner}
    </button>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

function GreenRedBar({ green, red, flat }: { green: number; red: number; flat: number }) {
  const total = green + red + flat;
  if (!total) return <div className="mt-1.5 h-1 w-full rounded-full bg-panel-3" />;
  return (
    <div className="mt-1.5 flex h-1 w-full gap-[2px] overflow-hidden rounded-full">
      {green > 0 && <div className="h-full rounded-l-full bg-profit" style={{ width: `${(green / total) * 100}%` }} />}
      {flat > 0 && <div className="h-full bg-muted" style={{ width: `${(flat / total) * 100}%` }} />}
      {red > 0 && <div className="h-full rounded-r-full bg-loss" style={{ width: `${(red / total) * 100}%` }} />}
    </div>
  );
}

export interface MonthSummaryProps {
  summary: PeriodSummary | null;
  /** In-period days, for balance context of a single account. */
  periodDays: DayAgg[];
  account: Account | null;
  snapshot: AccountSnapshot | null;
  /** The period contains today (live balance applies). */
  current: boolean;
  onOpenDay: (day: string) => void;
}

export function MonthSummary({ summary: s, periodDays, account, snapshot, current, onOpenDay }: MonthSummaryProps) {
  if (!s) {
    return (
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4 xl:grid-cols-8">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="bg-panel px-4 py-3">
            <Skeleton className="mb-2 h-2.5 w-16" />
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </div>
    );
  }
  const fmtDay = (k: string) => fmtDayKey(k, { weekday: false });

  // Balance context for one account: first start balance and last end balance of the period.
  let context: ReactNode = null;
  if (account) {
    const rows = periodDays.flatMap((d) => d.rows).sort((a, b) => (a.day < b.day ? -1 : 1));
    const live = current && account.status === 'active';
    const endBalance = live ? (snapshot?.balance ?? account.balance) : (rows[rows.length - 1]?.endBalance ?? null);
    const startBalance = rows[0]?.startBalance ?? null;
    const target = account.rules.profitTarget;
    const profit = (snapshot?.balance ?? account.balance) - account.rules.startingBalance;
    context = (
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line bg-panel px-4 py-2.5 text-xs text-muted">
        <span className="flex items-center gap-2">
          <span className="font-medium text-fg">{account.name}</span>
          <StatusBadge status={account.status} size="xs" />
        </span>
        {startBalance != null && (
          <span className="tnum">
            Started the period at <span className="text-fg">{fmtMoney(startBalance)}</span>
          </span>
        )}
        {endBalance != null && (
          <span className="tnum">
            {live ? 'Balance now' : 'Ended at'} <span className="font-medium text-fg">{fmtMoney(endBalance)}</span>
          </span>
        )}
        {target != null && account.kind === 'evaluation' && (
          <span className="flex min-w-56 flex-1 items-center gap-3">
            <span className="tnum shrink-0">
              Target <Money value={profit} sign colored /> of {fmtMoney(target, { whole: true })}
            </span>
            <Meter value={profit / target} tone={profit >= target ? 'profit' : 'neutral'} className="max-w-64" label="Profit target progress" />
            <span className="tnum shrink-0 text-faint">{fmtPct(Math.max(0, profit) / target, 0)}</span>
          </span>
        )}
        {account.endReason && <span className="text-faint">{account.endReason}</span>}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4 xl:grid-cols-8">
        <Cell label="Net P&L" className="bg-panel" sub={s.tradingDays ? `Gross ${fmtMoney(s.gross, { sign: true })}` : 'No trades yet'}>
          <Money value={s.net} sign colored className="text-xl" />
        </Cell>
        <Cell label="Trading days" className="bg-panel" sub={s.trades ? `${s.trades} trade${s.trades === 1 ? '' : 's'}` : '—'}>
          <span className="tnum">{s.tradingDays}</span>
        </Cell>
        <Cell label="Green / red days" className="bg-panel">
          <span className="tnum">
            <span className="text-profit">{s.greenDays}</span>
            <span className="text-faint"> / </span>
            <span className="text-loss">{s.redDays}</span>
          </span>
          <GreenRedBar green={s.greenDays} red={s.redDays} flat={s.flatDays} />
        </Cell>
        <Cell label="Win rate" className="bg-panel" sub={s.trades ? `${s.wins}W · ${s.losses}L` : '—'}>
          <span className="tnum">{s.winRate == null ? '—' : fmtPct(s.winRate, 0)}</span>
        </Cell>
        <Cell label="Best day" className="bg-panel" sub={s.best ? fmtDay(s.best.day) : '—'} onClick={s.best ? () => onOpenDay(s.best!.day) : undefined}>
          {s.best ? <Money value={s.best.net} sign colored /> : <span className="text-faint">—</span>}
        </Cell>
        <Cell label="Worst day" className="bg-panel" sub={s.worst ? fmtDay(s.worst.day) : '—'} onClick={s.worst ? () => onOpenDay(s.worst!.day) : undefined}>
          {s.worst ? <Money value={s.worst.net} sign colored /> : <span className="text-faint">—</span>}
        </Cell>
        <Cell
          label="Average day"
          className="bg-panel"
          sub={s.avgGreen != null || s.avgRed != null ? `Green ${s.avgGreen != null ? fmtMoney(s.avgGreen, { sign: true }) : '—'} · red ${s.avgRed != null ? fmtMoney(s.avgRed) : '—'}` : '—'}
        >
          <Money value={s.avgDay} sign colored />
        </Cell>
        <Cell label="Fees paid" className="bg-panel" sub={s.trades ? `${fmtMoney(s.fees / s.trades)} per trade` : '—'}>
          <span className="tnum">{fmtMoney(-s.fees)}</span>
        </Cell>
      </div>
      {context}
    </div>
  );
}
