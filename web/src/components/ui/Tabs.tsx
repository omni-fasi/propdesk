import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  count?: number;
}

/** Underlined tabs (panel headers, page sections). */
export function Tabs<T extends string>({ value, onChange, items, className, size = 'md' }: { value: T; onChange: (v: T) => void; items: TabItem<T>[]; className?: string; size?: 'sm' | 'md' }) {
  return (
    <div role="tablist" className={clsx('flex items-stretch gap-4', className)}>
      {items.map((it) => {
        const active = it.id === value;
        return (
          <button
            key={it.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(it.id)}
            className={clsx(
              '-mb-px flex items-center gap-1.5 border-b-2 font-medium transition-colors',
              size === 'sm' ? 'h-8 text-xs' : 'h-9 text-[13px]',
              active ? 'border-fg text-fg' : 'border-transparent text-muted hover:text-fg',
            )}
          >
            {it.label}
            {it.count != null && it.count > 0 && <span className={clsx('tnum rounded px-1 text-2xs', active ? 'bg-fg text-bg' : 'bg-panel-3 text-muted')}>{it.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

/** Pill switcher (order type, timeframe, filters). The selected segment is white. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'sm',
  block,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentOption<T>[];
  size?: 'xs' | 'sm' | 'md';
  block?: boolean;
  className?: string;
}) {
  return (
    <div className={clsx('inline-flex rounded-md border border-line bg-panel-2 p-0.5', block && 'flex w-full', className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            title={o.title}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={clsx(
              'inline-flex items-center justify-center gap-1 whitespace-nowrap rounded font-medium transition-colors disabled:opacity-40',
              size === 'xs' ? 'h-5 px-1.5 text-2xs' : size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-3 text-[13px]',
              block && 'flex-1',
              active ? 'bg-accent text-accent-fg shadow-sm' : 'text-muted hover:text-fg',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
