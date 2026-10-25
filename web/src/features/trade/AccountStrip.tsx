// Account strip at the top of the trade page: money (live), challenge rule meters, pass blockers, lock.

import { useMemo, type ReactNode } from 'react';
import clsx from 'clsx';
import { CircleAlert, Lock, Plus } from 'lucide-react';
import type { Account, AccountSnapshot, InstrumentSpec, Position } from '@shared/types';
import { nextRolloverAt } from '@shared/time';
import { roundPrice } from '@shared/risk';
import { fmtCountdown, fmtMoney, fmtPct, fmtPrice, fmtQty } from '@/lib/format';
import { DRAWDOWN_LABELS, type BufferMetric } from '@/lib/rules';
import { navigate } from '@/lib/router';
import { useApp } from '@/store/app';
import { activeLock, combinePositions, useAccountPositions, useActiveAccount, useNow } from '@/store/hooks';
import { useMarket } from '@/store/market';
import { KindBadge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Meter } from '@/components/ui/Meter';
import { Money, Pnl, WorkHours } from '@/components/ui/Money';
import { Popover, Tooltip } from '@/components/ui/Popover';
import { useLiveAccount, type LiveAccount } from './useLiveAccount';

function Cell({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex min-w-0 shrink-0 flex-col justify-center gap-0.5', className)}>
      <div className="whitespace-nowrap text-2xs font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className="whitespace-nowrap text-[13px] font-semibold text-fg">{children}</div>
    </div>
  );
}

const Sep = () => <div className="h-8 w-px shrink-0 bg-line" />;

/** Prices at which each symbol's positions alone would take equity to the rule's level (others frozen). */
function BreachLevels({ positions: all, buffer }: { positions: Position[]; buffer: number }) {
  const instrumentMap = useApp((s) => s.instrumentMap);
  // A symbol's positions move together: one level per symbol.
  const positions = useMemo(
    () => [...new Set(all.map((p) => p.symbol))].map((sym) => combinePositions(all.filter((p) => p.symbol === sym))!),
    [all],
  );
  // One primitive per render: only re-renders when a displayed level actually changes.
  const text = useMarket((s) => {
    if (!positions.length || !(buffer > 0)) return '';
    return positions
      .map((p) => {
        const spec: InstrumentSpec | undefined = instrumentMap[p.symbol];
        if (!spec) return '';
        const q = s.quotes[p.symbol];
        const long = p.qty > 0;
        const mark = q ? (long ? q.bid : q.ask) : p.markPrice;
        const lvl = long ? mark - buffer / (Math.abs(p.qty) * spec.multiplier) : mark + buffer / (Math.abs(p.qty) * spec.multiplier);
        return `${p.symbol} ${long ? 'long' : 'short'} ${fmtQty(spec, p.qty)}: at ≈ ${lvl > 0 ? fmtPrice(spec, roundPrice(spec, lvl)) : '—'}`;
      })
      .filter(Boolean)
      .join('\n');
  });
  if (!text) return null;
  return (
    <span className="mt-1 block whitespace-pre-line text-muted">
      {text}
      {positions.length > 1 && <span className="block text-faint">Each level assumes the other positions don’t move.</span>}
    </span>
  );
}

function BufferMeter({ label, metric, tip, positions }: { label: string; metric: BufferMetric; tip: string; positions: Position[] }) {
  const left = Math.max(0, metric.buffer);
  return (
    <Tooltip
      side="bottom"
      content={
        <span className="block max-w-72 leading-relaxed">
          {tip} Level: equity ≤ <span className="num text-fg">{fmtMoney(metric.threshold)}</span>.
          <BreachLevels positions={positions} buffer={metric.buffer} />
        </span>
      }
    >
      <div className="flex w-36 shrink-0 cursor-default flex-col justify-center gap-1 2xl:w-44">
        <div className="flex items-baseline justify-between gap-2 text-2xs">
          <span className="font-medium uppercase tracking-wider text-faint">{label}</span>
          <span className="tnum text-muted">
            <span className={clsx('font-semibold', metric.remaining > 0.5 ? 'text-fg' : metric.remaining > 0.25 ? 'text-warn' : 'text-loss')}>{fmtMoney(left, { whole: left >= 100 })}</span> left of{' '}
            {fmtMoney(metric.amount, { whole: true })}
          </span>
        </div>
        <Meter tone="risk" value={metric.remaining} height={5} label={`${label} buffer`} />
      </div>
    </Tooltip>
  );
}

