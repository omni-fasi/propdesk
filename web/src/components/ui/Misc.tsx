import type { HTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg className={clsx('animate-spin', className)} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={clsx('inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-panel-3 px-1 font-mono text-2xs text-muted', className)}>
      {children}
    </kbd>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded bg-panel-3', className)} />;
}

export function Divider({ vertical, className }: { vertical?: boolean; className?: string }) {
  return <div className={clsx(vertical ? 'w-px self-stretch bg-line' : 'h-px w-full bg-line', className)} />;
}

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}

export function EmptyState({ icon, title, description, action, className, compact }: EmptyStateProps) {
  return (
    <div className={clsx('flex flex-col items-center justify-center text-center', compact ? 'gap-1.5 py-6' : 'gap-2.5 py-14', className)}>
      {icon && <div className="mb-1 text-faint [&_svg]:size-7">{icon}</div>}
      <div className={clsx('font-medium text-fg', compact ? 'text-sm' : 'text-base')}>{title}</div>
      {description && <div className="max-w-sm text-sm text-muted">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export interface StatProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  align?: 'left' | 'right';
  size?: 'sm' | 'md' | 'lg';
}

/** Label over a number. Values should already be formatted (use <Money/> for money). */
export function Stat({ label, value, sub, align = 'left', size = 'md', className, ...rest }: StatProps) {
  return (
    <div className={clsx('flex min-w-0 flex-col', align === 'right' && 'items-end text-right', className)} {...rest}>
      <div className="truncate text-2xs font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className={clsx('tnum truncate font-semibold text-fg', size === 'sm' ? 'text-sm' : size === 'md' ? 'text-base' : 'text-2xl tracking-tight')}>{value}</div>
      {sub && <div className="tnum truncate text-xs text-muted">{sub}</div>}
    </div>
  );
}
