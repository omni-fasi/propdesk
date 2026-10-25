// Month grid (Sun–Sat) with a weekly-total column. Each day: net P&L, trades, win rate, heat tint, flags.

import { memo } from 'react';
import clsx from 'clsx';
import type { Account } from '@shared/types';
import { parseDayKey } from '@shared/time';
import { useApp } from '@/store/app';
import { fmtDayKey, fmtMoney, fmtPct, pnlTone } from '@/lib/format';
import { Skeleton } from '@/components/ui/Misc';
import { chartPalette, withAlpha } from '../journal/chartTheme';
import { isTraded, maxAbsNet, summarize, tintAlpha, type DayAgg, type MonthGridModel } from './calendarMath';
import { FlagIcons } from './flags';

const WEEKDAY_HEAD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Open P&L of accounts whose current trading day is `day` and that hold positions (live from snapshots). */
function OpenPnl({ day, accountId }: { day: string; accountId: string }) {
  const open = useApp((s) => {
    let sum = 0;
    let any = false;
    for (const snap of Object.values(s.snapshots)) {
      if (snap.tradingDay !== day || (accountId !== 'all' && snap.accountId !== accountId)) continue;
      let has = false;
      for (const p of Object.values(s.positions)) {
        if (p.accountId === snap.accountId) {
          has = true;
          break;
        }
      }
      if (!has) continue;
      any = true;
      sum += snap.openPnl;
    }
    return any ? Math.round(sum * 100) / 100 : null;
  });
  if (open == null) return null;
  return (
    <span className="tnum flex items-center gap-1 text-2xs text-faint" title="Unrealized P&L of open positions (not in the day total yet)">
      <span className="size-1.5 animate-pulse-soft rounded-full bg-current" />
      open <span className={pnlTone(open)}>{fmtMoney(open, { sign: true })}</span>
    </span>
  );
}

interface DayCellProps {
  day: string;
  data: DayAgg | undefined;
  inMonth: boolean;
  isToday: boolean;
  selected: boolean;
  maxAbs: number;
  accountId: string;
  accounts: Record<string, Account>;
  loading: boolean;
  onSelect: (day: string) => void;
}

const DayCell = memo(function DayCell({ day, data, inMonth, isToday, selected, maxAbs, accountId, accounts, loading, onSelect }: DayCellProps) {
  const { month, day: dom } = parseDayKey(day);
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const weekend = weekday === 0 || weekday === 6;
  const traded = isTraded(data);
  const p = chartPalette();
  const alpha = traded ? tintAlpha(data.net, maxAbs) : 0;
  const tint = alpha > 0 ? withAlpha(data!.net > 0 ? p.profit : p.loss, alpha) : undefined;
  const winRate = traded && data.trades > 0 ? data.wins / data.trades : null;
  const label = `${fmtDayKey(day, { year: true })}: ${traded ? `${fmtMoney(data.net, { sign: true })}, ${data.trades} trade${data.trades === 1 ? '' : 's'}` : 'no trades'}`;

  return (
    <button
      type="button"
      onClick={() => onSelect(day)}
      aria-label={label}
      className={clsx(
        '@container group relative flex h-[clamp(88px,11.5vh,150px)] min-w-0 flex-col p-2 text-left transition-colors focus:outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-fg/60',
        weekend ? 'bg-bg' : 'bg-panel',
        'hover:bg-panel-2',
        isToday && 'z-[1] ring-1 ring-inset ring-fg/85',
        selected && !isToday && 'z-[1] ring-1 ring-inset ring-fg/35',
      )}
    >
      {tint && <span aria-hidden className="pointer-events-none absolute inset-0" style={{ backgroundColor: tint }} />}
      <span className={clsx('relative flex min-w-0 flex-1 flex-col', !inMonth && 'opacity-35')}>
        <span className="flex items-start justify-between gap-1">
          <span
            className={clsx(
              'tnum text-xs font-medium',
              isToday ? 'rounded bg-fg px-1 text-bg' : weekend ? 'text-faint' : 'text-muted',
              !isToday && 'group-hover:text-fg',
            )}
          >
            {dom === 1 ? `${MONTH_SHORT[month - 1]} 1` : dom}
          </span>
          {data && <FlagIcons day={data} accounts={accounts} showNames={accountId === 'all'} />}
        </span>
        <span className="mt-auto flex min-w-0 flex-col gap-0.5">
          {loading && !data ? (
            inMonth && !weekend ? <Skeleton className="h-4 w-3/5 opacity-50" /> : null
          ) : traded ? (
            <>
              <span className={clsx('tnum truncate text-sm font-semibold tracking-tight @min-[9.5rem]:text-base @min-[13rem]:text-lg', pnlTone(data.net, 'text-fg'))}>
                {fmtMoney(data.net, { sign: true, compact: Math.abs(data.net) >= 100_000 })}
              </span>
              <span className="tnum truncate text-2xs text-muted">
                {data.trades} trade{data.trades === 1 ? '' : 's'}
                {winRate != null && <span className="text-faint"> · {fmtPct(winRate, 0)} win</span>}
              </span>
            </>
          ) : null}
          <OpenPnl day={day} accountId={accountId} />
        </span>
      </span>
    </button>
  );
});

