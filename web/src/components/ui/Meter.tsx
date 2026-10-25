import clsx from 'clsx';

export type MeterTone = 'neutral' | 'profit' | 'loss' | 'warn' | 'risk';

export interface MeterProps {
  /** 0..1 (clamped). */
  value: number;
  /**
   * risk: the value is the REMAINING share of a buffer — white above 50 %, amber 25–50 %, red below 25 %.
   */
  tone?: MeterTone;
  height?: number;
  /** Optional marker position 0..1 (e.g. a pass line). */
  marker?: number | null;
  className?: string;
  label?: string;
}

const fills: Record<Exclude<MeterTone, 'risk'>, string> = {
  neutral: 'bg-fg/80',
  profit: 'bg-profit',
  loss: 'bg-loss',
  warn: 'bg-warn',
};

export function riskTone(remaining: number): Exclude<MeterTone, 'risk'> {
  return remaining > 0.5 ? 'neutral' : remaining > 0.25 ? 'warn' : 'loss';
}

export function Meter({ value, tone = 'neutral', height = 6, marker, className, label }: MeterProps) {
  const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const t = tone === 'risk' ? riskTone(v) : tone;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={v}
      className={clsx('relative w-full overflow-hidden rounded-full bg-panel-3', className)}
      style={{ height }}
    >
      <div className={clsx('h-full rounded-full transition-[width] duration-300 ease-out', fills[t])} style={{ width: `${v * 100}%` }} />
      {marker != null && Number.isFinite(marker) && (
        <div className="absolute inset-y-0 w-0.5 bg-fg" style={{ left: `calc(${Math.min(1, Math.max(0, marker)) * 100}% - 1px)` }} />
      )}
    </div>
  );
}
