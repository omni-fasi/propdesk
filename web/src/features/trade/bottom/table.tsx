// Dense table primitives for the bottom panel + an inline number editor (Enter saves, Esc / blur cancels).

import { useState, type ReactNode, type ThHTMLAttributes, type TdHTMLAttributes } from 'react';
import clsx from 'clsx';
import { Check, X } from 'lucide-react';
import { NumberInput } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Misc';

export function Table({ children }: { children: ReactNode }) {
  return <table className="w-full border-collapse text-[13px]">{children}</table>;
}

export function Th({ children, className, right, ...rest }: ThHTMLAttributes<HTMLTableCellElement> & { right?: boolean }) {
  return (
    <th
      className={clsx('sticky top-0 z-10 h-7 whitespace-nowrap border-b border-line bg-panel px-2.5 text-2xs font-medium uppercase tracking-wider text-faint', right ? 'text-right' : 'text-left', className)}
      {...rest}
    >
      {children}
    </th>
  );
}

export function Td({ children, className, right, ...rest }: TdHTMLAttributes<HTMLTableCellElement> & { right?: boolean }) {
  return (
    <td className={clsx('h-8 whitespace-nowrap border-b border-line/60 px-2.5', right && 'text-right', className)} {...rest}>
      {children}
    </td>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-20 items-center justify-center px-4 text-center text-xs text-muted">{children}</div>;
}

export interface InlineNumberProps {
  value: number | null;
  display: ReactNode;
  step: number;
  precision: number;
  /** Return true when saved. */
  onCommit: (v: number) => Promise<boolean>;
  onClear?: () => void;
  clearLabel?: string;
  title?: string;
  disabled?: boolean;
  className?: string;
  min?: number;
}

export function InlineNumber({ value, display, step, precision, onCommit, onClear, clearLabel, title, disabled, className, min }: InlineNumberProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<number | null>(value);
  const [saving, setSaving] = useState(false);

  if (!editing) {
    return (
      <span className={clsx('group/inl inline-flex items-center gap-1', className)}>
        <button
          type="button"
          disabled={disabled}
          title={title ?? 'Click to edit'}
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
          className="num rounded px-1 -mx-1 underline decoration-dotted decoration-faint/60 underline-offset-[3px] transition-colors hover:bg-panel-3 disabled:no-underline"
        >
          {display}
        </button>
        {onClear && value != null && !disabled && (
          <button type="button" aria-label={clearLabel} title={clearLabel} onClick={onClear} className="hidden text-faint hover:text-fg group-hover/inl:inline-flex">
            <X size={12} />
          </button>
        )}
      </span>
    );
  }

  const commit = async () => {
    if (draft == null || draft === value || (min != null && draft < min)) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const ok = await onCommit(draft);
    setSaving(false);
    if (ok) setEditing(false);
  };

  return (
    <span className="inline-flex items-center gap-1">
      <NumberInput
        size="sm"
        value={draft}
        onChange={setDraft}
        step={step}
        min={min}
        precision={precision}
        autoFocus
        disabled={saving}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
          if (e.key === 'Escape') {
            e.stopPropagation();
            setEditing(false);
          }
        }}
        onBlur={() => {
          if (!saving) setEditing(false);
        }}
        className="num w-28"
      />
      {saving ? (
        <Spinner size={12} className="text-muted" />
      ) : (
        <button type="button" aria-label="Save" onMouseDown={(e) => e.preventDefault()} onClick={() => void commit()} className="text-muted hover:text-fg">
          <Check size={13} />
        </button>
      )}
    </span>
  );
}
