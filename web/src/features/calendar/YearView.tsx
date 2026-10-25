// Year view: 12 compact month heatmaps (green / red intensity), month totals; click a month or day to open it.

import clsx from 'clsx';
import { fmtDayKey, fmtMoney, fmtMonthKey, pnlTone } from '@/lib/format';
import { Skeleton } from '@/components/ui/Misc';
import { daysOfMonth, heatLevel, isTraded, maxAbsNet, monthGrid, summarize, yearMonths, type DayAgg } from './calendarMath';

const HEAT_PROFIT = ['', 'bg-profit/25', 'bg-profit/45', 'bg-profit/70', 'bg-profit'];
const HEAT_LOSS = ['', 'bg-loss/25', 'bg-loss/45', 'bg-loss/70', 'bg-loss'];

function heatClass(net: number, maxAbs: number): string {
  const lvl = heatLevel(net, maxAbs);
  if (lvl === 0) return 'bg-panel-3';
  return net > 0 ? HEAT_PROFIT[lvl] : HEAT_LOSS[lvl];
}

function MiniMonth({
  month,
  days,
  maxAbs,
  todayKey,
  loading,
  onOpenMonth,
  onOpenDay,
}: {
  month: string;
  days: Map<string, DayAgg> | null;
  maxAbs: number;
  todayKey: string;
  loading: boolean;
  onOpenMonth: (month: string) => void;
  onOpenDay: (day: string) => void;
}) {
  const grid = monthGrid(month);
  const s = summarize(days ? daysOfMonth(days, month) : []);
  const future = `${month}-01` > todayKey;
  return (
    <div className={clsx('flex flex-col gap-2 rounded-lg border border-line bg-panel p-3', future && 'opacity-50')}>
      <button type="button" onClick={() => onOpenMonth(month)} className="group flex items-baseline justify-between gap-2 text-left">
        <span className="text-[13px] font-semibold text-fg group-hover:underline">{fmtMonthKey(month).split(' ')[0]}</span>
        {loading && !days ? (
          <Skeleton className="h-3.5 w-16" />
        ) : s.tradingDays > 0 ? (
          <span className={clsx('tnum text-[13px] font-semibold', pnlTone(s.net, 'text-fg'))}>{fmtMoney(s.net, { sign: true, whole: Math.abs(s.net) >= 1000 })}</span>
        ) : (
          <span className="text-xs text-faint">—</span>
        )}
      </button>
      <div className="grid grid-cols-7 gap-[3px]">
        {grid.weeks.flat().map((d) => {
          if (!d.startsWith(month)) return <span key={d} className="aspect-square" />;
          const agg = days?.get(d);
          const traded = isTraded(agg);
          return (
            <button
              key={d}
              type="button"
              onClick={() => onOpenDay(d)}
              title={`${fmtDayKey(d, { year: true })} · ${traded ? `${fmtMoney(agg.net, { sign: true })} · ${agg.trades} trade${agg.trades === 1 ? '' : 's'}` : 'no trades'}`}
              aria-label={`${fmtDayKey(d, { year: true })}${traded ? `, ${fmtMoney(agg.net, { sign: true })}` : ', no trades'}`}
              className={clsx(
                'aspect-square rounded-[3px] transition-[outline] hover:outline hover:outline-1 hover:outline-fg/60',
                traded ? heatClass(agg.net, maxAbs) : 'bg-panel-3/60',
                d === todayKey && 'outline outline-1 outline-fg',
              )}
            />
          );
        })}
      </div>
      <div className="tnum flex justify-between text-2xs text-faint">
        <span>{s.tradingDays ? `${s.tradingDays} day${s.tradingDays === 1 ? '' : 's'}` : 'No trading'}</span>
        {s.tradingDays > 0 && (
          <span>
            <span className="text-profit">{s.greenDays}</span> green · <span className="text-loss">{s.redDays}</span> red
          </span>
        )}
      </div>
    </div>
  );
}

export function HeatLegend() {
  return (
    <div className="flex items-center gap-1.5 text-2xs text-faint">
      <span>Loss</span>
      {[4, 3, 2, 1].map((l) => (
        <span key={`l${l}`} className={clsx('size-2.5 rounded-[2px]', HEAT_LOSS[l])} />
      ))}
      <span className="size-2.5 rounded-[2px] bg-panel-3" />
      {[1, 2, 3, 4].map((l) => (
        <span key={`p${l}`} className={clsx('size-2.5 rounded-[2px]', HEAT_PROFIT[l])} />
      ))}
      <span>Profit</span>
    </div>
  );
}

export interface YearViewProps {
  year: number;
  days: Map<string, DayAgg> | null;
  loading: boolean;
  todayKey: string;
  onOpenMonth: (month: string) => void;
  onOpenDay: (day: string) => void;
  dim?: boolean;
}

export function YearView({ year, days, loading, todayKey, onOpenMonth, onOpenDay, dim }: YearViewProps) {
  const maxAbs = days ? maxAbsNet(days.values()) : 0;
  return (
    <div className={clsx('grid grid-cols-2 gap-3 transition-opacity md:grid-cols-3 xl:grid-cols-4 min-[1900px]:grid-cols-6', dim && 'opacity-70')}>
      {yearMonths(year).map((m) => (
        <MiniMonth key={m} month={m} days={days} maxAbs={maxAbs} todayKey={todayKey} loading={loading} onOpenMonth={onOpenMonth} onOpenDay={onOpenDay} />
      ))}
    </div>
  );
}
