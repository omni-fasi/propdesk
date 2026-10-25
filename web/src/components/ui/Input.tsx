import { forwardRef, useEffect, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import clsx from 'clsx';
import { decimalsOf } from '@shared/risk';

const box =
  'rounded-md border border-line-strong bg-panel-2 text-fg placeholder:text-faint transition-colors hover:border-[#3a3a3a] focus:border-fg/60 focus:outline-none disabled:opacity-50';

/** Full width unless the caller sets its own width class (`w-40`, `w-[220px]`…). */
const widthOf = (className?: string) => (className && /(^|\s)w-/.test(className) ? undefined : 'w-full');

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
  /** Label to the left (settings rows). */
  inline?: boolean;
  /** 'div' when the control is not a single input (segmented controls, button groups) so label clicks don't press a button. */
  as?: 'label' | 'div';
}

export function Field({ label, hint, error, className, children, inline, as: Tag = 'label' }: FieldProps) {
  if (inline) {
    return (
      <Tag className={clsx('flex items-center justify-between gap-6 py-2', className)}>
        <span className="min-w-0">
          <span className="block text-sm text-fg">{label}</span>
          {hint && <span className="mt-0.5 block text-xs text-muted">{hint}</span>}
          {error && <span className="mt-0.5 block text-xs text-loss">{error}</span>}
        </span>
        <span className="shrink-0">{children}</span>
      </Tag>
    );
  }
  return (
    <Tag className={clsx('flex min-w-0 flex-col gap-1', className)}>
      {label && <span className="text-xs font-medium text-muted">{label}</span>}
      {children}
      {error ? <span className="text-xs text-loss">{error}</span> : hint ? <span className="text-xs text-faint">{hint}</span> : null}
    </Tag>
  );
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  size?: 'sm' | 'md';
  prefix?: ReactNode;
  suffix?: ReactNode;
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ size = 'md', prefix, suffix, invalid, className, ...rest }, ref) {
  return (
    <div className={clsx('relative flex items-center', className)}>
      {prefix && <span className="pointer-events-none absolute left-2.5 text-sm text-faint">{prefix}</span>}
      <input
        ref={ref}
        className={clsx(box, 'w-full', size === 'sm' ? 'h-7 px-2 text-[13px]' : 'h-8 px-2.5 text-sm', prefix != null && 'pl-6', suffix != null && 'pr-10', invalid && 'border-loss/70')}
        {...rest}
      />
      {suffix && <span className="pointer-events-none absolute right-2.5 text-xs text-faint">{suffix}</span>}
    </div>
  );
});

export interface NumberInputProps extends Omit<InputProps, 'value' | 'onChange' | 'type' | 'step' | 'min' | 'max'> {
  value: number | null;
  onChange: (v: number | null) => void;
  step?: number;
  min?: number;
  max?: number;
  /** Decimals shown when the value is set from outside (defaults to the step's decimals). */
  precision?: number;
  /** Arrow keys / wheel adjust by step (default true). */
  stepper?: boolean;
}

function fmt(v: number | null, precision: number): string {
  return v == null || !Number.isFinite(v) ? '' : v.toFixed(precision);
}

/** Numeric text input that tolerates partial typing ("1.", "-") and steps with ↑/↓ (Shift ×10). */
export function NumberInput({ value, onChange, step = 1, min, max, precision, stepper = true, onBlur, onKeyDown, ...rest }: NumberInputProps) {
  const p = precision ?? decimalsOf(step);
  const [text, setText] = useState(() => fmt(value, p));
  useEffect(() => {
    const parsed = text.trim() === '' ? null : Number(text.replace(/,/g, ''));
    if (parsed !== value && !(parsed != null && value != null && Math.abs(parsed - value) < 1e-12)) setText(fmt(value, p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, p]);

  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const commit = (raw: string) => {
    const t = raw.replace(/,/g, '').trim();
    if (t === '') return onChange(null);
    const n = Number(t);
    if (Number.isFinite(n)) onChange(n);
  };

  return (
    <Input
      {...rest}
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        const t = e.target.value;
        if (/^-?[\d,]*\.?\d*$/.test(t)) {
          setText(t);
          commit(t);
        }
      }}
      onBlur={(e) => {
        if (value != null) {
          const c = clamp(value);
          if (c !== value) onChange(c);
          setText(fmt(c, p));
        }
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (stepper && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          const mult = e.shiftKey ? 10 : 1;
          const base = value ?? 0;
          const next = clamp(Number((base + (e.key === 'ArrowUp' ? step : -step) * mult).toFixed(p)));
          onChange(next);
          setText(fmt(next, p));
        }
        onKeyDown?.(e);
      }}
    />
  );
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={clsx(box, widthOf(className), 'min-h-20 resize-y px-2.5 py-2 text-sm leading-relaxed', className)} {...rest} />;
});

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string> extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange' | 'size'> {
  value: T;
  onChange: (v: T) => void;
  options: SelectOption<T>[];
  size?: 'sm' | 'md';
}

export function Select<T extends string>({ value, onChange, options, size = 'md', className, ...rest }: SelectProps<T>) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={clsx(box, widthOf(className), 'cursor-pointer appearance-none bg-[length:12px] bg-[right_8px_center] bg-no-repeat pr-7', size === 'sm' ? 'h-7 px-2 text-[13px]' : 'h-8 px-2.5 text-sm', className)}
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23a3a3a3' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }}
      {...rest}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled} className="bg-panel-2">
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Switch({ checked, onChange, disabled, label, className }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string; className?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-40', checked ? 'border-fg bg-fg' : 'border-line-strong bg-panel-3', className)}
    >
      <span className={clsx('inline-block size-3.5 rounded-full transition-transform', checked ? 'translate-x-[18px] bg-bg' : 'translate-x-0.5 bg-muted')} />
    </button>
  );
}

export function Checkbox({ checked, onChange, label, disabled, className }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; className?: string }) {
  return (
    <label className={clsx('inline-flex cursor-pointer select-none items-center gap-2 text-sm', disabled && 'pointer-events-none opacity-50', className)}>
      <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="flex size-4 items-center justify-center rounded border border-line-strong bg-panel-2 peer-checked:border-fg peer-checked:bg-fg peer-focus-visible:outline-2 peer-focus-visible:outline-fg/60">
        {checked && (
          <svg viewBox="0 0 16 16" className="size-3 text-bg" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="m3.5 8.5 3 3 6-7" />
          </svg>
        )}
      </span>
      {label}
    </label>
  );
}
