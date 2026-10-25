import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { AccountKind, AccountStatus } from '@shared/types';

export type BadgeTone = 'neutral' | 'solid' | 'outline' | 'profit' | 'loss' | 'warn';

const tones: Record<BadgeTone, string> = {
  neutral: 'bg-panel-3 text-muted',
  solid: 'bg-accent text-accent-fg',
  outline: 'border border-line-strong text-fg',
  profit: 'bg-profit/12 text-profit',
  loss: 'bg-loss/12 text-loss',
  warn: 'bg-warn/12 text-warn',
};

export function Badge({ tone = 'neutral', size = 'sm', dot, className, children }: { tone?: BadgeTone; size?: 'xs' | 'sm' | 'md'; dot?: boolean; className?: string; children: ReactNode }) {
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded font-medium',
        size === 'xs' ? 'h-4 px-1 text-[10px] uppercase tracking-wide' : size === 'sm' ? 'h-5 px-1.5 text-2xs' : 'h-6 px-2 text-xs',
        tones[tone],
        className,
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

const STATUS: Record<AccountStatus, { label: string; tone: BadgeTone }> = {
  active: { label: 'Active', tone: 'outline' },
  passed: { label: 'Passed', tone: 'profit' },
  failed: { label: 'Failed', tone: 'loss' },
  closed: { label: 'Closed', tone: 'neutral' },
};

export function StatusBadge({ status, size }: { status: AccountStatus; size?: 'xs' | 'sm' | 'md' }) {
  const s = STATUS[status];
  return (
    <Badge tone={s.tone} size={size} dot={status === 'active'}>
      {s.label}
    </Badge>
  );
}

const KIND: Record<AccountKind, string> = { practice: 'Live', evaluation: 'Evaluation', funded: 'Funded' };

export function KindBadge({ kind, phase, phaseCount, size }: { kind: AccountKind; phase?: number; phaseCount?: number; size?: 'xs' | 'sm' | 'md' }) {
  const label = kind === 'evaluation' && phaseCount && phaseCount > 1 ? `Phase ${phase}/${phaseCount}` : KIND[kind];
  return (
    <Badge tone={kind === 'funded' ? 'solid' : 'neutral'} size={size}>
      {label}
    </Badge>
  );
}
