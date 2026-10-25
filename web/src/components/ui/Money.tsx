import clsx from 'clsx';
import { fmtMoney, fmtPct, fmtWorkHours, pnlTone } from '@/lib/format';
import { useApp } from '@/store/app';

export interface MoneyProps {
  value: number | null | undefined;
  /** Prefix + for positive values. */
  sign?: boolean;
  /** Color green/red by sign (P&L). */
  colored?: boolean;
  whole?: boolean;
  compact?: boolean;
  className?: string;
  /** Show "≈ 6 h of work" as a native tooltip (when an hourly wage is set). */
  workTooltip?: boolean;
}

/** Formatted USD amount with tabular figures. */
export function Money({ value, sign, colored, whole, compact, className, workTooltip }: MoneyProps) {
  const wage = useApp((s) => (s.settings.showWorkHours ? s.settings.hourlyWage : null));
  if (value == null || !Number.isFinite(value)) return <span className={clsx('tnum text-faint', className)}>—</span>;
  return (
    <span className={clsx('tnum', colored && pnlTone(value), className)} title={workTooltip ? (fmtWorkHours(value, wage) ?? undefined) : undefined}>
      {fmtMoney(value, { sign, whole, compact })}
    </span>
  );
}

/** Signed, colored P&L. */
export function Pnl(props: Omit<MoneyProps, 'sign' | 'colored'>) {
  return <Money sign colored workTooltip {...props} />;
}

export function Pct({ value, sign, colored, digits = 1, className }: { value: number | null | undefined; sign?: boolean; colored?: boolean; digits?: number; className?: string }) {
  if (value == null || !Number.isFinite(value)) return <span className={clsx('tnum text-faint', className)}>—</span>;
  return <span className={clsx('tnum', colored && pnlTone(value), className)}>{fmtPct(value, digits, sign)}</span>;
}

/** "≈ 6.5 h of work" for an amount, or nothing when no hourly wage is set / disabled. */
export function WorkHours({ value, className }: { value: number | null | undefined; className?: string }) {
  const wage = useApp((s) => (s.settings.showWorkHours ? s.settings.hourlyWage : null));
  if (value == null) return null;
  const text = fmtWorkHours(value, wage);
  if (!text) return null;
  return <span className={clsx('text-xs text-faint', className)}>{text}</span>;
}
