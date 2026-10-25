// Analytics tab: KPI tiles, plain-language insights, equity curve, daily bars and categorical breakdowns.

import { useMemo, type ReactNode } from 'react';
import { ChartLine, Info, TrendingDown, TrendingUp } from 'lucide-react';
import clsx from 'clsx';
import type { Trade } from '@shared/types';
import { fmtDate, fmtDuration, fmtMoney, fmtPct, pnlTone } from '@/lib/format';
import { navigate } from '@/lib/router';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { EmptyState, Skeleton, Spinner } from '@/components/ui/Misc';
import { Panel } from '@/components/ui/Panel';
import { Breakdown, HourColumns } from './Breakdown';
import { DailyBarsChart } from './DailyBarsChart';
import { EquityChart } from './EquityChart';
import { directionLabel, fmtProfitFactor, fmtR, plural } from './labels';
import { buildInsights, byHour, byMistake, byMood, byPlan, bySetup, bySide, bySymbol, byWeekday, CLEAN_KEY, computeKpis, dailyNet, equityCurve, type Insight } from './stats';

function Tile({ label, value, sub, onClick, title }: { label: string; value: ReactNode; sub?: ReactNode; onClick?: () => void; title?: string }) {
  const body = (
    <>
      <div className="truncate text-2xs font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className="mt-1 truncate text-xl font-semibold tracking-tight text-fg">{value}</div>
      {sub && <div className="tnum mt-0.5 truncate text-xs text-muted">{sub}</div>}
    </>
  );
  const cls = 'flex min-w-0 flex-col rounded-lg border border-line bg-panel px-3.5 py-3 text-left';
  return onClick ? (
    <button type="button" onClick={onClick} title={title} className={clsx(cls, 'transition-colors hover:border-line-strong hover:bg-panel-2')}>
      {body}
    </button>
  ) : (
    <div className={cls} title={title}>
      {body}
    </div>
  );
}