function TargetMeter({ profit, target, progress }: { profit: number; target: number; progress: number }) {
  return (
    <Tooltip side="bottom" content={<span>Closed profit toward the target. Open P&L counts only once you close it.</span>}>
      <div className="flex w-36 shrink-0 cursor-default flex-col justify-center gap-1 2xl:w-44">
        <div className="flex items-baseline justify-between gap-2 text-2xs">
          <span className="font-medium uppercase tracking-wider text-faint">Target</span>
          <span className="tnum text-muted">
            <Pnl value={profit} whole={Math.abs(profit) >= 100} className="font-semibold" /> of {fmtMoney(target, { whole: true })}
          </span>
        </div>
        <Meter tone="profit" value={progress} height={5} label="Profit target progress" />
      </div>
    </Tooltip>
  );
}

function LockBadge({ account }: { account: Account }) {
  const now = useNow(1000);
  const lock = activeLock(account, now);
  if (!lock) return null;
  const until = lock.until ?? nextRolloverAt(now, account.rules.rollover);
  return (
    <Tooltip side="bottom" content={<span className="block max-w-64">{lock.message}</span>}>
      <span className="flex shrink-0 items-center gap-1.5 rounded-md border border-warn/40 bg-warn/10 px-2 py-1 text-xs font-medium text-warn">
        <Lock size={12} />
        Locked
        <span className="num">{fmtCountdown(until - now)}</span>
        {lock.until == null && <span className="font-normal text-warn/80">· until next day</span>}
      </span>
    </Tooltip>
  );
}

function Blockers({ snapshot }: { snapshot: AccountSnapshot }) {
  if (!snapshot.passBlockers.length) return null;
  return (
    <Popover
      align="end"
      className="w-80 p-2"
      triggerClassName="flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-xs text-muted transition-colors hover:border-line-strong hover:text-fg"
      trigger={
        <>
          <CircleAlert size={13} className="text-warn" />
          {snapshot.passBlockers.length} to pass
        </>
      }
    >
      {() => (
        <div className="flex flex-col gap-1.5 p-1">
          <div className="text-2xs font-medium uppercase tracking-wider text-faint">Not passed yet because</div>
          {snapshot.passBlockers.map((b) => (
            <div key={b} className="flex gap-2 text-[13px] text-fg">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warn" />
              {b}
            </div>
          ))}
        </div>
      )}
    </Popover>
  );
}

