import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Check, Minus } from 'lucide-react';
import type { Account, AccountSnapshot } from '@shared/types';
import { accountMetrics, DRAWDOWN_LABELS } from '@/lib/rules';
import { fmtMoney, fmtPct } from '@/lib/format';
import { Meter, riskTone } from '@/components/ui/Meter';
import { Money } from '@/components/ui/Money';
import { Tooltip } from '@/components/ui/Popover';

function Row({ label, tip, right, sub, children }: { label: ReactNode; tip?: string; right: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        {tip ? (
          <Tooltip content={tip}>
            <span className="cursor-help text-muted underline decoration-line-strong decoration-dotted underline-offset-4">{label}</span>
          </Tooltip>
        ) : (
          <span className="text-muted">{label}</span>
        )}
        <span className="tnum text-right text-fg">{right}</span>
      </div>
      {children}
      {sub && <div className="tnum text-2xs text-faint">{sub}</div>}
    </div>
  );
}

const toneText = { neutral: 'text-fg', warn: 'text-warn', loss: 'text-loss', profit: 'text-profit' } as const;

/** Rule progress of an account: profit target, max loss / daily loss buffers, trading days, consistency. */
export function RuleMeters({ account, snapshot }: { account: Account; snapshot: AccountSnapshot | null }) {
  const m = accountMetrics(account, snapshot);
  const r = account.rules;
  const profit = (snapshot?.balance ?? account.balance) - r.startingBalance;

  if (!m.target && !m.maxLoss && !m.dailyLoss && !m.days && !m.consistency) {
    return <div className="text-xs text-faint">No challenge rules — your balance, your call.</div>;
  }

  return (
    <div className="flex flex-col gap-3.5">
      {m.target && (
        <Row
          label="Profit target"
          right={
            <>
              <Money value={m.target.profit} sign className={clsx(m.target.profit > 0 ? 'text-profit' : m.target.profit < 0 ? 'text-loss' : 'text-muted')} />
              <span className="text-faint"> / {fmtMoney(m.target.target, { whole: true })}</span>
            </>
          }
          sub={m.target.progress >= 1 ? 'Target reached' : `${fmtPct(m.target.progress, 0)} · ${fmtMoney(Math.max(0, m.target.target - m.target.profit))} to go`}
        >
          <Meter value={m.target.progress} tone="profit" label="Profit target progress" />
        </Row>
      )}

      {m.maxLoss && r.maxLoss && (
        <Row
          label={`Max loss · ${DRAWDOWN_LABELS[r.maxLoss.mode].short}`}
          tip={DRAWDOWN_LABELS[r.maxLoss.mode].long}
          right={
            <>
              <Money value={m.maxLoss.buffer} className={toneText[riskTone(m.maxLoss.remaining)]} />
              <span className="text-faint"> left of {fmtMoney(m.maxLoss.amount, { whole: true })}</span>
            </>
          }
          sub={`Fails if equity reaches ${fmtMoney(m.maxLoss.threshold)}`}
        >
          <Meter value={m.maxLoss.remaining} tone="risk" label="Max loss buffer remaining" />
        </Row>
      )}

      {m.dailyLoss && r.dailyLoss && (
        <Row
          label="Daily loss"
          tip={r.dailyLoss.action === 'fail' ? 'Hitting it fails the account' : 'Hitting it closes your positions and locks trading until the next trading day'}
          right={
            <>
              <Money value={m.dailyLoss.buffer} className={toneText[riskTone(m.dailyLoss.remaining)]} />
              <span className="text-faint"> left of {fmtMoney(m.dailyLoss.amount, { whole: true })}</span>
            </>
          }
          sub={`${r.dailyLoss.action === 'fail' ? 'Fails' : 'Locks'} at ${fmtMoney(m.dailyLoss.threshold)} equity today`}
        >
          <Meter value={m.dailyLoss.remaining} tone="risk" label="Daily loss buffer remaining" />
        </Row>
      )}

      {(m.days || m.consistency) && (
        <div className="grid grid-cols-2 gap-3">
          {m.days && (
            <Row
              label="Trading days"
              right={
                <span className="inline-flex items-center gap-1">
                  {m.days.done} / {m.days.required}
                  {m.days.done >= m.days.required ? <Check size={12} className="text-profit" /> : null}
                </span>
              }
            >
              <div className="flex gap-0.5">
                {Array.from({ length: Math.min(m.days.required, 20) }, (_, i) => (
                  <span key={i} className={clsx('h-1.5 flex-1 rounded-full', i < m.days!.done ? 'bg-fg/80' : 'bg-panel-3')} />
                ))}
              </div>
            </Row>
          )}
          {m.consistency && (
            <Row
              label="Consistency"
              tip={`Your best day may be at most ${fmtPct(m.consistency.limitPct, 0)} of total profit`}
              right={
                profit > 0 ? (
                  <span className={clsx('inline-flex items-center gap-1', m.consistency.ok === false ? 'text-warn' : 'text-fg')}>
                    {fmtPct(m.consistency.bestDay / profit, 0)}
                    {m.consistency.ok ? <Check size={12} className="text-profit" /> : null}
                  </span>
                ) : (
                  <Minus size={12} className="text-faint" />
                )
              }
              sub={`Best day ${fmtMoney(m.consistency.bestDay)} · max ${fmtPct(m.consistency.limitPct, 0)}`}
            />
          )}
        </div>
      )}
    </div>
  );
}
