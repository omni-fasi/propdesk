import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';

export type MomentTone = 'loss' | 'profit' | 'warn';

const GLOW: Record<MomentTone, string> = {
  loss: 'radial-gradient(ellipse 75% 55% at 50% 38%, rgb(242 54 69 / 0.22), transparent 72%), radial-gradient(ellipse 120% 60% at 50% 120%, rgb(242 54 69 / 0.14), transparent 70%)',
  profit: 'radial-gradient(ellipse 70% 50% at 50% 0%, rgb(31 199 115 / 0.16), transparent 72%)',
  warn: 'radial-gradient(ellipse 70% 55% at 50% 32%, rgb(245 165 36 / 0.14), transparent 72%)',
};

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Full-screen "moment" (breach, pass, lock): tinted backdrop above everything else. While it is on screen
 * Escape belongs to it — `onEscape` undefined means it can't be dismissed with the keyboard yet.
 */
export function MomentShell({ tone, onEscape, labelledBy, pulse, children, underlay }: { tone: MomentTone; onEscape?: () => void; labelledBy?: string; pulse?: boolean; children: ReactNode; underlay?: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const escape = useRef(onEscape);
  escape.current = onEscape;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    root.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        escape.current?.();
        return;
      }
      if (e.key === 'Tab' && root.current) {
        // Keep keyboard focus inside the moment.
        const items = [...root.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (items.length === 0) {
          e.preventDefault();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || active === root.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        } else if (!root.current.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div
      ref={root}
      tabIndex={-1}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      className="fixed inset-0 z-[65] flex animate-fade-in overflow-y-auto bg-black/90 outline-none backdrop-blur-sm"
    >
      <div aria-hidden className={clsx('pointer-events-none fixed inset-0', pulse && 'animate-pulse-soft')} style={{ backgroundImage: GLOW[tone] }} />
      {underlay}
      <div className="relative m-auto w-full max-w-3xl animate-pop-in px-6 py-12">{children}</div>
    </div>,
    document.body,
  );
}

/** Small number block used across moments. */
export function MomentStat({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex min-w-0 flex-col gap-1 bg-panel/80 px-4 py-3', className)}>
      <div className="truncate text-2xs font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className="tnum truncate text-lg font-semibold text-fg">{children}</div>
    </div>
  );
}
