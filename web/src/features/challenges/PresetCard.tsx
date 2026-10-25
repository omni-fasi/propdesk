import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { ArrowRight, ChevronDown } from 'lucide-react';
import type { ChallengePreset } from '@shared/types';
import { DRAWDOWN_LABELS, rulesSummary } from '@/lib/rules';
import { fmtMoney, fmtPct } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

const STYLE_LABEL: Record<ChallengePreset['style'], string> = { futures: 'Futures', cfd: 'Forex & CFD', crypto: '24/7 markets' };

export function PhaseTargets({ preset, className }: { preset: ChallengePreset; className?: string }) {
  const start = preset.rules.startingBalance;
  return (
    <div className={clsx('flex flex-col gap-1', className)}>
      {preset.phases.map((ph) => (
        <div key={ph.name} className="flex items-baseline justify-between gap-3 text-xs">
          <span className="text-muted">{ph.name}</span>
          <span className="tnum text-fg">
            +{fmtMoney(ph.profitTarget, { whole: true })} <span className="text-faint">({fmtPct(ph.profitTarget / start, 0)})</span>
            {ph.minTradingDays > 0 && <span className="text-faint"> · min {ph.minTradingDays} days</span>}
          </span>
        </div>
      ))}
      {preset.funded && (
        <div className="flex items-baseline justify-between gap-3 text-xs">
          <span className="text-muted">Funded</span>
          <span className="text-fg">
            {fmtPct(preset.funded.payout.profitSplit, 0)} profit split <span className="text-faint">· {preset.funded.payout.minWinningDays} winning days per payout</span>
          </span>
        </div>
      )}
    </div>
  );
}

export function FullRules({ preset }: { preset: ChallengePreset }) {
  const lines = useMemo(() => rulesSummary(preset.rules), [preset.rules]);
  return (
    <ul className="flex flex-col gap-1 text-xs text-muted">
      {lines.map((l) => (
        <li key={l} className="flex gap-2">
          <span className="text-faint">·</span>
          {l}
        </li>
      ))}
    </ul>
  );
}

/** A challenge in the gallery: size, key rules, highlights, prices; full rules on expand. */
export function PresetCard({ preset, onSelect, affordable }: { preset: ChallengePreset; onSelect: () => void; affordable: boolean }) {
  const [open, setOpen] = useState(false);
  const r = preset.rules;
  return (
    <article className="flex flex-col rounded-lg border border-line bg-panel-2 transition-colors hover:border-line-strong">
      <div className="flex flex-1 flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-2xs font-medium uppercase tracking-wider text-faint">{STYLE_LABEL[preset.style]}</div>
            <h3 className="mt-0.5 text-[15px] font-semibold tracking-tight text-fg">{preset.name}</h3>
            <p className="mt-0.5 text-xs text-muted">{preset.tagline}</p>
          </div>
          <Badge tone="outline">{preset.phases.length === 1 ? '1 step' : `${preset.phases.length} steps`}</Badge>
        </div>

        <div>
          <div className="tnum text-2xl font-semibold tracking-tight text-fg">{fmtMoney(r.startingBalance, { whole: true })}</div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
            {r.profitTarget != null && (
              <span>
                Target <span className="tnum text-profit">+{fmtMoney(r.profitTarget, { whole: true })}</span>
              </span>
            )}
            {r.maxLoss && (
              <span>
                Max loss <span className="tnum text-loss">{fmtMoney(r.maxLoss.amount, { whole: true })}</span>{' '}
                <span className="text-faint">{DRAWDOWN_LABELS[r.maxLoss.mode].short.toLowerCase()}</span>
              </span>
            )}
            {r.dailyLoss && (
              <span>
                Daily <span className="tnum text-fg">{fmtMoney(r.dailyLoss.amount, { whole: true })}</span>
              </span>
            )}
          </div>
        </div>

        <ul className="flex flex-col gap-1.5 text-xs text-muted">
          {preset.highlights.map((h) => (
            <li key={h} className="flex gap-2">
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-faint" />
              {h}
            </li>
          ))}
        </ul>

        <PhaseTargets preset={preset} className="border-t border-line pt-3" />

        <div>
          <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-xs text-muted transition-colors hover:text-fg" aria-expanded={open}>
            <ChevronDown size={13} className={clsx('transition-transform', !open && '-rotate-90')} />
            Full rules
          </button>
          {open && (
            <div className="mt-2 border-l border-line pl-3">
              <FullRules preset={preset} />
            </div>
          )}
        </div>
      </div>

      <div className="flex items-end justify-between gap-3 border-t border-line px-4 py-3">
        <div>
          <div className="tnum text-xl font-semibold text-fg">{fmtMoney(preset.fee)}</div>
          <div className="tnum text-2xs text-faint">
            {preset.resetFee != null ? `Reset ${fmtMoney(preset.resetFee, { whole: true })}` : 'No reset discount'} · Activation{' '}
            {preset.activationFee > 0 ? fmtMoney(preset.activationFee, { whole: true }) : 'free'}
          </div>
        </div>
        <Button variant={affordable ? 'primary' : 'secondary'} size="sm" iconRight={<ArrowRight size={14} />} onClick={onSelect}>
          Select
        </Button>
      </div>
    </article>
  );
}
