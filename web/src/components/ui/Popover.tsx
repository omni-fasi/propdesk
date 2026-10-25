import { useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';

export interface PopoverProps {
  /** The clickable trigger content (rendered inside a button). */
  trigger: ReactNode;
  triggerClassName?: string;
  /** Panel content; receives `close`. */
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
  side?: 'bottom' | 'top';
  className?: string;
  disabled?: boolean;
}

/** Click-to-open floating panel anchored to its trigger. Closes on outside click / Esc. */
export function Popover({ trigger, triggerClassName, children, align = 'start', side = 'bottom', className, disabled }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={root} className="relative">
      <button type="button" disabled={disabled} aria-expanded={open} onClick={() => setOpen((o) => !o)} className={triggerClassName}>
        {trigger}
      </button>
      {open && (
        <div
          className={clsx(
            'absolute z-50 min-w-48 animate-pop-in rounded-lg border border-line-strong bg-panel-2 p-1 shadow-pop',
            align === 'start' ? 'left-0' : 'right-0',
            side === 'bottom' ? 'top-full mt-1' : 'bottom-full mb-1',
            className,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ onClick, children, active, danger, disabled, className }: { onClick?: () => void; children: ReactNode; active?: boolean; danger?: boolean; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors disabled:opacity-40',
        danger ? 'text-loss hover:bg-loss/10' : 'text-fg hover:bg-panel-3',
        active && 'bg-panel-3',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Hover tooltip (pure CSS). Keep content short. */
export function Tooltip({ content, children, side = 'top', className }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right'; className?: string }) {
  return (
    <span className={clsx('group/tt relative inline-flex', className)}>
      {children}
      <span
        role="tooltip"
        className={clsx(
          'pointer-events-none absolute z-50 w-max max-w-72 rounded-md border border-line-strong bg-panel-3 px-2 py-1 text-xs text-fg opacity-0 shadow-pop transition-opacity delay-0 group-hover/tt:opacity-100 group-hover/tt:delay-300',
          side === 'top' && 'bottom-full left-1/2 mb-1.5 -translate-x-1/2',
          side === 'bottom' && 'left-1/2 top-full mt-1.5 -translate-x-1/2',
          side === 'left' && 'right-full top-1/2 mr-1.5 -translate-y-1/2',
          side === 'right' && 'left-full top-1/2 ml-1.5 -translate-y-1/2',
        )}
      >
        {content}
      </span>
    </span>
  );
}
