// P&L Calendar: month grid (Sun–Sat + weekly totals) or year heatmap, month summary, day drawer.
// #/calendar?view=month|year&month=YYYY-MM&account=all|<id>&day=YYYY-MM-DD

import { useCallback, useEffect, useMemo } from 'react';
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { calendarDayOf, monthKeyOf } from '@shared/time';
import { useApp } from '@/store/app';
import { useNow, useSnapshot } from '@/store/hooks';
import { fmtMonthKey } from '@/lib/format';
import { navigate, setParams, useRoute } from '@/lib/router';
import { Button, IconButton } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Misc';
import { Page } from '@/components/ui/Panel';
import { Segmented } from '@/components/ui/Tabs';
import { AccountFilter, resolveAccountParam } from '../journal/AccountFilter';
import { addMonths, daysOfMonth, isDayKey, isMonthKey, monthGrid, summarize } from './calendarMath';
import { DayDrawer } from './DayDrawer';
import { MonthGrid } from './MonthGrid';
import { MonthSummary } from './MonthSummary';
import { useDailyStats } from './useMonthData';
import { HeatLegend, YearView } from './YearView';

type View = 'month' | 'year';

function EmptyBanner({ hasAccounts, current, label }: { hasAccounts: boolean; current: boolean; label: string }) {
  if (!hasAccounts) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-panel px-4 py-3">
        <div>
          <div className="text-sm font-medium text-fg">Your P&L calendar starts with your first account</div>
          <div className="text-[13px] text-muted">Every trading day will show up here in green or red, with its net P&L, trades and win rate.</div>
        </div>
        <Button variant="primary" onClick={() => navigate('challenges', { new: 1 })}>
          Start a challenge
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-panel px-4 py-3">
      <div>
        <div className="text-sm font-medium text-fg">{current ? 'No trades yet this month' : `No trading in ${label}`}</div>
        <div className="text-[13px] text-muted">
          {current ? 'Each day you trade lights up green or red with its net P&L. Click any day to write a journal note.' : 'Pick another month, or click a day to add a journal note.'}
        </div>
      </div>
      {current && (
        <Button variant="primary" onClick={() => navigate('trade')}>
          Place a trade
        </Button>
      )}
    </div>
  );
}

