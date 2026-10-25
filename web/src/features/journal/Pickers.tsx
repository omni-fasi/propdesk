// Small journal inputs: mood picker, toggle chips, 1–5 scale.

import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { Mood } from '@shared/types';
import { MOODS } from '@shared/journal';

export function Chip({ active, onClick, children, title, className }: { active: boolean; onClick: () => void; children: ReactNode; title?: string; className?: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={clsx(
        'inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-xs font-medium transition-colors',
        active ? 'border-fg/70 bg-panel-3 text-fg' : 'border-line-strong text-muted hover:border-[#3a3a3a] hover:text-fg',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Emoji mood chips. Clicking the selected mood clears it. */
export function MoodPicker({ value, onChange, labels = true, className }: { value: Mood | null; onChange: (m: Mood | null) => void; labels?: boolean; className?: string }) {
  return (
    <div className={clsx('flex flex-wrap gap-1.5', className)} role="group" aria-label="Mood">
      {MOODS.map((m) => (
        <Chip key={m.id} active={value === m.id} onClick={() => onChange(value === m.id ? null : m.id)} title={m.label}>
          <span className="text-[13px] leading-none">{m.emoji}</span>
          {labels && m.label}
        </Chip>
      ))}
    </div>
  );
}

/** 1–5 segmented scale (confidence, execution rating). Clicking the selected value clears it. */
export function ScalePicker({ value, onChange, lowLabel, highLabel }: { value: number | null; onChange: (v: number | null) => void; lowLabel?: string; highLabel?: string }) {
  return (
    <div className="flex items-center gap-2">
      {lowLabel && <span className="text-2xs text-faint">{lowLabel}</span>}
      <div className="inline-flex rounded-md border border-line bg-panel-2 p-0.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            aria-pressed={value === n}
            onClick={() => onChange(value === n ? null : n)}
            className={clsx('tnum h-6 w-7 rounded text-xs font-medium transition-colors', value === n ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg')}
          >
            {n}
          </button>
        ))}
      </div>
      {highLabel && <span className="text-2xs text-faint">{highLabel}</span>}
    </div>
  );
}