function WeekCell({ week, days, inMonthRow }: { week: string[]; days: Map<string, DayAgg> | null; inMonthRow: boolean }) {
  const list = days ? week.map((d) => days.get(d)).filter((d): d is DayAgg => !!d) : [];
  const s = summarize(list);
  const first = parseDayKey(week[0]);
  const last = parseDayKey(week[6]);
  const range = first.month === last.month ? `${MONTH_SHORT[first.month - 1]} ${first.day}–${last.day}` : `${MONTH_SHORT[first.month - 1]} ${first.day} – ${MONTH_SHORT[last.month - 1]} ${last.day}`;
  return (
    <div className={clsx('@container flex h-[clamp(88px,11.5vh,150px)] min-w-0 flex-col justify-between bg-panel-2/60 p-2', !inMonthRow && 'opacity-60')}>
      <span className="tnum truncate text-2xs text-faint">{range}</span>
      {s.tradingDays > 0 ? (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className={clsx('tnum truncate text-sm font-semibold tracking-tight @min-[9.5rem]:text-base', pnlTone(s.net, 'text-fg'))}>{fmtMoney(s.net, { sign: true })}</span>
          <span className="tnum truncate text-2xs text-muted">
            {s.tradingDays} day{s.tradingDays === 1 ? '' : 's'} · <span className="text-profit">{s.greenDays}</span>/<span className="text-loss">{s.redDays}</span>
          </span>
        </span>
      ) : (
        <span className="text-2xs text-faint">—</span>
      )}
    </div>
  );
}

export interface MonthGridProps {
  grid: MonthGridModel;
  days: Map<string, DayAgg> | null;
  loading: boolean;
  todayKey: string;
  selectedDay: string | null;
  accountId: string;
  accounts: Record<string, Account>;
  onSelectDay: (day: string) => void;
  dim?: boolean;
}

export function MonthGrid({ grid, days, loading, todayKey, selectedDay, accountId, accounts, onSelectDay, dim }: MonthGridProps) {
  const inMonth = (d: string) => d.startsWith(grid.month);
  const maxAbs = days ? maxAbsNet([...days.values()].filter((d) => inMonth(d.day))) : 0;
  return (
    <div className={clsx('overflow-hidden rounded-lg border border-line transition-opacity', dim && 'opacity-70')}>
      <div className="grid grid-cols-[repeat(7,minmax(0,1fr))_minmax(96px,0.85fr)] gap-px bg-line">
        {WEEKDAY_HEAD.map((w, i) => (
          <div key={w} className={clsx('px-2 py-1.5 text-2xs font-medium uppercase tracking-wider', i === 0 || i === 6 ? 'bg-bg text-faint' : 'bg-panel text-muted')}>
            {w}
          </div>
        ))}
        <div className="bg-panel-2/60 px-2 py-1.5 text-2xs font-medium uppercase tracking-wider text-muted">Week</div>
        {grid.weeks.map((week) => (
          <WeekRow
            key={week[0]}
            week={week}
            days={days}
            loading={loading}
            inMonth={inMonth}
            todayKey={todayKey}
            selectedDay={selectedDay}
            maxAbs={maxAbs}
            accountId={accountId}
            accounts={accounts}
            onSelectDay={onSelectDay}
          />
        ))}
      </div>
    </div>
  );
}

function WeekRow({
  week,
  days,
  loading,
  inMonth,
  todayKey,
  selectedDay,
  maxAbs,
  accountId,
  accounts,
  onSelectDay,
}: {
  week: string[];
  days: Map<string, DayAgg> | null;
  loading: boolean;
  inMonth: (d: string) => boolean;
  todayKey: string;
  selectedDay: string | null;
  maxAbs: number;
  accountId: string;
  accounts: Record<string, Account>;
  onSelectDay: (day: string) => void;
}) {
  return (
    <>
      {week.map((d) => (
        <DayCell
          key={d}
          day={d}
          data={days?.get(d)}
          inMonth={inMonth(d)}
          isToday={d === todayKey}
          selected={d === selectedDay}
          maxAbs={maxAbs}
          accountId={accountId}
          accounts={accounts}
          loading={loading}
          onSelect={onSelectDay}
        />
      ))}
      <WeekCell week={week} days={days} inMonthRow={week.some(inMonth)} />
    </>
  );
}
