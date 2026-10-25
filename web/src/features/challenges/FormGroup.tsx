import type { ReactNode } from 'react';
import clsx from 'clsx';

/**
 * Like <Field>, but a <div>: use it around segmented controls and button groups — a <label> would forward
 * clicks on its text to the first button inside it.
 */
export function FormGroup({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex min-w-0 flex-col gap-1', className)}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {error ? <span className="text-xs text-loss">{error}</span> : hint ? <span className="text-xs text-faint">{hint}</span> : null}
    </div>
  );
}