export function CalendarPage() {
  const { params } = useRoute();
  const accounts = useApp((s) => s.accounts);
  const localTz = useApp((s) => s.localTz);
  const now = useNow(60_000);
  const localToday = calendarDayOf(now, localTz);

  const accountId = resolveAccountParam(params.get('account'), accounts);
  const account = accountId === 'all' ? null : (accounts[accountId] ?? null);
  const snapshot = useSnapshot(account?.id);
  // An active account's "today" is its current trading day (a 17:00 ET rollover moves it to tomorrow in the evening).
  const todayKey = account && account.status === 'active' ? (snapshot?.tradingDay ?? account.tradingDay ?? localToday) : localToday;

  const view: View = params.get('view') === 'year' ? 'year' : 'month';
  const dayParam = params.get('day');
  const selectedDay = isDayKey(dayParam) ? dayParam : null;
  // Month: explicit ?month=, else the month of ?day= (deep links like "Review today"), else today's month.
  const monthParam = params.get('month');
  const explicitMonth = isMonthKey(monthParam) ? monthParam : null;
  const month = explicitMonth ?? (selectedDay ? monthKeyOf(selectedDay) : monthKeyOf(todayKey));
  const year = Number(month.slice(0, 4));

  const grid = useMemo(() => monthGrid(month), [month]);
  const from = view === 'year' ? `${year}-01-01` : grid.start;
  const to = view === 'year' ? `${year}-12-31` : grid.end;
  const data = useDailyStats(accountId, from, to);

  const periodDays = useMemo(() => {
    if (!data.days) return [];
    return view === 'year' ? [...data.days.values()].filter((d) => d.day.startsWith(String(year))) : daysOfMonth(data.days, month);
  }, [data.days, view, year, month]);
  const summary = useMemo(() => (data.days ? summarize(periodDays) : null), [data.days, periodDays]);
  const current = view === 'year' ? todayKey.startsWith(String(year)) : monthKeyOf(todayKey) === month;
  const title = view === 'year' ? String(year) : fmtMonthKey(month);

  const go = useCallback(
    (step: number) => {
      const next = addMonths(month, view === 'year' ? 12 * step : step);
      setParams({ month: next === monthKeyOf(todayKey) ? null : next });
    },
    [month, view, todayKey],
  );
  const openDay = useCallback((day: string) => setParams({ day, month: monthKeyOf(day) === monthKeyOf(todayKey) ? null : monthKeyOf(day) }), [todayKey]);
  // Clicking a faded day of the neighbouring month keeps the visible month behind the drawer.
  const openDayInGrid = useCallback(
    (day: string) => setParams({ day, month: explicitMonth || monthKeyOf(day) !== month ? month : null }),
    [explicitMonth, month],
  );
  // Closing clears ?day= but keeps showing the same month (it may have come from the day itself).
  const closeDay = useCallback(() => setParams({ day: null, month: explicitMonth ?? (month === monthKeyOf(todayKey) ? null : month) }), [explicitMonth, month, todayKey]);

  // ← / → step months (years in the year view) when no drawer or input has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (selectedDay || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, selectedDay]);

  const hasAccounts = Object.keys(accounts).length > 0;
  const showEmpty = summary != null && summary.tradingDays === 0 && !data.error;

  return (
    <Page
      title="P&L Calendar"
      subtitle={account ? `${account.name} · net P&L per trading day` : 'All accounts · net P&L per trading day'}
      actions={
        <>
          <Segmented<View>
            size="md"
            value={view}
            onChange={(v) => setParams({ view: v === 'month' ? null : v })}
            options={[
              { value: 'month', label: 'Month' },
              { value: 'year', label: 'Year' },
            ]}
          />
          <AccountFilter value={accountId} onChange={(id) => setParams({ account: id === 'all' ? null : id })} />
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <IconButton label={view === 'year' ? 'Previous year (←)' : 'Previous month (←)'} icon={<ChevronLeft size={16} />} variant="outline" onClick={() => go(-1)} />
            <IconButton label={view === 'year' ? 'Next year (→)' : 'Next month (→)'} icon={<ChevronRight size={16} />} variant="outline" onClick={() => go(1)} />
            <Button size="sm" variant="outline" icon={<CalendarDays size={14} />} disabled={current} onClick={() => setParams({ month: null, day: null })}>
              Today
            </Button>
            <h2 className="ml-2 text-lg font-semibold tracking-tight text-fg">{title}</h2>
            {(data.refreshing || data.loading) && <Spinner size={13} className="text-faint" />}
          </div>
          {view === 'year' ? (
            <HeatLegend />
          ) : (
            <span className="text-2xs text-faint">Trading days follow each account’s rollover (17:00 ET for futures accounts).</span>
          )}
        </div>

        {data.error && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-loss/30 bg-loss/5 px-3 py-2 text-[13px]">
            <span className="flex items-center gap-2 text-fg">
              <AlertTriangle size={14} className="text-loss" /> Couldn’t load daily P&L — {data.error}
            </span>
            <Button size="sm" variant="secondary" icon={<RefreshCw size={13} />} onClick={data.reload}>
              Retry
            </Button>
          </div>
        )}

        <MonthSummary summary={summary} periodDays={periodDays} account={account} snapshot={snapshot} current={current} onOpenDay={openDay} />

        {showEmpty && <EmptyBanner hasAccounts={hasAccounts} current={current} label={title} />}

        {view === 'month' ? (
          <MonthGrid
            grid={grid}
            days={data.days}
            loading={data.loading}
            todayKey={todayKey}
            selectedDay={selectedDay}
            accountId={accountId}
            accounts={accounts}
            onSelectDay={openDayInGrid}
            dim={data.refreshing}
          />
        ) : (
          <YearView
            year={year}
            days={data.days}
            loading={data.loading}
            todayKey={todayKey}
            onOpenMonth={(m) => setParams({ view: null, month: m === monthKeyOf(todayKey) ? null : m })}
            onOpenDay={(d) => setParams({ view: null, day: d, month: monthKeyOf(d) === monthKeyOf(todayKey) ? null : monthKeyOf(d) })}
            dim={data.refreshing}
          />
        )}
      </div>

      <DayDrawer day={selectedDay} accountId={accountId} agg={selectedDay ? data.days?.get(selectedDay) : undefined} onClose={closeDay} onNavigate={openDay} />
    </Page>
  );
}