function RuleCells({ account, live }: { account: Account; live: LiveAccount }) {
  const positions = useAccountPositions(account.id);
  const m = live.metrics;
  const r = account.rules;
  return (
    <>
      {m.maxLoss && (
        <BufferMeter
          label="Max loss"
          metric={m.maxLoss}
          positions={positions}
          tip={`${r.maxLoss ? DRAWDOWN_LABELS[r.maxLoss.mode].long : ''}. Breaching it fails the account.`}
        />
      )}
      {m.dailyLoss && (
        <BufferMeter
          label="Daily loss"
          metric={m.dailyLoss}
          positions={positions}
          tip={`Today's limit, measured from the day's starting balance. ${r.dailyLoss?.action === 'fail' ? 'Breaching it fails the account.' : 'Breaching it flattens you and locks trading until tomorrow.'}`}
        />
      )}
      {m.target && <TargetMeter {...m.target} />}
      {m.days && (
        <div className="hidden xl:block">
        <Cell label="Days">
          <span className={clsx('tnum', m.days.done >= m.days.required ? 'text-fg' : 'text-muted')}>
            {m.days.done}/{m.days.required}
          </span>
        </Cell>
        </div>
      )}
      {m.consistency && (
        <div className="hidden 2xl:block">
        <Tooltip side="bottom" content={<span className="block max-w-64">Your best day may be at most {fmtPct(m.consistency.limitPct, 0)} of your total profit to pass.</span>}>
          <Cell label="Consistency">
            <span className={clsx('tnum', m.consistency.ok === false ? 'text-warn' : 'text-muted')}>
              {m.consistency.ok == null ? '—' : m.consistency.ok ? 'OK' : 'Too lumpy'}
              {m.consistency.bestDay > 0 && <span className="ml-1 text-2xs font-normal text-faint">best {fmtMoney(m.consistency.bestDay, { whole: true })}</span>}
            </span>
          </Cell>
        </Tooltip>
        </div>
      )}
    </>
  );
}

function StatusBanner({ account }: { account: Account }) {
  if (account.status === 'active') return null;
  const tone = account.status === 'passed' ? 'text-profit border-profit/30 bg-profit/10' : account.status === 'failed' ? 'text-loss border-loss/30 bg-loss/10' : 'text-muted border-line bg-panel-2';
  return (
    <div className={clsx('flex shrink-0 items-center gap-2 rounded-md border px-2.5 py-1 text-xs', tone)}>
      <span className="font-semibold">{account.status === 'passed' ? 'Passed' : account.status === 'failed' ? 'Failed' : 'Closed'}</span>
      {account.endReason && <span className="text-muted">{account.endReason}</span>}
      <button className="font-medium text-fg underline-offset-2 hover:underline" onClick={() => navigate('challenges')}>
        Accounts →
      </button>
    </div>
  );
}

export function AccountStrip() {
  const account = useActiveAccount();
  const live = useLiveAccount(account);

  if (!account || !live) {
    return (
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-bg px-4">
        <span className="text-sm font-medium text-fg">No trading account yet</span>
        <span className="text-xs text-muted">Start a challenge or open a live account to place orders. The chart works without one.</span>
        <Button size="sm" variant="primary" className="ml-auto" icon={<Plus size={14} />} onClick={() => navigate('challenges', { new: 1 })}>
          New account
        </Button>
      </div>
    );
  }

  const f = live.figures;
  const isPractice = account.kind === 'practice';
  return (
    <div className="relative z-20 flex h-14 shrink-0 items-center gap-4 border-b border-line bg-bg px-4">
      <div className="flex min-w-0 shrink-0 flex-col justify-center gap-1">
        <span className="max-w-52 truncate text-[13px] font-semibold text-fg" title={account.name}>
          {account.name}
        </span>
        <span className="flex items-center gap-1.5">
          <KindBadge kind={account.kind} phase={account.phase} phaseCount={account.phaseCount} size="xs" />
          <StatusBadge status={account.status} size="xs" />
        </span>
      </div>
      <Sep />
      <Cell label="Balance">
        <Money value={f.balance} />
      </Cell>
      <Cell label="Equity">
        <Money value={f.equity} />
      </Cell>
      <Cell label="Open P&L">
        <Pnl value={f.openPnl} />
      </Cell>
      <Cell label="Day P&L">
        <span className="flex items-baseline gap-1.5">
          <Pnl value={f.dayPnl} />
          <WorkHours value={f.dayPnl} className="text-2xs font-normal" />
        </span>
      </Cell>
      {!isPractice && (
        <>
          <Sep />
          <RuleCells account={account} live={live} />
        </>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
        <StatusBanner account={account} />
        <LockBadge account={account} />
        <Blockers snapshot={live.snapshot} />
      </div>
    </div>
  );
}
