import { useState } from 'react';
import clsx from 'clsx';
import { fmtMoney } from '@/lib/format';
import { NumberInput } from '@/components/ui/Input';

/** Quick-pick amounts plus a custom field. `value` null = nothing chosen yet. */
export function AmountPicker({
  value,
  onChange,
  picks,
  min = 1,
  max = 100_000,
  autoFocusCustom,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  picks: number[];
  min?: number;
  max?: number;
  autoFocusCustom?: boolean;
}) {
  const [custom, setCustom] = useState(() => value != null && !picks.includes(value));
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${picks.length + 1}, minmax(0, 1fr))` }}>
        {picks.map((p) => {
          const active = !custom && value === p;
          return (
            <button
              key={p}
              type="button"
              onClick={() => {
                setCustom(false);
                onChange(p);
              }}
              className={clsx(
                'tnum h-12 rounded-md border text-base font-semibold transition-colors',
                active ? 'border-fg bg-accent text-accent-fg' : 'border-line-strong bg-panel-2 text-fg hover:border-[#3a3a3a] hover:bg-panel-3',
              )}
            >
              {fmtMoney(p, { whole: true })}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => {
            setCustom(true);
            if (value != null && picks.includes(value)) onChange(null);
          }}
          className={clsx(
            'h-12 rounded-md border text-sm font-medium transition-colors',
            custom ? 'border-fg bg-accent text-accent-fg' : 'border-line-strong bg-panel-2 text-fg hover:border-[#3a3a3a] hover:bg-panel-3',
          )}
        >
          Custom
        </button>
      </div>
      {custom && (
        <NumberInput
          value={value}
          onChange={onChange}
          step={10}
          min={min}
          max={max}
          precision={2}
          prefix="$"
          placeholder="Amount"
          autoFocus={autoFocusCustom ?? true}
          invalid={value != null && (value < min || value > max)}
        />
      )}
    </div>
  );
}