function InsightList({ insights }: { insights: Insight[] }) {
  if (insights.length === 0) return null;
  return (
    <Panel title="What your journal says" bodyClassName="py-2">
      <ul className="grid gap-x-8 gap-y-1.5 lg:grid-cols-2">
        {insights.map((i) => (
          <li key={i.id} className="flex items-start gap-2.5 text-[13px] leading-snug text-fg">
            <span className="mt-0.5 shrink-0">
              {i.tone === 'profit' ? <TrendingUp size={14} className="text-profit" /> : i.tone === 'loss' ? <TrendingDown size={14} className="text-loss" /> : <Info size={14} className="text-muted" />}
            </span>
            <span>{i.text}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 10 }, (_, i) => (
          <Skeleton key={i} className="h-[76px] rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-80 rounded-lg" />
    </div>
  );
}

export interface AnalyticsProps {
  trades: Trade[];
  loading: boolean;
  /** Remaining pages are still loading: numbers are provisional. */
  partial: boolean;
  onSelectTrade: (t: Trade) => void;
  hasFilters: boolean;
}

export function Analytics({ trades, loading, partial, onSelectTrade, hasFilters }: AnalyticsProps) {
  const k = useMemo(() => computeKpis(trades), [trades]);
  const curve = useMemo(() => equityCurve(trades), [trades]);
  const days = useMemo(() => dailyNet(trades), [trades]);
  const insights = useMemo(() => buildInsights(trades), [trades]);
  const g = useMemo(
    () => ({
      mood: byMood(trades),
      setup: bySetup(trades),
      symbol: bySymbol(trades),
      weekday: byWeekday(trades),
      hour: byHour(trades),
      side: bySide(trades),
      plan: byPlan(trades),
      mistakes: byMistake(trades),
    }),
    [trades],
  );

  if (loading) return <AnalyticsSkeleton />;
  if (trades.length === 0) {
    return (
      <Panel>
        <EmptyState
          icon={<ChartLine />}
          title={hasFilters ? 'No trades match these filters' : 'No closed trades in this period'}
          description={
            hasFilters
              ? 'Widen the date range or clear a filter to see your statistics.'
              : 'Your win rate, profit factor, equity curve and what your moods cost you will appear here after your first closed trade.'
          }
          action={
            !hasFilters && (
              <Button variant="primary" onClick={() => navigate('trade')}>
                Go to the trading terminal
              </Button>
            )
          }
        />
      </Panel>
    );
  }

  const reviewed = g.plan.filter((x) => x.key !== 'unknown').reduce((s, x) => s + x.trades, 0);
  const followed = g.plan.find((x) => x.key === 'followed')?.trades ?? 0;
  const reviewedTrades = trades.filter((t) => t.review).length;

  return (
    <div className={clsx('flex flex-col gap-3 transition-opacity', partial && 'opacity-70')}>
      {partial && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Spinner size={12} /> Loading every trade in this range — numbers will update…
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <Tile label="Net P&L" value={<Money value={k.net} sign colored />} sub={`Gross ${fmtMoney(k.gross, { sign: true })} · fees ${fmtMoney(-k.fees)}`} />
        <Tile label="Win rate" value={k.winRate == null ? '—' : fmtPct(k.winRate, 1)} sub={`${k.wins}W · ${k.losses}L${k.breakEven ? ` · ${k.breakEven} BE` : ''}`} />
        <Tile
          label="Profit factor"
          value={<span className={k.profitFactor == null ? 'text-faint' : k.profitFactor >= 1 ? 'text-profit' : 'text-loss'}>{fmtProfitFactor(k.profitFactor)}</span>}
          sub={`Won ${fmtMoney(k.grossWin, { whole: true })} · lost ${fmtMoney(Math.abs(k.grossLoss), { whole: true })}`}
          title="Money won on winners ÷ money lost on losers (after fees)"
        />
        <Tile label="Expectancy" value={<Money value={k.expectancy} sign colored />} sub="Average net per trade" />
        <Tile label="Avg R" value={<span className={pnlTone(k.avgR, 'text-faint')}>{fmtR(k.avgR)}</span>} sub={k.rTrades ? `${plural(k.rTrades, 'trade')} with an initial stop` : 'No initial stops recorded'} />
        <Tile label="Avg win" value={<Money value={k.avgWin} className={k.avgWin != null ? 'text-profit' : undefined} />} sub={k.payoffRatio != null ? `Payoff ${k.payoffRatio.toFixed(2)}× the avg loss` : '—'} />
        <Tile label="Avg loss" value={<Money value={k.avgLoss} className={k.avgLoss != null ? 'text-loss' : undefined} />} sub={k.losses ? plural(k.losses, 'losing trade') : 'No losing trades'} />
        <Tile
          label="Max drawdown"
          value={<span className={k.maxDrawdown > 0.005 ? 'text-loss' : 'text-fg'}>{fmtMoney(-k.maxDrawdown)}</span>}
          sub="Peak to trough, closed trades"
          title="Largest drop of the cumulative net P&L curve in this period"
        />
        <Tile
          label="Avg hold"
          value={k.avgHoldMs == null ? '—' : fmtDuration(k.avgHoldMs)}
          sub={`Wins ${k.avgWinHoldMs == null ? '—' : fmtDuration(k.avgWinHoldMs)} · losses ${k.avgLossHoldMs == null ? '—' : fmtDuration(k.avgLossHoldMs)}`}
        />
        <Tile label="Trades" value={k.trades.toLocaleString('en-US')} sub={plural(days.length, 'trading day')} />
        <Tile label="Fees paid" value={<span className="text-fg">{fmtMoney(-k.fees)}</span>} sub={k.trades ? `${fmtMoney(k.fees / k.trades)} per trade` : '—'} />
        <Tile
          label="Best trade"
          value={<Money value={k.best?.netPnl} sign colored />}
          sub={k.best ? `${k.best.symbol} ${directionLabel(k.best)} · ${fmtDate(k.best.closedAt ?? k.best.openedAt)}` : '—'}
          onClick={k.best ? () => onSelectTrade(k.best!) : undefined}
          title="Open this trade"
        />
        <Tile
          label="Worst trade"
          value={<Money value={k.worst?.netPnl} sign colored />}
          sub={k.worst ? `${k.worst.symbol} ${directionLabel(k.worst)} · ${fmtDate(k.worst.closedAt ?? k.worst.openedAt)}` : '—'}
          onClick={k.worst ? () => onSelectTrade(k.worst!) : undefined}
          title="Open this trade"
        />
        <Tile label="Longest win streak" value={plural(k.longestWinStreak, 'trade')} sub={k.currentStreak?.kind === 'win' ? `Current: ${k.currentStreak.count} in a row` : 'In a row'} />
        <Tile label="Longest loss streak" value={plural(k.longestLossStreak, 'trade')} sub={k.currentStreak?.kind === 'loss' ? `Current: ${k.currentStreak.count} in a row` : 'In a row'} />
      </div>

      <InsightList insights={insights} />

      <div className="grid gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel title="Equity curve · cumulative net P&L">
          <EquityChart points={curve} maxDrawdown={k.maxDrawdown} />
        </Panel>
        <Panel title="Daily net P&L">
          <DailyBarsChart days={days} />
        </Panel>
      </div>

      <div className="grid gap-3 lg:grid-cols-2 min-[1800px]:grid-cols-3">
        <Panel title="By mood at entry">
          <Breakdown groups={g.mood} showR />
        </Panel>
        <Panel title="By setup grade">
          <Breakdown groups={g.setup} showR />
        </Panel>
        <Panel title="By symbol">
          <Breakdown groups={g.symbol} showR renderLabel={(x) => <span className="font-medium">{x.label}</span>} />
        </Panel>
        <Panel title="By weekday (trading day)">
          <Breakdown groups={g.weekday} />
        </Panel>
        <Panel title="By hour of entry (local time)">
          <HourColumns groups={g.hour} />
        </Panel>
        <Panel title="Long vs short">
          <Breakdown groups={g.side} showR renderLabel={(x) => <span className={clsx('font-medium', x.key === 'long' ? 'text-profit' : 'text-loss')}>{x.label}</span>} />
        </Panel>
        <Panel
          title="Plan adherence"
          actions={reviewed > 0 ? <span className="tnum text-xs text-muted">Followed in {fmtPct(followed / reviewed, 0)} of reviewed trades</span> : undefined}
        >
          <Breakdown groups={g.plan} showR />
        </Panel>
        <Panel title="Mistakes · count and cost" actions={<span className="tnum text-xs text-faint">{plural(reviewedTrades, 'reviewed trade')}</span>}>
          <Breakdown
            groups={g.mistakes}
            separateKey={CLEAN_KEY}
            emptyText="Review your trades (followed plan, mistakes) to see which habits cost you the most."
          />
          {g.mistakes.some((x) => x.key !== CLEAN_KEY) && <div className="mt-2 text-2xs text-faint">A trade tagged with two mistakes counts in both rows.</div>}
        </Panel>
      </div>
    </div>
  );
}
