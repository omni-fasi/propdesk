import { useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Check } from 'lucide-react';
import { Input, NumberInput, type NumberInputProps } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Misc';
import { useSaveStatus } from './save';

/** A settings section: anchored panel with a title and description. */
export function SettingsSection({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section id={`settings-${id}`} className="scroll-mt-4 rounded-lg border border-line bg-panel">
      <header className="border-b border-line px-5 py-3.5">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      </header>
      <div className="divide-y divide-line px-5">{children}</div>
    </section>
  );
}

/** Label + hint on the left, control on the right. A <div> (not a <label>) so button groups behave. */
export function SettingRow({ title, hint, children, className, sub }: { title: ReactNode; hint?: ReactNode; children?: ReactNode; className?: string; sub?: ReactNode }) {
  return (
    <div className={clsx('py-3.5', className)}>
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <div className="text-sm text-fg">{title}</div>
          {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
        </div>
        {children != null && <div className="flex shrink-0 items-center gap-2">{children}</div>}
      </div>
      {sub && <div className="mt-3">{sub}</div>}
    </div>
  );
}

/** Number field that saves on blur / Enter. Empty → null when `nullable`, otherwise reverts. */
export function CommitNumber({
  value,
  onCommit,
  nullable,
  min,
  max,
  ...rest
}: Omit<NumberInputProps, 'value' | 'onChange'> & { value: number | null; onCommit: (v: number | null) => void; nullable?: boolean }) {
  const [draft, setDraft] = useState<number | null>(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    let v = draft;
    if (v == null) {
      if (!nullable) {
        setDraft(value);
        return;
      }
    } else {
      v = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
    }
    if (v !== value) onCommit(v);
  };
  return (
    <NumberInput
      {...rest}
      min={min}
      max={max}
      value={draft}
      onChange={setDraft}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(value);
      }}
    />
  );
}

/** Text field that saves on blur / Enter. */
export function CommitText({ value, onCommit, placeholder, maxLength, className }: { value: string; onCommit: (v: string) => void; placeholder?: string; maxLength?: number; className?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Input
      value={draft}
      placeholder={placeholder}
      maxLength={maxLength}
      className={className}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft.trim() !== value) onCommit(draft.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(value);
      }}
    />
  );
}

/** "Saving…" / "Saved" next to the page title. */
export function SaveIndicator() {
  const status = useSaveStatus((s) => s.status);
  if (status === 'idle') return null;
  return (
    <span className={clsx('flex items-center gap-1.5 text-xs', status === 'error' ? 'text-loss' : 'text-muted')} aria-live="polite">
      {status === 'saving' && (
        <>
          <Spinner size={12} /> Saving…
        </>
      )}
      {status === 'saved' && (
        <>
          <Check size={13} /> Saved
        </>
      )}
      {status === 'error' && 'Not saved'}
    </span>
  );
}
