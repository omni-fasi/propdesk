import type { HTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';

export interface PanelProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  /** Right side of the header. */
  actions?: ReactNode;
  /** Pad the body (default true). */
  padded?: boolean;
  /** Body scrolls; the panel fills its parent height. */
  scroll?: boolean;
  bodyClassName?: string;
}

/** Bordered surface. With `title` it gets a compact header row. */
export function Panel({ title, actions, padded = true, scroll, className, bodyClassName, children, ...rest }: PanelProps) {
  return (
    <section className={clsx('flex min-h-0 min-w-0 flex-col rounded-lg border border-line bg-panel', className)} {...rest}>
      {(title || actions) && (
        <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
          <div className="min-w-0 truncate text-xs font-semibold uppercase tracking-wider text-muted">{title}</div>
          {actions && <div className="flex items-center gap-1">{actions}</div>}
        </header>
      )}
      <div className={clsx('min-h-0 flex-1', padded && 'p-3', scroll && 'overflow-auto', bodyClassName)}>{children}</div>
    </section>
  );
}

/** Page wrapper: title row + scrollable content area. */
export function Page({ title, subtitle, actions, children, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-end justify-between gap-4 px-6 pb-4 pt-5">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight text-fg">{title}</h1>
          {subtitle && <div className="mt-0.5 text-sm text-muted">{subtitle}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div className={clsx('min-h-0 flex-1 overflow-auto px-6 pb-8', className)}>{children}</div>
    </div>
  );
}
